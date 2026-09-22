/**
 * How much of a measured edge actually turns up.
 *
 * The app computes an edge for every line: how far the consensus fair probability sits
 * above the one this price needs to break even. The question this answers is whether
 * that number means what it says. A rule can be directionally right and still wildly
 * overconfident — a "+4 point edge" that reliably delivers +1 is a useful rule being
 * read four times too loudly, and the fix is arithmetic rather than a new model.
 *
 * ## Why this needs the census and cannot use the picks
 *
 * `shop_picks` holds the rows the rule said to bet, written the first moment the edge
 * turned positive. Fitting a calibration on those is fitting it on a sample selected for
 * the estimate being noisy-high, which guarantees the realised edge comes in under the
 * measured one whether or not anything is wrong. It would report a slope below 1 for a
 * perfect rule. `line_census` has no such filter, so the negative rows are what make the
 * positive ones readable.
 *
 * ## The number
 *
 * Regression through the origin: `realised excess = slope x predicted excess`, where
 * excess means "above what the price needs". Through the origin because a line with no
 * predicted edge must have no expected realised edge — an intercept here would be the
 * model claiming free money on a fairly priced bet, which is not a thing a calibration
 * is allowed to discover.
 *
 * - **slope 1** — edges are exactly as advertised.
 * - **slope 0.4** — four tenths of each measured edge is real; bet only where the
 *   measured edge is 2.5x the bar.
 * - **slope 0, within error** — the measured edge predicts nothing. That is a finding,
 *   and the honest response is to stop betting on it rather than to retune until it
 *   looks better.
 *
 * ## What it is not
 *
 * Not a way to find an edge. It measures how far to trust the edges already found, which
 * improves returns by betting LESS and better. If there is no signal it says so sooner
 * and more decisively than the picks ever could, because the sample is the whole board
 * rather than the few rows a threshold let through.
 */
import { didWin, type Score } from "./settle";
import type { Market } from "./types";

export interface CensusRow {
  census_id: string;
  league: string;
  event_id: string;
  book: string;
  market: Market;
  side: string;
  line: number | null;
  price: number;
  fair_probability: number;
  break_even: number | null;
  edge_points: number | null;
  books_compared: number;
  thin_consensus: boolean;
}

export interface GradedCensus extends CensusRow {
  /** Null on a push, which is neither a hit nor a miss. */
  covered: boolean | null;
}

/**
 * Score every line whose game has finished.
 *
 * Reuses the ledger's own `didWin`, so a census row and a real bet on the same number can
 * never be graded by two different rules — the one place this would go wrong silently.
 */
export function gradeCensus(
  rows: CensusRow[],
  scores: Map<string, Score>,
): GradedCensus[] {
  const out: GradedCensus[] = [];
  for (const row of rows) {
    const score = scores.get(row.event_id);
    if (!score) continue;
    const covered = didWin(
      {
        market: row.market,
        side: row.side as never,
        line: row.line,
      } as never,
      score,
    );
    out.push({ ...row, covered });
  }
  return out;
}

/**
 * One result per number, not per book.
 *
 * Nine books offering the same side at the same line is one thing that happened, and
 * counting it nine times would shrink every confidence interval below by a factor of
 * three around a sample that never grew. The best price of the group is kept, because
 * that is the one a bet would actually have been struck at.
 */
export function collapseCensus(rows: GradedCensus[]): GradedCensus[] {
  const groups = new Map<string, GradedCensus[]>();
  for (const row of rows) {
    const key = `${row.event_id}|${row.market}|${row.side}|${row.line ?? ""}`;
    groups.set(key, [...(groups.get(key) ?? []), row]);
  }
  const out: GradedCensus[] = [];
  for (const group of groups.values()) {
    // Best price = the largest edge, which is the same ordering and already computed.
    const best = group.reduce((a, b) =>
      (b.edge_points ?? -Infinity) > (a.edge_points ?? -Infinity) ? b : a,
    );
    out.push(best);
  }
  return out;
}

export interface CalibrationBucket {
  lo: number;
  hi: number;
  n: number;
  pushes: number;
  won: number;
  /** Mean predicted excess over break-even, in percentage points. */
  predicted: number;
  /** Realised excess over break-even, in percentage points. */
  realised: number;
}

export interface EdgeCalibration {
  /** Rows that decided something. Pushes are excluded, not split. */
  n: number;
  /** Fraction of a measured edge that shows up. Null when nothing varies. */
  slope: number | null;
  slopeSe: number | null;
  buckets: CalibrationBucket[];
  /** The bands used, so the page can say what it grouped. */
  edges: number[];
}

const BANDS = [-Infinity, -2, -1, 0, 1, 2, 3, Infinity];

/**
 * Fit the discount, and show the curve it came from.
 *
 * The slope is the product; the buckets are there so it can be disbelieved. A single
 * number fitted to a relationship that is not a line would be exactly the confident,
 * unfalsifiable figure this project keeps deleting, and a bucket table that does not rise
 * from left to right says so at a glance.
 */
export function calibrate(rows: GradedCensus[]): EdgeCalibration {
  const decided = rows.filter((r) => r.covered !== null && r.break_even !== null);

  let sumXY = 0;
  let sumXX = 0;
  for (const row of decided) {
    const predicted = row.fair_probability - (row.break_even as number);
    const realised = (row.covered ? 1 : 0) - (row.break_even as number);
    sumXY += predicted * realised;
    sumXX += predicted * predicted;
  }

  const slope = sumXX > 0 ? sumXY / sumXX : null;
  // Residual variance of a 0/1 outcome is at most 0.25, so 0.5 is the conservative
  // numerator. Using the fitted residuals instead would understate the error on the
  // small samples this will run on for months.
  const slopeSe = sumXX > 0 ? 0.5 / Math.sqrt(sumXX) : null;

  const buckets: CalibrationBucket[] = [];
  for (let i = 0; i < BANDS.length - 1; i += 1) {
    const lo = BANDS[i];
    const hi = BANDS[i + 1];
    const inBand = rows.filter(
      (r) => (r.edge_points ?? 0) >= lo && (r.edge_points ?? 0) < hi,
    );
    const settled = inBand.filter((r) => r.covered !== null && r.break_even !== null);
    if (inBand.length === 0) continue;
    const won = settled.filter((r) => r.covered).length;
    buckets.push({
      lo,
      hi,
      n: settled.length,
      pushes: inBand.length - settled.length,
      won,
      predicted:
        settled.length > 0
          ? (settled.reduce(
              (sum, r) => sum + (r.fair_probability - (r.break_even as number)),
              0,
            ) /
              settled.length) *
            100
          : 0,
      realised:
        settled.length > 0
          ? (won / settled.length -
              settled.reduce((sum, r) => sum + (r.break_even as number), 0) /
                settled.length) *
            100
          : 0,
    });
  }

  return { n: decided.length, slope, slopeSe, buckets, edges: BANDS };
}

/**
 * What a measured edge is worth once the discount is applied.
 *
 * Returns the edge unchanged when there is no calibration yet, which is the only honest
 * default: with nothing measured, discounting by a guess would be inventing the very
 * number this file exists to measure. A negative slope is treated as no information
 * rather than as a reason to bet the other side — a rule that is backwards is a rule to
 * stop using, not to invert, and inverting it here would bet real money on the sign of a
 * statistic that has not cleared its own error bar.
 */
export function calibratedEdgePoints(
  measured: number,
  calibration: EdgeCalibration | null,
  /** How many standard errors the slope must clear before it is used at all. */
  requiredZ = 2,
): number {
  if (!calibration || calibration.slope === null || calibration.slopeSe === null) {
    return measured;
  }
  if (!(calibration.slopeSe > 0)) return measured;
  if (calibration.slope <= 0) return 0;
  if (calibration.slope / calibration.slopeSe < requiredZ) return measured;
  return measured * Math.min(1, calibration.slope);
}
