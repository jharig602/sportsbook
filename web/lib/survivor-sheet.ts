/**
 * The weekly survivor sheet, turned into what the planner needs.
 *
 * The owner's pool circulates a spreadsheet: one row per entrant, one column per week,
 * the team each picked written however the commissioner writes it ("Minn", "Da Bears",
 * "NYJets"). This reads those rows -- without names, which never reach Dissent -- and
 * works out the rest from the final scores Dissent already holds:
 *
 * - each row's losses: a pick whose game is final and was lost (or tied: the pool's rule
 *   is "2 losses/ties out") counts one; a pick whose game is not final yet counts none;
 * - the field: everyone still alive, bucketed by losses taken;
 * - each entry's spent teams, and every rival's history for the field model;
 * - how much the pool herds, added to the prior from the owner's old pools.
 *
 * It replaces the hand-run `set-pool-field` workflow for this pool, so the update can be
 * made from a phone through the Claude connector (`update_survivor_sheet`).
 */
import aliases from "../config/kalshi-aliases.json";

/**
 * How much the field herds before this pool's own weeks say anything: 45% of the old
 * pools' picks went to the most popular team, weighted as about two weeks of evidence.
 * The pool's own counts are added on top, so the prior fades as its weeks accumulate.
 */
export const CROWD_PRIOR = { top: 20, picks: 44 };

const NFL: string[] = Object.values((aliases as { nfl: Record<string, string> }).nfl);
const CODES: Record<string, string> = Object.fromEntries(
  Object.entries((aliases as { nfl: Record<string, string> }).nfl).map(([code, name]) => [code.toLowerCase(), name]),
);

/** Spellings the sheets use that no rule below would find. */
const SPELLINGS: Record<string, string> = {
  dabears: "Chicago Bears",
  bears: "Chicago Bears",
  philly: "Philadelphia Eagles",
  indy: "Indianapolis Colts",
  jax: "Jacksonville Jaguars",
  jags: "Jacksonville Jaguars",
  nyjets: "New York Jets",
  nygiants: "New York Giants",
  larams: "Los Angeles Rams",
  lachargers: "Los Angeles Chargers",
  vegas: "Las Vegas Raiders",
  niners: "San Francisco 49ers",
  bucs: "Tampa Bay Buccaneers",
  pats: "New England Patriots",
  wsh: "Washington Commanders",
  cincy: "Cincinnati Bengals",
  pitt: "Pittsburgh Steelers",
};

const key = (text: string) => text.toLowerCase().replace(/[^a-z0-9]/g, "");

/** An NFL team as ESPN names it, from however the sheet wrote it; null when unclear. */
export function teamFromSheet(text: string): string | null {
  const k = key(text);
  if (!k) return null;
  if (SPELLINGS[k]) return SPELLINGS[k];
  if (CODES[k]) return CODES[k];
  const hits = NFL.filter((name) => {
    const words = name.split(" ");
    const full = key(name);
    const nickname = key(words[words.length - 1]);
    const city = key(words.slice(0, -1).join(" "));
    return (
      k === full ||
      k === nickname ||
      k === city ||
      (k.length >= 4 && (city.startsWith(k) || full.startsWith(k)))
    );
  });
  return hits.length === 1 ? hits[0] : null;
}

/** A final NFL score, with the season week it was played in. */
export interface FinalGame {
  week: number;
  home: string;
  away: string;
  homeScore: number;
  awayScore: number;
}

export interface SheetRowInput {
  /** Week number -> the team as written on the sheet. */
  picks: Record<string, string>;
  /** Which stored entry this row is ("me", "ma"), when it is one of the owner's. */
  who?: string;
  /** Losses as the sheet states them, when it states them; otherwise worked out. */
  losses?: number;
}

export interface SheetRow {
  who: string | null;
  picks: Map<number, string>;
  losses: number;
  /** Picks whose game is not final yet. */
  pending: number;
  alive: boolean;
}

export interface Sheet {
  rows: SheetRow[];
  /** The latest week anyone has a pick in. */
  week: number;
  /** Alive entrants by losses taken, everyone included. */
  field: number[];
  /** This pool's own herding: the top team's count summed over its weeks, over all picks. */
  own: { top: number; picks: number };
  /** Per week: the most-picked team and its share. */
  weeks: Array<{ week: number; team: string; count: number; picks: number }>;
  /** Spellings that could not be read as a team, with where they were. */
  unreadable: string[];
}

export function readSheet(input: SheetRowInput[], finals: FinalGame[], lossesAllowed: number): Sheet {
  const unreadable: string[] = [];
  const rows: SheetRow[] = input.map((row, i) => {
    const picks = new Map<number, string>();
    for (const [w, text] of Object.entries(row.picks ?? {})) {
      const week = Number(String(w).replace(/[^0-9]/g, ""));
      if (!text || !String(text).trim()) continue;
      const team = teamFromSheet(String(text));
      if (!(week >= 1 && week <= 22)) unreadable.push(`row ${i + 1}: week "${w}"`);
      else if (!team) unreadable.push(`row ${i + 1}, week ${week}: "${text}"`);
      else picks.set(week, team);
    }
    let lost = 0;
    let pending = 0;
    for (const [week, team] of picks) {
      const game = finals.find((g) => g.week === week && (g.home === team || g.away === team));
      if (!game) {
        pending += 1;
        continue;
      }
      const mine = game.home === team ? game.homeScore : game.awayScore;
      const theirs = game.home === team ? game.awayScore : game.homeScore;
      if (mine <= theirs) lost += 1; // a tie counts as a loss in this pool
    }
    const losses = typeof row.losses === "number" && row.losses >= 0 ? Math.floor(row.losses) : lost;
    return {
      who: row.who ? key(row.who) : null,
      picks,
      losses,
      pending,
      alive: losses <= lossesAllowed,
    };
  });

  const week = Math.max(0, ...rows.flatMap((r) => [...r.picks.keys()]));
  const field = new Array(lossesAllowed + 1).fill(0);
  for (const r of rows) if (r.alive) field[r.losses] += 1;

  const weeks: Sheet["weeks"] = [];
  const own = { top: 0, picks: 0 };
  const allWeeks = [...new Set(rows.flatMap((r) => [...r.picks.keys()]))].sort((a, b) => a - b);
  for (const w of allWeeks) {
    const counts = new Map<string, number>();
    for (const r of rows) {
      const team = r.picks.get(w);
      if (team) counts.set(team, (counts.get(team) ?? 0) + 1);
    }
    const [team, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    const picks = [...counts.values()].reduce((a, b) => a + b, 0);
    weeks.push({ week: w, team, count, picks });
    own.top += count;
    own.picks += picks;
  }
  return { rows, week, field, own, weeks, unreadable };
}

/** What one stored entry becomes: its own state plus every other live row as a rival. */
export function entryUpdate(sheet: Sheet, who: string) {
  const me = sheet.rows.find((r) => r.who === key(who));
  if (!me) return null;
  const groups = new Map<string, { used: string[]; pick?: string; n: number; losses: number }>();
  for (const r of sheet.rows) {
    if (r === me || !r.alive) continue;
    const used = [...r.picks.entries()].filter(([w]) => w < sheet.week).map(([, t]) => t).sort();
    const pick = r.picks.get(sheet.week);
    const id = JSON.stringify([used, pick ?? null, r.losses]);
    const group = groups.get(id);
    if (group) group.n += 1;
    else groups.set(id, { used, ...(pick ? { pick } : {}), n: 1, losses: r.losses });
  }
  return {
    used: [...new Set(me.picks.values())],
    myLosses: me.losses,
    field: sheet.field,
    entered: sheet.rows.length,
    crowd: { top: CROWD_PRIOR.top + sheet.own.top, picks: CROWD_PRIOR.picks + sheet.own.picks },
    rivals: { week: sheet.week, groups: [...groups.values()] },
  };
}
