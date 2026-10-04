/**
 * Hedges: bets on opposite sides of one game, counted as the single position they are.
 *
 * Taking the Bills and then the Patriots in the same game -- a boost on each side, or
 * one bet to lock in another -- is one position with one net result. Graded bet by bet
 * it reads as a win and a loss, which is true of the tickets and false of the decision:
 * a guaranteed +$6 showed up in the record as 1-1. So opposed bets on one game are
 * found automatically and counted once, as won, lost or pushed by the NET money.
 *
 * Opposed means: home against away in the spread or moneyline (in any mix -- a spread on
 * one side and a moneyline on the other is still both sides of the game), or over
 * against under on the same total. Two bets that merely share a game -- a spread and an
 * over -- are not a hedge and stay separate. Parlays are left alone: a parlay leg is not
 * a position on its own.
 *
 * Detected, not declared, so there is nothing to tap and nothing to forget; the money
 * was never in question, only how many results it counts as.
 */
import { decimalOdds, type Bet, type GradedRow } from "./settle";

export interface Hedge {
  /** Stable id: `hedge:` and the game. */
  id: string;
  eventId: string;
  legs: GradedRow[];
  /** Open until every leg is settled; then by the net money. */
  outcome: "won" | "lost" | "push" | "open";
  profit: number;
  stake: number;
}

const SIDED = new Set(["spread", "moneyline"]);

/** True when the two bets take opposite sides of the same game. */
export function opposed(a: Bet, b: Bet): boolean {
  if (a.event_id !== b.event_id || a.side === b.side) return false;
  if (SIDED.has(a.market) && SIDED.has(b.market)) return true;
  // Over against under, or odd against even -- never an over against an odd, which
  // can both win.
  const pair = (x: string) => (x === "over" || x === "under" ? "ou" : x === "odd" || x === "even" ? "oe" : x);
  return (
    a.market === "total" && b.market === "total" &&
    (a.team ?? null) === (b.team ?? null) && pair(a.side) === pair(b.side)
  );
}

/** Every hedge in a ledger's graded rows: groups of 2+ opposed single bets on one game. */
export function findHedges(rows: GradedRow[]): Hedge[] {
  const byGame = new Map<string, GradedRow[]>();
  for (const row of rows) {
    if (row.parlay_id) continue;
    byGame.set(row.event_id, [...(byGame.get(row.event_id) ?? []), row]);
  }
  const out: Hedge[] = [];
  for (const [eventId, bets] of byGame) {
    if (bets.length < 2) continue;
    // Connected by "opposed": a bet joins the hedge if it opposes any bet already in it.
    const inHedge = new Set<number>();
    for (let i = 0; i < bets.length; i += 1) {
      for (let j = i + 1; j < bets.length; j += 1) {
        if (opposed(bets[i], bets[j])) {
          inHedge.add(i);
          inHedge.add(j);
        }
      }
    }
    if (inHedge.size < 2) continue;
    const legs = bets.filter((_, i) => inHedge.has(i));
    const open = legs.some((leg) => leg.outcome === "open");
    const profit = legs.reduce((sum, leg) => sum + leg.profit, 0);
    out.push({
      id: `hedge:${eventId}`,
      eventId,
      legs,
      outcome: open ? "open" : profit > 0.005 ? "won" : profit < -0.005 ? "lost" : "push",
      profit,
      stake: legs.reduce((sum, leg) => sum + leg.stake, 0),
    });
  }
  return out;
}

/**
 * The most an open hedge can make: the best single leg winning while the rest lose.
 *
 * Adding every leg's winnings, as "if all win" does for separate tickets, counts both
 * sides of one game winning -- which, outside a middle, cannot happen. A middle (both
 * covering, e.g. Bills -3 and Patriots +7 with a 5-point margin) is left out: it is the
 * rare upside, not the planning number.
 */
export function hedgeBestCase(legs: Bet[]): number {
  const profitOf = (leg: Bet) => {
    const d = decimalOdds(leg.price);
    return d === null ? 0 : leg.stake * (d - 1);
  };
  const lossOf = (leg: Bet) => (leg.bonus ? 0 : leg.stake);
  let best = -Infinity;
  for (const winner of legs) {
    const others = legs.filter((l) => l !== winner).reduce((sum, l) => sum + lossOf(l), 0);
    best = Math.max(best, profitOf(winner) - others);
  }
  return Number.isFinite(best) ? best : 0;
}
