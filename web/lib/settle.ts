/**
 * Settling a wager against a final score.
 *
 * Derived, never stored. A bet row records what was placed; the outcome is recomputed
 * from `game_results` on every read. That means a corrected score corrects the P&L by
 * itself, and there is no stored verdict that can drift out of step with the score it
 * came from.
 *
 * Mirrors collector/grading.py so the two cannot disagree about what a push is.
 */
import type { Market, Side } from "./types";

export interface Bet {
  bet_id: string;
  placed_at: string;
  league: string;
  event_id: string;
  home_team: string | null;
  away_team: string | null;
  commence_time: string | null;
  market: Market;
  side: Side;
  line: number | null;
  price: number;
  stake: number;
  book: string;
  model_probability: number | null;
  market_probability: number | null;
  rule_version_id: string | null;
  note: string | null;
  /**
   * A promotional bet, where the stake is the book's and only the winnings are yours.
   *
   * Settles differently in one direction that matters: a losing bonus bet costs
   * nothing, because the stake was never yours to lose. Recording one as an ordinary
   * wager books a $50 loss against a bet that cost $0, which understates the ledger by
   * the full face value every time one loses -- and they lose most of the time, since
   * the whole point of a bonus bet is to take long odds.
   */
  bonus?: boolean;
}

export interface Score {
  home_score: number;
  away_score: number;
}

export type Outcome = "won" | "lost" | "push" | "open";

export interface Settlement {
  outcome: Outcome;
  /** Net profit: positive on a win, negative on a loss, zero on a push or while open. */
  profit: number;
  /** Total returned including stake. Zero on a loss. */
  returned: number;
}

export function decimalOdds(price: number): number | null {
  if (Math.abs(price) < 100) return null;
  return price > 0 ? 1 + price / 100 : 1 + 100 / -price;
}

/** True/false/null(push) for the bet's own side. */
export function didWin(bet: Bet, score: Score): boolean | null {
  const margin = score.home_score - score.away_score;
  const total = score.home_score + score.away_score;

  if (bet.market === "moneyline") {
    if (margin === 0) return null; // an NFL tie pushes the moneyline
    return (margin > 0) === (bet.side === "home");
  }

  if (bet.line === null) return null;

  if (bet.market === "spread") {
    // The line is quoted for the side that was bet.
    const own = bet.side === "home" ? margin : -margin;
    const adjusted = own + bet.line;
    if (adjusted === 0) return null;
    return adjusted > 0;
  }

  if (bet.market === "total") {
    if (total === bet.line) return null;
    return bet.side === "over" ? total > bet.line : total < bet.line;
  }

  return null;
}

export function settle(bet: Bet, score: Score | undefined): Settlement {
  if (!score) return { outcome: "open", profit: 0, returned: 0 };

  const won = didWin(bet, score);
  if (won === null) {
    // A push returns the stake and wins nothing. Counting it as a loss would quietly
    // understate every strategy that lands on key numbers. A pushed bonus bet is
    // typically re-credited rather than paid, so nothing is returned in cash.
    return { outcome: "push", profit: 0, returned: bet.bonus ? 0 : bet.stake };
  }

  const decimal = decimalOdds(bet.price);
  if (decimal === null) return { outcome: "open", profit: 0, returned: 0 };

  if (won) {
    const profit = bet.stake * (decimal - 1);
    // A bonus bet pays the winnings and keeps the stake, so the profit is identical
    // and only the cash returned differs.
    return { outcome: "won", profit, returned: bet.bonus ? profit : bet.stake + profit };
  }
  // Nothing was risked, so nothing was lost.
  return { outcome: "lost", profit: bet.bonus ? 0 : -bet.stake, returned: 0 };
}

export interface Tally {
  placed: number;
  settled: number;
  won: number;
  lost: number;
  push: number;
  open: number;
  staked: number;
  /**
   * Staked on settled bets only, EXCLUDING bonus bets; the denominator ROI is
   * measured against.
   *
   * A bonus bet risks nothing of yours, so putting its face value in the denominator
   * measures a return against money that was never at stake. Its winnings are real and
   * counted in profit; the $50 that produced them is not yours and is not counted.
   */
  stakedSettled: number;
  profit: number;
  /** Profit from bonus bets alone, so it can be shown apart from what you risked. */
  bonusProfit: number;
  /** Null until something you actually risked has settled. */
  roi: number | null;
}

export function tally(
  bets: Bet[],
  scores: Map<string, Score>,
): { rows: Array<Bet & Settlement>; totals: Tally } {
  const rows = bets.map((bet) => ({ ...bet, ...settle(bet, scores.get(bet.event_id)) }));

  const settled = rows.filter((r) => r.outcome !== "open");
  // Only your own money belongs in the denominator.
  const stakedSettled = settled
    .filter((r) => !r.bonus)
    .reduce((sum, r) => sum + r.stake, 0);
  const profit = rows.reduce((sum, r) => sum + r.profit, 0);
  const bonusProfit = rows.filter((r) => r.bonus).reduce((sum, r) => sum + r.profit, 0);

  return {
    rows,
    totals: {
      placed: rows.length,
      settled: settled.length,
      won: rows.filter((r) => r.outcome === "won").length,
      lost: rows.filter((r) => r.outcome === "lost").length,
      push: rows.filter((r) => r.outcome === "push").length,
      open: rows.filter((r) => r.outcome === "open").length,
      staked: rows.reduce((sum, r) => sum + r.stake, 0),
      stakedSettled,
      profit,
      bonusProfit,
      // Measured against your own money only: a bonus bet's winnings are real, but
      // dividing them by a stake you never risked is not a return on anything.
      roi: stakedSettled > 0 ? (profit - bonusProfit) / stakedSettled : null,
    },
  };
}
