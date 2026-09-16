/**
 * The two distributions this app needs and JavaScript does not have.
 *
 * Both exist for one purpose: deciding whether a slice of the record is a finding or a
 * coincidence. That question gets sharper, not easier, the more ways the record can be
 * sliced — six cells of seventeen games will always contain a best one, and it will
 * always look convincing.
 */

/**
 * Inverse standard normal CDF — the z for a given one-tailed area.
 *
 * Acklam's rational approximation, accurate to about 1e-9 across the range, which is
 * far beyond what any confidence interval here is claiming. Needed because a
 * multiple-comparison correction moves the critical value off 1.96 and there is no
 * honest way to hardcode a table of them.
 */
export function probit(p: number): number {
  if (!(p > 0 && p < 1)) return Number.NaN;

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
             1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
             6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
             -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
             3.754408661907416];

  const low = 0.02425;
  const high = 1 - low;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

/**
 * log n!, summed exactly rather than approximated.
 *
 * Stirling's series was the obvious choice and it is wrong for this purpose: it carries
 * a relative error near 1e-8, which showed up immediately as a binomial tail that missed
 * a hand-checked 0.5 in the eighth decimal. Nothing here would have noticed a small
 * error in a p-value, which is precisely why it is not worth having one.
 *
 * Summing logs is exact to double precision and costs nothing at these sizes — the
 * record is thousands of graded alerts, not billions — and the table is built once.
 */
const LOG_FACTORIAL: number[] = [0, 0];

function logFactorial(n: number): number {
  if (n < 2) return 0;
  for (let i = LOG_FACTORIAL.length; i <= n; i += 1) {
    LOG_FACTORIAL[i] = LOG_FACTORIAL[i - 1] + Math.log(i);
  }
  return LOG_FACTORIAL[n];
}

function logChoose(n: number, k: number): number {
  if (k < 0 || k > n) return -Infinity;
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/**
 * P(X >= hits) for X ~ Binomial(n, p). The exact one-sided p-value for a win rate.
 *
 * Exact rather than normal-approximated because the samples that most need judging are
 * the small ones, and that is exactly where the normal approximation is loosest — a
 * seventeen-game cell is the case this whole module exists for.
 */
export function binomialTailAtLeast(hits: number, n: number, p: number): number {
  if (n <= 0) return 1;
  if (hits <= 0) return 1;
  if (hits > n) return 0;
  // Summing from the far tail inward keeps the largest terms last and the error small.
  let total = 0;
  for (let k = hits; k <= n; k += 1) {
    total += Math.exp(logChoose(n, k) + k * Math.log(p) + (n - k) * Math.log1p(-p));
  }
  return Math.min(1, Math.max(0, total));
}

/**
 * P(Z >= z) for a standard normal.
 *
 * Abramowitz and Stegun 7.1.26, good to 1.5e-7 -- used where many picks at mixed prices
 * are summed, which is the case a normal approximation is for. The binomial tail above
 * stays the tool wherever every pick shares one price.
 */
export function upperTail(z: number): number {
  if (!Number.isFinite(z)) return z > 0 ? 0 : 1;
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const poly =
    t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erfc = poly * Math.exp(-x * x);
  return z >= 0 ? erfc / 2 : 1 - erfc / 2;
}
