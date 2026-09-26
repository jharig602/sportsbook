/**
 * What goes where on the Board and the Bets page.
 *
 * The Board is for games you can still watch or bet: upcoming, or under way. A game is
 * under way from kickoff until its final score lands -- but never more than
 * `LIVE_HOURS` after kickoff, so a game whose result the collector missed does not sit
 * on the board for a fortnight looking live, which is what the unfiltered list did.
 *
 * The ledger reads top-down in the order you need it on a game day: tickets live now,
 * then open tickets by soonest kickoff, then everything settled -- won, then lost, then
 * pushes, newest first within each. A cash-out counts as won or lost by the money it made.
 */
import { recordResult, type Bet, type GradedRow } from "./settle";
import type { Game } from "./types";

/** Longest a game is treated as still on without a final score. Overtime included. */
export const LIVE_HOURS = 5;

function at(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : null;
}

/** Upcoming and live games only, soonest first. */
export function boardGames(games: Game[], finished: Set<string>, now: Date = new Date()): Game[] {
  const t = now.getTime();
  return games
    .filter((g) => {
      const kickoff = at(g.commenceTime);
      if (kickoff === null) return false;
      if (kickoff > t) return true;
      return !finished.has(g.eventId) && t - kickoff <= LIVE_HOURS * 3_600_000;
    })
    .sort((a, b) => (at(a.commenceTime) ?? 0) - (at(b.commenceTime) ?? 0));
}

export interface LedgerSections {
  live: GradedRow[];
  upcoming: GradedRow[];
  won: GradedRow[];
  lost: GradedRow[];
  /** Pushes, and cash-outs that came back exactly even. */
  other: GradedRow[];
}

/** The ledger split and ordered for reading. */
export function ledgerSections(
  rows: GradedRow[],
  legsByParlay: Map<string, Bet[]>,
  now: Date = new Date(),
): LedgerSections {
  const t = now.getTime();
  const legsOf = (row: GradedRow): Bet[] =>
    row.parlay_id ? legsByParlay.get(row.parlay_id) ?? [row] : [row];
  const kickoffs = (row: GradedRow) =>
    legsOf(row).map((b) => at(b.commence_time)).filter((k): k is number => k !== null);

  const out: LedgerSections = { live: [], upcoming: [], won: [], lost: [], other: [] };
  for (const row of rows) {
    // A cash-out files under won or lost by the money it made (`recordResult`).
    const result = recordResult(row);
    if (result === "won") out.won.push(row);
    else if (result === "lost") out.lost.push(row);
    else if (result === "push") out.other.push(row);
    else if (kickoffs(row).some((k) => k <= t)) out.live.push(row);
    else out.upcoming.push(row);
  }

  // Live and upcoming: soonest first -- for a parlay, its next leg still to start.
  const next = (row: GradedRow) => {
    const ks = kickoffs(row);
    const ahead = ks.filter((k) => k > t);
    return ahead.length ? Math.min(...ahead) : ks.length ? Math.min(...ks) : Infinity;
  };
  // Settled: newest game first.
  const latest = (row: GradedRow) => {
    const ks = kickoffs(row);
    return ks.length ? Math.max(...ks) : 0;
  };
  out.live.sort((a, b) => Math.min(...kickoffs(a)) - Math.min(...kickoffs(b)));
  out.upcoming.sort((a, b) => next(a) - next(b));
  for (const list of [out.won, out.lost, out.other]) list.sort((a, b) => latest(b) - latest(a));
  return out;
}
