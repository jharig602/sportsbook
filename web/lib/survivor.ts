import { winProbabilityFromSpread, type MarginModel } from "./probability";

/**
 * Survivor pool planning: one team a week, each team only once all season.
 *
 * The trap this exists to avoid is picking greedily. Taking the biggest favourite
 * every week spends your best teams in September against opponents you would have
 * beaten with anyone, and leaves December with nothing but teams you have already
 * used. The question is not "who is safest this week" but "which week is each team
 * worth spending in", and that is an assignment problem, not a ranking.
 *
 * So this maximises the probability of surviving the WHOLE season — the product of the
 * chosen weeks' win probabilities — subject to using each team at most once. Maximising
 * a product of probabilities is maximising the sum of their logarithms, which makes it
 * a linear assignment problem, solved exactly here rather than approximated.
 *
 * Two honest limits, stated because they bound how much the plan is worth:
 *
 * 1. Weeks beyond the next one are priced off early lines that will move, often by
 *    multiple points. The plan is a way of deciding *this* week's pick with the rest of
 *    the season in view, not a commitment to weeks 5 through 18.
 * 2. It assumes you survive. A real pool ends the moment you lose, so the later weeks
 *    only matter conditional on getting there — which is exactly what the product
 *    already encodes, but it means the early weeks deserve more weight than the
 *    arithmetic alone suggests.
 */

export interface SeasonGame {
  feedEventId: string;
  commenceTime: string;
  homeTeam: string;
  awayTeam: string;
  /** Median spread across books, negative when the home side is favoured. */
  homeSpread: number | null;
  books: number;
}

export interface Candidate {
  team: string;
  opponent: string;
  /** True when `team` is at home. */
  home: boolean;
  winProbability: number;
  spread: number;
  commenceTime: string;
  eventId: string;
}

export interface Week {
  week: number;
  startsAt: string;
  candidates: Candidate[];
}

const ET = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  weekday: "short",
});

/**
 * The Tuesday on or before a kickoff, in US Eastern time, as a YYYY-MM-DD label.
 *
 * Eastern rather than UTC because the NFL schedule is defined in it: a Monday night
 * game kicks off at 8:15pm ET, which is already Tuesday 00:15 UTC, and a UTC rule
 * would file it under the following week. Via `Intl` rather than a fixed offset so the
 * November switch out of daylight time does not shift a week boundary by an hour.
 */
export function weekAnchor(commenceTime: string): string {
  const parts = ET.formatToParts(new Date(commenceTime));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const index = weekdays.indexOf(get("weekday"));
  // Tuesday is index 2; count back to the most recent Tuesday.
  const back = (index - 2 + 7) % 7;
  const anchor = new Date(`${day}T12:00:00Z`);
  anchor.setUTCDate(anchor.getUTCDate() - back);
  return anchor.toISOString().slice(0, 10);
}

/**
 * Group fixtures into NFL weeks.
 *
 * A first attempt clustered on the gap between kickoffs, on the theory that the league
 * plays Thursday, Sunday and Monday then pauses. It does not survive the real
 * schedule: Thursday night to Sunday afternoon is about 65 hours and Monday night to
 * the next Thursday night is about 72, so no gap threshold separates "later the same
 * week" from "the following week" reliably. Some weeks would have merged, others split,
 * and a survivor plan built on mis-numbered weeks is wrong in a way that looks fine.
 *
 * The calendar rule is unambiguous: an NFL week runs Tuesday through Monday, Eastern.
 */
export function groupIntoWeeks(games: SeasonGame[]): SeasonGame[][] {
  const sorted = [...games].sort(
    (a, b) => new Date(a.commenceTime).getTime() - new Date(b.commenceTime).getTime(),
  );
  const byAnchor = new Map<string, SeasonGame[]>();
  for (const game of sorted) {
    const key = weekAnchor(game.commenceTime);
    const bucket = byAnchor.get(key);
    if (bucket) bucket.push(game);
    else byAnchor.set(key, [game]);
  }
  return [...byAnchor.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([, block]) => block);
}

/** Both sides of every priced game in a week, as pickable candidates. */
export function candidatesFor(
  games: SeasonGame[],
  model: MarginModel | null,
): Candidate[] {
  const out: Candidate[] = [];
  for (const game of games) {
    // An unpriced game is not a pick with unknown odds, it is not a pick at all.
    // Guessing a probability here would put a team in the plan on no evidence.
    if (game.homeSpread === null || model === null) continue;

    const home = winProbabilityFromSpread(model, game.homeSpread, "home");
    if (home === null) continue;

    out.push({
      team: game.homeTeam, opponent: game.awayTeam, home: true,
      winProbability: home, spread: game.homeSpread,
      commenceTime: game.commenceTime, eventId: game.feedEventId,
    });
    out.push({
      team: game.awayTeam, opponent: game.homeTeam, home: false,
      winProbability: 1 - home, spread: -game.homeSpread,
      commenceTime: game.commenceTime, eventId: game.feedEventId,
    });
  }
  return out.sort((a, b) => b.winProbability - a.winProbability);
}

export function buildWeeks(games: SeasonGame[], model: MarginModel | null): Week[] {
  return groupIntoWeeks(games).map((block, index) => ({
    week: index + 1,
    startsAt: block[0]?.commenceTime ?? "",
    candidates: candidatesFor(block, model),
  }));
}

/**
 * Rectangular linear assignment, minimising total cost.
 *
 * The Jonker-Volgenant shortest-augmenting-path method. Rows are weeks, columns are
 * teams, and there are always more teams than weeks, so every week gets exactly one
 * team and most teams go unused. Returns the column chosen for each row.
 *
 * Written out rather than pulled from a package because it is forty lines, the
 * alternative is a dependency in a bundle that ships to a phone, and a greedy
 * approximation here would silently give up the one thing the exact answer buys:
 * saving a strong team for the week that actually needs it.
 */
export function assign(cost: number[][]): number[] {
  const rows = cost.length;
  if (rows === 0) return [];
  const cols = cost[0].length;
  if (cols < rows) throw new Error("assignment needs at least as many columns as rows");

  const INF = Infinity;
  // Potentials, plus a virtual row 0 in the classic formulation.
  const u = new Array(rows + 1).fill(0);
  const v = new Array(cols + 1).fill(0);
  const p = new Array(cols + 1).fill(0); // column -> row
  const way = new Array(cols + 1).fill(0);

  for (let i = 1; i <= rows; i += 1) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(cols + 1).fill(INF);
    const used = new Array(cols + 1).fill(false);

    do {
      used[j0] = true;
      const i0 = p[j0];
      let delta = INF;
      let j1 = 0;

      for (let j = 1; j <= cols; j += 1) {
        if (used[j]) continue;
        const cur = cost[i0 - 1][j - 1] - u[i0] - v[j];
        if (cur < minv[j]) {
          minv[j] = cur;
          way[j] = j0;
        }
        if (minv[j] < delta) {
          delta = minv[j];
          j1 = j;
        }
      }

      for (let j = 0; j <= cols; j += 1) {
        if (used[j]) {
          u[p[j]] += delta;
          v[j] -= delta;
        } else {
          minv[j] -= delta;
        }
      }
      j0 = j1;
    } while (p[j0] !== 0);

    do {
      const j1 = way[j0];
      p[j0] = p[j1];
      j0 = j1;
    } while (j0);
  }

  const answer = new Array(rows).fill(-1);
  for (let j = 1; j <= cols; j += 1) {
    if (p[j] > 0) answer[p[j] - 1] = j - 1;
  }
  return answer;
}

export interface Pick {
  week: number;
  startsAt: string;
  pick: Candidate | null;
  /** The best pick available if this week were considered alone. */
  greedy: Candidate | null;
  /** How much probability was given up this week to save a team for later. */
  sacrifice: number;
}

export interface Plan {
  picks: Pick[];
  /** Probability of surviving every planned week. */
  survival: number;
  /** What picking the biggest favourite each week would have given. */
  greedySurvival: number;
  weeksPlanned: number;
  unplannedWeeks: number;
}

/** A team is worth nothing in a week it does not play, or is not priced in. */
const UNAVAILABLE = 1e6;

/**
 * The season-long plan.
 *
 * `horizon` bounds how far ahead to plan. Beyond about six weeks the lines are early
 * enough that the plan is mostly telling you about the schedule rather than the teams,
 * and every extra week makes the current pick look more constrained than it is.
 */
export function buildPlan(weeks: Week[], horizon = weeks.length): Plan {
  const planning = weeks.slice(0, horizon).filter((w) => w.candidates.length > 0);
  if (planning.length === 0) {
    return { picks: [], survival: 0, greedySurvival: 0, weeksPlanned: 0, unplannedWeeks: 0 };
  }

  const teams = [...new Set(planning.flatMap((w) => w.candidates.map((c) => c.team)))].sort();
  const byWeekTeam = planning.map((week) => {
    const map = new Map<string, Candidate>();
    for (const candidate of week.candidates) {
      // A team can appear once per week; keep the entry, whichever it is.
      if (!map.has(candidate.team)) map.set(candidate.team, candidate);
    }
    return map;
  });

  // Minimise the sum of negative log probabilities, which maximises their product.
  const cost = byWeekTeam.map((map) =>
    teams.map((team) => {
      const candidate = map.get(team);
      if (!candidate) return UNAVAILABLE;
      const p = Math.min(0.999, Math.max(0.001, candidate.winProbability));
      return -Math.log(p);
    }),
  );

  const chosen = teams.length >= planning.length ? assign(cost) : [];

  const picks: Pick[] = planning.map((week, index) => {
    const column = chosen[index];
    const candidate =
      column !== undefined && column >= 0 && cost[index][column] < UNAVAILABLE
        ? (byWeekTeam[index].get(teams[column]) ?? null)
        : null;
    const greedy = week.candidates[0] ?? null;
    return {
      week: week.week,
      startsAt: week.startsAt,
      pick: candidate,
      greedy,
      sacrifice:
        candidate && greedy ? greedy.winProbability - candidate.winProbability : 0,
    };
  });

  const survival = picks.reduce(
    (acc, p) => acc * (p.pick ? p.pick.winProbability : 1),
    1,
  );

  // The greedy baseline the plan has to beat: take the biggest favourite each week,
  // skipping teams already spent. This is what most people actually do.
  const spent = new Set<string>();
  let greedySurvival = 1;
  for (const week of planning) {
    const next = week.candidates.find((c) => !spent.has(c.team));
    if (next) {
      spent.add(next.team);
      greedySurvival *= next.winProbability;
    }
  }

  return {
    picks,
    survival,
    greedySurvival,
    weeksPlanned: planning.length,
    unplannedWeeks: weeks.length - planning.length,
  };
}
