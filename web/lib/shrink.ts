/**
 * Correcting the winner's curse on a ranked list.
 *
 * Taking the largest of many noisy estimates systematically selects the largest error.
 * Simulated against a perfectly efficient board — every true edge exactly zero — the
 * biggest number visible on a typical week is still about 4 points at the current
 * sample size. Reading that as an opportunity is the single most expensive mistake
 * this app could invite, and it is the mistake a ranked list is built to invite.
 *
 * Empirical Bayes fixes it without any judgement call. If observed edges scatter no
 * more than sampling noise alone would produce, then the true spread of edges is zero
 * and every observation shrinks to zero — which is the correct answer for an efficient
 * market. If they scatter more than noise explains, the excess is real signal and
 * survives shrinkage in proportion to how much.
 */

export interface Shrinkage {
  /** Estimated spread of true edges, in points. Zero when noise explains everything. */
  tau: number;
  /** Multiplier applied to each observation, between 0 and 1. */
  factor: number;
  /** Observed scatter, for showing the comparison that produced the factor. */
  observedSd: number;
  /** Scatter that sampling noise alone would produce. */
  noiseSd: number;
  n: number;
}

/**
 * Estimate how much of the observed scatter is real.
 *
 * The variance estimate is itself noisy, and a single week's board is only sixty-odd
 * rows, so the factor wobbles between weeks. It is still far better than not shrinking
 * at all: wrong by a little beats systematically selecting the largest error.
 *
 * Observed variance is true variance plus noise variance, so the true part is the
 * excess — floored at zero, because a negative estimate means noise already explains
 * everything and then some.
 */
export function estimateShrinkage(edges: number[], standardErrors: number[]): Shrinkage {
  const n = edges.length;
  if (n < 2) return { tau: 0, factor: 0, observedSd: 0, noiseSd: 0, n };

  const mean = edges.reduce((a, b) => a + b, 0) / n;
  const observedVariance = edges.reduce((sum, e) => sum + (e - mean) ** 2, 0) / (n - 1);
  const noiseVariance = standardErrors.reduce((sum, se) => sum + se * se, 0) / n;

  const trueVariance = Math.max(0, observedVariance - noiseVariance);
  const factor = trueVariance + noiseVariance > 0
    ? trueVariance / (trueVariance + noiseVariance)
    : 0;

  return {
    tau: Math.sqrt(trueVariance),
    factor,
    observedSd: Math.sqrt(observedVariance),
    noiseSd: Math.sqrt(noiseVariance),
    n,
  };
}

/** The edge worth acting on: the observation pulled toward zero by that factor. */
export function shrink(edge: number, shrinkage: Shrinkage): number {
  return edge * shrinkage.factor;
}
