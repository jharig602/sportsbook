/**
 * What a profit boost is worth, and what price to record when you use one.
 *
 * A "100% profit boost" doubles the winnings and returns the stake, so a bet at +300
 * pays like a bet at +600. Nothing about the chance of winning changes -- only the
 * payout -- which makes the value easy to state exactly:
 *
 *     value per dollar = p x (1 + b x (1 + boost)) - 1
 *
 * with `p` the true win probability and `b` the book's profit per dollar. Writing the
 * book's implied probability as q and its margin on that side as h (so p ~ q(1 - h)),
 * a 100% boost is worth about
 *
 *     1 - q - 2h
 *
 * which says the whole thing in one line: longer odds help (smaller q), and the margin
 * hurts twice as much as usual (the doubled payout doubles what the hold takes). That
 * is why the best use is NOT the longest price on the board -- longshots carry the
 * largest hold -- but the longest price whose margin is still small.
 *
 * `p` has to come from somewhere other than the price being boosted. Read off that same
 * price it is circular, and de-vigged in the tails it is flattering: proportional de-vig
 * spreads the hold evenly, while books load it onto the underdog, so a longshot's "fair"
 * probability comes out too high and its boosted value with it. Callers should use a
 * conservative estimate -- the scan takes the lower of the market consensus and the
 * spread model.
 */

/** Profit per dollar staked at an American price. */
export function profitPerDollar(price: number): number {
  if (!Number.isFinite(price) || Math.abs(price) < 100) return Number.NaN;
  return price > 0 ? price / 100 : 100 / -price;
}

/**
 * Expected return per dollar, boosted. `boost` is 1 for a 100% profit boost.
 *
 * A losing bet returns nothing -- the boost changes only what a win pays.
 */
export function boostedEv(p: number, price: number, boost = 1): number {
  const b = profitPerDollar(price);
  if (!Number.isFinite(b) || !(p >= 0 && p <= 1)) return Number.NaN;
  return p * (1 + b * (1 + boost)) - 1;
}

/**
 * The price a boosted bet actually pays at, to record in the ledger.
 *
 * Logging the pre-boost price would settle a winner at half its real profit, and the
 * record would understate the one bet the promotion made most valuable. Books round the
 * boosted price down; record whatever the slip shows if it differs from this.
 */
export function boostedPrice(price: number, boost = 1): number {
  const b = profitPerDollar(price) * (1 + boost);
  if (!Number.isFinite(b)) return Number.NaN;
  return b >= 1 ? Math.round(100 * b) : -Math.round(100 / b);
}

/** Decimal odds of a parlay as a book prices it: the product of its legs. */
export function parlayPrice(prices: number[]): number {
  const decimal = prices.reduce((acc, price) => acc * (1 + profitPerDollar(price)), 1);
  const profit = decimal - 1;
  return profit >= 1 ? Math.floor(100 * profit) : -Math.ceil(100 / profit);
}
