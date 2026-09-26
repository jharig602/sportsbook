/**
 * Settling a wager against a final score.
 *
 * Derived, never stored. A bet row records what was placed; the outcome is recomputed
 * from `game_results` on every read. That means a corrected score corrects the P&L by
 * itself, and there is no stored verdict that can drift out of step with the score it
 * came from.
 *
 * The single exception is a cash-out, which is stored. See `Bet.cashout`.
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
  /**
   * Whose points a `total` row is about. Null is the game's total.
   *
   * A team total is not a separate market here: it is a line on points scored, asked of
   * one side rather than both, and it grades off the same score. Only which numbers get
   * added changes. Set on nothing written before team totals existed, which is correct
   * -- those were all game totals.
   */
  team?: "home" | "away" | null;
  line: number | null;
  price: number;
  stake: number;
  book: string;
  model_probability: number | null;
  market_probability: number | null;
  rule_version_id: string | null;
  note: string | null;
  /**
   * The bet_id this row corrects, when it is a correction.
   *
   * Nothing in this table is ever updated — the verdict is derived from `game_results`
   * at read time so it cannot drift from the score — which left no way to fix a row
   * entered wrongly. A correction is therefore a new row pointing at the old one, and
   * both are kept: what was first written is part of the history even when it was
   * wrong, and a ledger you can quietly edit is not a ledger.
   */
  supersedes: string | null;
  /**
   * A correction that removes the bet it supersedes rather than replacing it.
   *
   * For a row that should never have been there: a mis-entry, a bet you decided not to
   * place, a duplicate. Still an append-only tombstone rather than a DELETE, because
   * the point of the table is that it records what was written, including the times it
   * was written wrongly. The voided row stops counting and stops being offered; it does
   * not stop having happened.
   */
  voided?: boolean;
  /**
   * Legs of one parlay share this. Null on a single bet.
   *
   * The stake is repeated on every leg, so anything summing money must count it once
   * per parlay rather than once per row.
   */
  parlay_id?: string | null;
  /** The COMBINED price the book offered, not the product of the legs. */
  parlay_price?: number | null;
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
  /**
   * Cash paid to end this ticket early, when it was sold back before the final whistle.
   *
   * The one stored verdict in the whole ledger, and it is stored because it genuinely
   * cannot be derived: the price was negotiated with the book at a moment in the game,
   * and the final score stops deciding anything once it is taken. A $50 bonus moneyline
   * at +920 cashed for $193.98 grades as +$460 or $0 if left to the score -- both wrong,
   * and wrong in the way that matters here, because $460 looks exactly as plausible in a
   * ledger as $193.98 does.
   *
   * The amount is the CASH RECEIVED, on the same convention as `returned`: for an
   * ordinary bet that includes the stake coming back, so the profit is `cashout - stake`;
   * for a bonus bet the stake was never yours, so the whole thing is profit. Identical
   * asymmetry to a win, and for the identical reason.
   *
   * On a parlay it belongs to the TICKET, so every leg carries the same figure and
   * anything summing money counts it once.
   *
   * The score is still graded underneath — see `heldInstead`. One cash-out says nothing
   * about whether cashing out was right; twenty of them, against what holding would have
   * paid, is a measurement.
   */
  cashout?: number | null;
}

export interface Score {
  home_score: number;
  away_score: number;
}

export type Outcome = "won" | "lost" | "push" | "open" | "cashed";

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
    // A team total is a total with a team on it: the same line, asked of one side's
    // points instead of both. Null means the game, which is what every row written
    // before team totals existed meant.
    const points =
      bet.team === "home"
        ? score.home_score
        : bet.team === "away"
          ? score.away_score
          : total;
    if (points === bet.line) return null;
    return bet.side === "over" ? points > bet.line : points < bet.line;
  }

  return null;
}

/**
 * What the ticket paid, cash-out included.
 *
 * The cash-out is checked BEFORE the missing-score guard, on purpose: a bet sold back
 * at half time is finished, and the game it was on may not be. Falling through to
 * "open" would leave settled money sitting outside the ledger's totals until some
 * unrelated event finished.
 */
export function settle(bet: Bet, score: Score | undefined): Settlement {
  if (bet.cashout !== undefined && bet.cashout !== null) {
    return {
      outcome: "cashed",
      // Same asymmetry as a win: a bonus stake was never yours, so none of it comes
      // back and all of the cash is profit.
      profit: bet.bonus ? bet.cashout : bet.cashout - bet.stake,
      returned: bet.cashout,
    };
  }
  return settleOnScore(bet, score);
}

/**
 * What the ticket would have paid on its original terms, ignoring any cash-out.
 *
 * Used for the counterfactual. Cashing out always feels right afterwards when the bet
 * would have lost and always feels wrong when it would have won, which is precisely why
 * the question needs a number rather than a memory.
 */
export function settleOnScore(bet: Bet, score: Score | undefined): Settlement {
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

/** A settled ticket, plus what it would have paid had it run to the whistle. */
export type GradedRow = Bet &
  Settlement & {
    /**
     * Profit the original terms would have produced. Set only on a cashed ticket, and
     * only once its game is final — null everywhere else, because on a ticket that was
     * never cashed the counterfactual IS the result and repeating it would invite
     * something to double-count.
     */
    heldProfit: number | null;
  };

export interface Tally {
  placed: number;
  settled: number;
  won: number;
  lost: number;
  push: number;
  open: number;
  /** Tickets sold back before the final whistle. Neither won nor lost. */
  cashed: number;
  /** Of those, how many have a final score, and so a counterfactual worth reading. */
  cashedGraded: number;
  /** Profit actually booked from the cashed tickets that are now gradeable. */
  cashedTaken: number;
  /**
   * What those same tickets would have paid if held. Null until one is gradeable.
   *
   * The comparison is the only honest way to judge the decision. Cashing out feels
   * right whenever the bet would have lost and wrong whenever it would have won, and
   * memory keeps score of neither. A running total does.
   */
  cashedHeld: number | null;
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

/** How a settled ticket counts in the record. A cash-out counts by the money it made. */
export function recordResult(row: { outcome: Outcome; profit: number }): "won" | "lost" | "push" | "open" {
  if (row.outcome === "cashed") return row.profit > 0.005 ? "won" : row.profit < -0.005 ? "lost" : "push";
  return row.outcome;
}

export function tally(
  bets: Bet[],
  scores: Map<string, Score>,
): { rows: GradedRow[]; totals: Tally } {
  // One row per TICKET, not per leg. A parlay's stake is repeated on each of its legs,
  // so counting rows would read a three-leg $5 ticket as $15 risked and three separate
  // results -- inflating the sample, the turnover and the record all at once.
  const rows: GradedRow[] = groupParlays(bets).map((entry) => {
    if (entry.kind === "single") {
      const bet = entry.bet;
      const result = settle(bet, scores.get(bet.event_id));
      return { ...bet, ...result, heldProfit: heldInstead(bet, scores) };
    }
    const graded = settleParlay(entry.legs, scores);
    return {
      ...entry.legs[0],
      outcome: graded.outcome,
      profit: graded.profit,
      returned: graded.returned,
      heldProfit: heldInstead(entry.legs, scores),
    };
  });

  const cashedRows = rows.filter((r) => r.outcome === "cashed");
  const cashedGraded = cashedRows.filter((r) => r.heldProfit !== null);

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
      // A cash-out counts by the money it made, by the owner's rule (2026-09-26): up is a
      // win, down is a loss, even is a push. It is still counted apart in `cashed`, and
      // `cashedHeld` still reports what holding would have paid.
      won: rows.filter((r) => recordResult(r) === "won").length,
      lost: rows.filter((r) => recordResult(r) === "lost").length,
      push: rows.filter((r) => recordResult(r) === "push").length,
      open: rows.filter((r) => r.outcome === "open").length,
      cashed: cashedRows.length,
      cashedGraded: cashedGraded.length,
      cashedTaken: cashedGraded.reduce((sum, r) => sum + r.profit, 0),
      cashedHeld:
        cashedGraded.length === 0
          ? null
          : cashedGraded.reduce((sum, r) => sum + (r.heldProfit ?? 0), 0),
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

/**
 * The bets that still stand, with corrected rows dropped in favour of their corrections.
 *
 * Chains fall out for free: if A was corrected by B and B by C, both A and B are named
 * by a later row and only C survives. A row naming itself is ignored rather than
 * vanishing — a bet that deletes itself is the one outcome a correction must never
 * produce, since the money was staked whatever the record says.
 */
export function activeBets(bets: Bet[]): Bet[] {
  const corrected = new Set<string>();
  for (const bet of bets) {
    if (bet.supersedes && bet.supersedes !== bet.bet_id) corrected.add(bet.supersedes);
  }
  // A void removes both the row it names and itself: it is a tombstone, not a wager.
  return bets.filter((bet) => !corrected.has(bet.bet_id) && bet.voided !== true);
}

/**
 * Grade a parlay from its legs.
 *
 * All legs must win. One loser kills the ticket however well the others did, which is
 * the entire nature of the bet and the reason the payout is large.
 *
 * A pushed leg is the case with no honest arithmetic here. Books drop it and re-price
 * the ticket at the remaining legs, and the reduced price is theirs to compute, not
 * ours -- the odds they credit are not necessarily the product of what is left. So a
 * parlay containing a push is reported as needing correction rather than being settled
 * at a number that would be wrong in the book's favour or ours. The edit path exists
 * for exactly this.
 */
export interface ParlaySettlement extends Settlement {
  legs: Array<Bet & Settlement>;
  /** True when a leg pushed and the book will have re-priced the ticket. */
  needsCorrection: boolean;
}

export function settleParlay(
  legs: Bet[],
  scores: Map<string, Score>,
): ParlaySettlement {
  // Legs are graded on the SCORE, never on the ticket's cash-out: the cash-out belongs
  // to the ticket, and copying it onto each leg would report a three-leg parlay as three
  // separate cashed bets worth the whole amount each.
  const graded = legs.map((leg) => ({ ...leg, ...settleOnScore(leg, scores.get(leg.event_id)) }));
  const first = legs[0];
  const stake = first?.stake ?? 0;
  const bonus = first?.bonus === true;
  const price = first?.parlay_price ?? null;

  const base = { legs: graded, needsCorrection: false };

  // A parlay is cashed out as one ticket, so the figure sits on every leg and is read
  // from the first. Checked before the legs are consulted for the same reason a single
  // bet is: the ticket is finished even when its games are not.
  const cashed = first?.cashout;
  if (cashed !== undefined && cashed !== null) {
    return {
      ...base,
      outcome: "cashed",
      profit: bonus ? cashed : cashed - stake,
      returned: cashed,
    };
  }

  if (graded.some((leg) => leg.outcome === "lost")) {
    return { ...base, outcome: "lost", profit: bonus ? 0 : -stake, returned: 0 };
  }
  if (graded.some((leg) => leg.outcome === "open")) {
    return { ...base, outcome: "open", profit: 0, returned: 0 };
  }
  if (graded.some((leg) => leg.outcome === "push")) {
    // Every remaining leg won, but the book has re-priced. Not ours to guess.
    return { ...base, outcome: "open", profit: 0, returned: 0, needsCorrection: true };
  }

  const decimal = price === null ? null : decimalOdds(price);
  if (decimal === null) return { ...base, outcome: "open", profit: 0, returned: 0 };
  const profit = stake * (decimal - 1);
  return {
    ...base,
    outcome: "won",
    profit,
    returned: bonus ? profit : stake + profit,
  };
}

/** Split a ledger into single bets and parlay groups, preserving order. */
export function groupParlays(bets: Bet[]): Array<
  { kind: "single"; bet: Bet } | { kind: "parlay"; id: string; legs: Bet[] }
> {
  const out: Array<{ kind: "single"; bet: Bet } | { kind: "parlay"; id: string; legs: Bet[] }> = [];
  const seen = new Map<string, Bet[]>();
  for (const bet of bets) {
    const id = bet.parlay_id;
    if (!id) {
      out.push({ kind: "single", bet });
      continue;
    }
    const existing = seen.get(id);
    if (existing) {
      existing.push(bet);
      continue;
    }
    const legs = [bet];
    seen.set(id, legs);
    out.push({ kind: "parlay", id, legs });
  }
  return out;
}

/**
 * What a cashed ticket would have profited on its original terms.
 *
 * Null when the ticket was not cashed out, and null while its games are unfinished —
 * an ungraded counterfactual is not a small number, it is no number, and averaging it
 * in as zero would drag every comparison toward "cashing out was brilliant".
 *
 * Takes the legs of a parlay or a single bet, so one caller handles both.
 */
export function heldInstead(bet: Bet | Bet[], scores: Map<string, Score>): number | null {
  const legs = Array.isArray(bet) ? bet : [bet];
  const first = legs[0];
  if (!first || first.cashout === undefined || first.cashout === null) return null;

  if (legs.length === 1) {
    const result = settleOnScore(first, scores.get(first.event_id));
    return result.outcome === "open" ? null : result.profit;
  }

  // A parlay needs every leg final before the ticket has an answer, and settleParlay
  // reports a pushed leg as open because the book re-prices it — which is genuinely
  // unknown here, not zero.
  const settled = settleParlay(
    legs.map((leg) => ({ ...leg, cashout: null })),
    scores,
  );
  return settled.outcome === "open" ? null : settled.profit;
}
