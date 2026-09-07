import { normalCdf } from "./probability.ts";

/**
 * Deciding which edges are worth calling findings.
 *
 * The naive approach — flag anything larger than one standard error — is close to
 * useless here. Pure noise clears one standard error about 32% of the time, so across
 * sixty games it produces roughly twenty "findings" by chance. The page was reporting
 * 29 of 63, which is barely distinguishable from that.
 *
 * The question a ranked list actually poses is not "is this row significant" but "of
 * the rows shown, how many are junk?" — which is a false discovery rate question.
 * Benjamini-Hochberg answers it directly: it picks a cutoff such that the expected
 * proportion of false flags among those flagged is at most q.
 *
 * This controls only the error that comes from a finite sample. Model
 * mis-specification, the choice of de-vig, and stale prices are not in it, so a
 * surviving row is "not explained by sampling noise", never "real".
 */

/**
 * Two-sided p-value for an estimate this many standard errors from zero.
 *
 * Clamped to [0, 1]: the normal CDF here is a series approximation accurate to about
 * 1e-7, which returns 0.49999985 at zero and so yields a "probability" of 1.0000003.
 * Harmless to look at, but it feeds the Benjamini-Hochberg comparisons, and a value
 * outside [0, 1] has no business in a procedure that reasons about probabilities.
 */
export function twoSidedP(z: number): number {
  if (!Number.isFinite(z)) return 1;
  return Math.min(1, Math.max(0, 2 * (1 - normalCdf(Math.abs(z)))));
}

export interface Significance<T> {
  /** Rows that survive the false-discovery cutoff, in the order given. */
  discoveries: T[];
  /** Per-row verdict, aligned with the input order. */
  flags: boolean[];
  /** The p-value cutoff Benjamini-Hochberg selected. */
  cutoff: number;
  /** How many of the flagged rows are expected to be chance. */
  expectedFalse: number;
  tested: number;
  /** How many a naive one-standard-error rule would have flagged, for contrast. */
  naiveCount: number;
  q: number;
}

/**
 * Benjamini-Hochberg at level `q`.
 *
 * Sort the p-values, find the largest k with p(k) <= (k/m)·q, and flag everything at
 * or below that p-value. Flagging nothing is a legitimate and common answer.
 */
export function controlFalseDiscovery<T>(
  rows: T[],
  zOf: (row: T) => number,
  q = 0.1,
): Significance<T> {
  const m = rows.length;
  if (m === 0) {
    return { discoveries: [], flags: [], cutoff: 0, expectedFalse: 0, tested: 0, naiveCount: 0, q };
  }

  const ps = rows.map((row) => twoSidedP(zOf(row)));
  const naiveCount = rows.filter((row) => Math.abs(zOf(row)) > 1).length;

  const ordered = ps.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  let cutoff = 0;
  for (let k = m; k >= 1; k -= 1) {
    if (ordered[k - 1].p <= (k / m) * q) {
      cutoff = ordered[k - 1].p;
      break;
    }
  }

  const flags = ps.map((p) => p <= cutoff && cutoff > 0);
  const flagged = flags.filter(Boolean).length;

  return {
    discoveries: rows.filter((_, i) => flags[i]),
    flags,
    cutoff,
    // Among the flagged, at most this proportion is expected to be chance.
    expectedFalse: flagged * q,
    tested: m,
    naiveCount,
    q,
  };
}
