/**
 * Everyone's chance to win the pool, from the pool's own sheet.
 *
 * Each rival history group is played the way the field model already assumes rivals
 * play: their pick this week when the sheet shows it, then the best team they have left,
 * week after week. That line is scored with the same last-one-standing arithmetic as
 * your own plan, against the same simulated seasons, so the numbers are comparable down
 * the column and, with your own planned entry added, should come close to summing to
 * 100% -- the page shows the sum, so a model that has drifted says so.
 *
 * It is the chance each entry has IF it keeps picking that way. A rival who plans better
 * than "best team left" will do better than their row, which is the honest caveat and
 * the reason your own row (planned, not greedy) is usually higher than its raw position
 * would suggest.
 *
 * Anonymous by construction: a row is a history (teams used, losses), never a name --
 * names would have to travel through public workflow logs to get here.
 */
import { lastStandingWin, prepareField } from "./last-standing";
import { aliveCurve } from "./pool-odds";
import { fieldFromRivals, poolCrowding, type Field, type PoolEntry } from "./pool-win";
import { fieldState } from "./pools";
import { buildPlan, type Candidate, type Week } from "./survivor";

/** Seasons for this table: a ranking of entries, not a headline number. */
const FIELD_SEASONS = 4000;

export interface FieldRow {
  you: boolean;
  /** Entries sharing this exact history. */
  n: number;
  used: string[];
  losses: number;
  /** Their pick this week, when known. */
  pick: string | null;
  /** The line they are assumed to play, week by week. */
  teams: (string | null)[];
  /** Chance each one of them wins the pool. */
  win: number;
  /** Chance each survives every remaining week. */
  survival: number;
}

export function fieldOdds(
  weeks: Week[],
  pool: PoolEntry,
  options: {
    crowding: number;
    crowdingMeasured: boolean;
    /** Your own entry's planned line and its value, from the plan above it. */
    you: { teams: (string | null)[]; mine: number[]; poolWin: number; survival: number };
  },
): { rows: FieldRow[]; total: number; unknownLosses: number } {
  const planning = weeks.filter((w) => w.candidates.length > 0);
  if (planning.length === 0) return { rows: [], total: 0, unknownLosses: 0 };
  const lossesAllowed = pool.lossesAllowed ?? 0;
  const state = fieldState(pool);
  const poolSize = state.rivals + 1;
  const crowding = poolCrowding(pool, options.crowding, options.crowdingMeasured);
  const reference = buildPlan(planning);
  const sheet = pool.rivals && pool.rivals.week <= planning[0].week ? pool.rivals : null;
  const fromSheet = sheet
    ? fieldFromRivals(planning, sheet, poolSize - 1, crowding, reference.greedyPicks[0]?.team ?? null)
    : null;
  const crowdPicks = fromSheet?.crowdPicks ?? reference.greedyPicks;
  const field: Field = fromSheet?.field ?? {
    probabilities: crowdPicks.map((c) => c?.winProbability ?? 1),
    crowding,
  };
  const prepared = prepareField(field, planning.length, lossesAllowed, FIELD_SEASONS, state.rivalLosses);

  const live = sheet && sheet.week === planning[0].week;
  const score = (teams: (string | null)[], mine: number[], losses: number) => {
    const shared = teams.map((t, i) => t !== null && t === (crowdPicks[i]?.team ?? null));
    const lives = lossesAllowed - losses;
    const curve = lives >= 0 ? aliveCurve(mine, lives) : mine.map(() => 0);
    return {
      win: lastStandingWin({ mine, shared, teams }, prepared, poolSize, losses),
      survival: curve.length ? curve[curve.length - 1] : 0,
    };
  };

  const rows: FieldRow[] = [];
  let unknownLosses = 0;
  for (const g of sheet?.groups ?? []) {
    if (g.losses === undefined) unknownLosses += g.n;
    const losses = g.losses ?? 0;
    const spent = new Set(g.used);
    const line: (Candidate | null)[] = planning.map((week, i) => {
      const pick =
        i === 0 && live && g.pick ? week.candidates.find((c) => c.team === g.pick) ?? null : null;
      const choice =
        pick ??
        [...week.candidates]
          .sort((a, b) => b.winProbability - a.winProbability)
          .find((c) => !spent.has(c.team)) ??
        null;
      if (choice) spent.add(choice.team);
      return choice;
    });
    const teams = line.map((c) => c?.team ?? null);
    const mine = line.map((c) => c?.winProbability ?? 1);
    rows.push({
      you: false,
      n: g.n,
      used: g.used,
      losses,
      pick: live ? g.pick ?? null : null,
      teams,
      ...score(teams, mine, losses),
    });
  }

  rows.push({
    you: true,
    n: 1,
    used: pool.used,
    losses: pool.myLosses ?? 0,
    pick: options.you.teams[0] ?? null,
    teams: options.you.teams,
    win: options.you.poolWin,
    survival: options.you.survival,
  });

  rows.sort((a, b) => b.win - a.win);
  const total = rows.reduce((sum, r) => sum + r.n * r.win, 0);
  return { rows, total, unknownLosses };
}
