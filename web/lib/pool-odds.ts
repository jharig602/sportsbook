/**
 * Survivor odds when you get more than one life, and when the size of the pool
 * changes what "winning" means.
 *
 * Two things the single-life planner got wrong for these pools.
 *
 * **Eliminated on the second loss, not the first.** Surviving is no longer the product
 * of the weekly probabilities; it is the chance of at most one loss across the season,
 * which is a different and much larger number. Reporting the product would understate
 * a two-life pool badly -- roughly by a factor of ten over a full season -- and would
 * also mis-rank plans, because a spare life makes a riskier week cheaper.
 *
 * **You are not playing the schedule, you are playing the other entrants.** A pool pays
 * the last survivor, so what matters is outlasting the field, not reaching week 18. In
 * a 13-player pool the field is usually gone by week 6 or 7 and you win by simply not
 * losing. In a 137-player pool, a pick that 80% of the field also made cannot separate
 * you from them: if it wins you all advance together, and if it loses you all take a
 * strike together. The large pool is where being different starts to be worth more
 * than being safe.
 */

/**
 * P(still alive) after each week, given a loss allowance.
 *
 * A small dynamic program over (week, losses so far). Exact rather than simulated:
 * eighteen weeks and two states is nothing, and a simulation would put sampling noise
 * into a number people will compare against another number.
 */
export function aliveCurve(probabilities: number[], lossesAllowed: number): number[] {
  // dp[j] = P(exactly j losses so far)
  let dp = new Array(lossesAllowed + 2).fill(0);
  dp[0] = 1;
  const curve: number[] = [];

  for (const p of probabilities) {
    const next = new Array(lossesAllowed + 2).fill(0);
    for (let j = 0; j <= lossesAllowed + 1; j += 1) {
      if (dp[j] === 0) continue;
      // Already eliminated states stay eliminated.
      if (j > lossesAllowed) {
        next[j] += dp[j];
        continue;
      }
      next[j] += dp[j] * p;
      next[j + 1] += dp[j] * (1 - p);
    }
    dp = next;
    curve.push(dp.slice(0, lossesAllowed + 1).reduce((a, b) => a + b, 0));
  }
  return curve;
}

/** P(surviving every week with no more losses than allowed). */
export function survival(probabilities: number[], lossesAllowed: number): number {
  const curve = aliveCurve(probabilities, lossesAllowed);
  return curve.length ? curve[curve.length - 1] : 1;
}

export interface PoolOdds {
  /** P(alive) after each planned week. */
  alive: number[];
  /** P(alive at the end of the plan). */
  survival: number;
  /** Expected number of OTHER entrants still alive after each week. */
  fieldAlive: number[];
  /**
   * First week where the rest of the field is expected to be under one player, i.e.
   * where the pool plausibly resolves. Null if it never does inside the plan.
   */
  likelyEndWeek: number | null;
  /**
   * Rough chance of taking the pool: your survival at the likely end, shared with
   * whoever else is still standing. A structural estimate, not a forecast.
   */
  winChance: number;
  /** Weeks into the plan before the field thins enough for differentiating to pay. */
  differentiationWeek: number | null;
}

/**
 * How the pool is likely to unfold.
 *
 * The field is modelled as playing about as well as you do, which is the honest
 * default: survivor entrants overwhelmingly pick the biggest favourite, and so does
 * this planner. That makes the estimate of how many rivals remain a reasonable one.
 *
 * What it does NOT model is how correlated you are with them, and an earlier version of
 * this comment claimed that was the optimistic end of the range -- that correlation
 * "would only make ties more likely". That is wrong, and wrong in both directions at
 * once. Correlation cuts against you when you hold the crowd's ticket (surviving
 * together decides nothing, and `winChance` above overstates it badly) and for you when
 * you do not (the weeks the crowd loses, you gain the whole field). Which way it cuts
 * depends on the picks, so it cannot be signed in advance and cannot be waved off.
 *
 * `pool-win.ts` models it properly and is what the survivor page ranks on. What remains
 * here is the shape of the season -- the alive curve, when the field thins, what a
 * spare life is worth -- which is unaffected and still what those numbers describe.
 * `winChance` is kept for that shape, not as the number to act on.
 */
export function poolOdds(
  probabilities: number[],
  lossesAllowed: number,
  poolSize: number,
): PoolOdds {
  const alive = aliveCurve(probabilities, lossesAllowed);
  const rivals = Math.max(0, poolSize - 1);
  const fieldAlive = alive.map((p) => rivals * p);

  let likelyEndWeek: number | null = null;
  for (let i = 0; i < fieldAlive.length; i += 1) {
    if (fieldAlive[i] < 1) {
      likelyEndWeek = i + 1;
      break;
    }
  }

  // Where the field halves: past this point a pick shared with everyone stops being
  // enough, because the people you share it with are the ones you must separate from.
  let differentiationWeek: number | null = null;
  for (let i = 0; i < fieldAlive.length; i += 1) {
    if (fieldAlive[i] <= rivals / 2) {
      differentiationWeek = i + 1;
      break;
    }
  }

  const endIndex = likelyEndWeek ? likelyEndWeek - 1 : alive.length - 1;
  const yourSurvival = alive[endIndex] ?? 0;
  const others = fieldAlive[endIndex] ?? 0;
  // Split among everyone still standing, yourself included.
  const winChance = yourSurvival > 0 ? yourSurvival / (1 + others) : 0;

  return {
    alive,
    survival: alive.length ? alive[alive.length - 1] : 1,
    fieldAlive,
    likelyEndWeek,
    winChance,
    differentiationWeek,
  };
}

/**
 * How much a spare life is worth, as a multiple.
 *
 * Reported rather than folded away because it is the single number that explains why a
 * two-strike plan should look different from a one-strike plan: it says how much room
 * the second life actually buys.
 */
export function extraLifeMultiple(probabilities: number[]): number {
  const one = survival(probabilities, 0);
  const two = survival(probabilities, 1);
  return one > 0 ? two / one : 0;
}
