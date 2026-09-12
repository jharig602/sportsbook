import type { BoardEdge } from "./board-shop";

/**
 * Games too lopsided to price honestly.
 *
 * The obvious reason to exclude these is wrong, and it is worth writing down so nobody
 * re-derives it. Blowouts are NOT more volatile. Measured on 1,247 graded games, the
 * residual standard deviation is flat across the whole range and lower at the extreme:
 *
 *     |spread|   games   share   residual sd   cover %
 *      0-7        565    45.3%      14.31       50.6%
 *      14-21      142    11.4%      14.49       49.3%
 *      28-35       71     5.7%      15.41       54.9%
 *      35-45       55     4.4%      14.81       52.7%
 *      45+         26     2.1%      11.36       50.0%
 *
 * Cover sits at about half everywhere, so there is no favourite bias by spread size
 * either. A 56-point favourite is, as far as the margin model can tell, as predictable
 * as a 3-point one.
 *
 * The actual problems are different and both are about the market rather than the maths:
 *
 * 1. NO SAMPLE. Twenty-six games past 45 points is not enough to have fitted the SHAPE
 *    of the residual distribution out there — and the shape, not the width, is what
 *    `winProbabilityFromSpread` reads. The lumpiness on 3 and 7 that makes the model
 *    worth having was measured on games nothing like these.
 * 2. NOBODY IS BETTING IT. These are low-limit, low-attention markets. A two-point gap
 *    between books on a 56-point line is far more likely to be one book not having
 *    bothered to move than a real disagreement — and a stale line is not an edge, it is
 *    a number you cannot get down on.
 *
 * So the cut is a statement about confidence, not about variance, and it is set where
 * the sample thins rather than where the arithmetic changes.
 */

/**
 * Default cut, in points.
 *
 * 28 leaves about 88% of games on the board and removes the range where the sample
 * falls under a hundred. Adjustable, because it is a judgement about how much
 * extrapolation is tolerable rather than a fact.
 */
export const DEFAULT_MAX_SPREAD = 28;

/** No filter at all, for when you want to see what is being hidden. */
export const NO_LIMIT = 999;

export function parseMaxSpread(raw: string | null | undefined): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return DEFAULT_MAX_SPREAD;
  return Math.min(NO_LIMIT, Math.max(1, Math.round(value)));
}

/** True when the game is lopsided enough that its prices should not be trusted. */
export function isBlowout(gameSpread: number | null | undefined, maxSpread: number): boolean {
  if (gameSpread === null || gameSpread === undefined) return false;
  return Math.abs(gameSpread) >= maxSpread;
}

export interface Filtered<T> {
  kept: T[];
  /** How many rows the cut removed, so the page can say so rather than just shrink. */
  removed: number;
}

/**
 * Drop rows on games past the cut.
 *
 * Reports what it removed. A filter that silently shrinks a list is how you end up
 * believing the board is thin when it is merely filtered — the same failure as a
 * matching bug presenting as "the books agree".
 */
export function withoutBlowouts(rows: BoardEdge[], maxSpread: number): Filtered<BoardEdge> {
  if (maxSpread >= NO_LIMIT) return { kept: rows, removed: 0 };
  const kept = rows.filter((row) => !isBlowout(row.gameSpread, maxSpread));
  return { kept, removed: rows.length - kept.length };
}
