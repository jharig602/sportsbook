import type { Field, ScoredLine } from "./pool-win";

/**
 * Winning a survivor pool the way a survivor pool is actually won.
 *
 * `poolWin` scores P(you reach the final week) ÷ (1 + people who reach it with you).
 * That is the right question only for a pool that always produces a survivor. The real
 * rule is that **the last entrant standing wins** — if everyone busts, the pot goes to
 * whoever lasted longest — and the difference is not academic. A 13-entry pool with two
 * lives each wipes out entirely in about 44% of seasons. Under the old objective every
 * one of those seasons scored zero for everybody. Under the real one they each have a
 * winner, and measured on the live plan they are worth 1.68x the number that was being
 * reported: 1 in 26 becomes 1 in 15.
 *
 * The strategic consequence is larger than the arithmetic one. Scoring survival treats
 * every elimination as equally worthless, so dying in week 2 and dying in week 16 are
 * the same result — which makes the planner indifferent to how long it lasts once it
 * has stopped believing it can go the distance. Scoring the finishing week makes
 * outlasting the field a goal in itself, and since the field mostly herds, the weeks
 * the crowd dies are exactly the weeks this objective is trying to be alive for.
 *
 * A 137-entry pool is essentially unaffected (1.00x): with that many entrants somebody
 * nearly always reaches the end, so the two objectives ask the same question. This is
 * used for both anyway, because it is the correct model and it costs nothing to be
 * right in the case where it does not matter.
 */

/**
 * The crowding that applies in week `i` of the plan: the week's own override when one is
 * set (a week with known picks), the field's rate otherwise. Lives here, beside the
 * simulation that reads it, so the dependency runs one way.
 */
export function crowdingAt(field: Field, i: number): number {
  const override = field.crowdingByWeek?.[i];
  return override !== undefined && Number.isFinite(override) ? override : field.crowding;
}

/**
 * Expected share of the pot, given how many rivals finish level with you.
 *
 * With `A` = P(a rival is out before you) and `B` = P(a rival goes out in the very same
 * week), the number of rivals tying you is Binomial, and
 *
 *     E[1/(1+K)] = ((A+B)^(R+1) - A^(R+1)) / ((R+1) * B)
 *
 * by the same identity `shareOfPot` uses. Closed form, so the tie case costs nothing.
 * When B is zero — nobody can finish level — it collapses to A^R, which is simply the
 * chance every rival is already out.
 */
export function shareAgainstExits(before: number, level: number, rivals: number): number {
  if (rivals <= 0) return 1;
  if (level <= 1e-12) return Math.pow(before, rivals);
  return (
    (Math.pow(before + level, rivals + 1) - Math.pow(before, rivals + 1)) /
    ((rivals + 1) * level)
  );
}

/**
 * When an entry goes out, as a distribution.
 *
 * `pmf[i]` is P(eliminated during week i); the final slot is P(never eliminated), which
 * is why the array is one longer than the season. Written allocation-free for the same
 * reason as `rivalSurvival`: this runs once per sampled season per candidate.
 */
export function exitPmf(
  loseEachWeek: Float64Array,
  lossesAllowed: number,
  out: Float64Array,
  dp: Float64Array,
): void {
  const weeks = loseEachWeek.length;
  out.fill(0);
  dp.fill(0);
  dp[0] = 1;
  const dead = lossesAllowed + 1;
  let deadSoFar = 0;
  for (let i = 0; i < weeks; i += 1) {
    const lose = loseEachWeek[i];
    const win = 1 - lose;
    for (let j = lossesAllowed; j >= 0; j -= 1) {
      const here = dp[j];
      if (here === 0) continue;
      dp[j + 1] += here * lose;
      dp[j] = here * win;
    }
    // Whatever crossed into the eliminated state this week went out this week.
    out[i] = dp[dead] - deadSoFar;
    deadSoFar = dp[dead];
  }
  let alive = 0;
  for (let j = 0; j <= lossesAllowed; j += 1) alive += dp[j];
  out[weeks] = alive;
}

/**
 * A deterministic stream of seasons for the crowd.
 *
 * The pattern of WHICH weeks the crowd lost matters now, not merely how many, because a
 * rival's whole exit distribution turns on it. That is 2^18 patterns, which is not
 * something to enumerate inside a page render, so this samples instead — and this is
 * the one place in the project that does.
 *
 * It is defensible here only because the seed is fixed. Every candidate is scored
 * against the SAME seasons, so the sampling error is common to all of them and cancels
 * out of the comparison, which is the number anyone acts on. The absolute level carries
 * a little noise; the ranking does not. Common random numbers, and the reason the usual
 * "exact, never simulated" rule is set aside exactly once.
 */
/**
 * Seasons sampled for the headline numbers. 12,000 lands within about 1.5% of a
 * 300,000-sample reference, which is well inside the honesty of the inputs feeding it.
 * The sensitivity search below runs at a fraction of this, because a crossover point is
 * a threshold rather than a level and does not need the same resolution.
 */
export const SEASONS = 12000;

/**
 * Everything about the field that does not depend on which team you pick.
 *
 * The crowd's seasons and each rival's exit distribution within them are the same for
 * every candidate, and they are most of the work. Computing them once per pool instead
 * of once per pick is what makes this affordable enough to run at twenty thousand
 * seasons rather than four, and the accuracy that buys is the difference between the
 * level being trustworthy and merely indicative.
 */
export interface PreparedField {
  weeks: number;
  lossesAllowed: number;
  seasons: number;
  /** SEASONS x weeks, 1 where the crowd's team lost. */
  crowdLost: Uint8Array;
  /** SEASONS x (weeks + 1): P(a rival is out before week t), cumulative. */
  rivalBefore: Float64Array;
  /** SEASONS x (weeks + 1): P(a rival goes out in exactly week t). */
  rivalAt: Float64Array;
}

/**
 * `rivalLosses` is the field as it stands: how many rivals carry each number of losses
 * already. Absent means everyone is unbeaten, which is only true before week 1.
 *
 * A rival a loss down is simulated with one fewer life, and each rival's exit
 * distribution is the MIX of those, weighted by how many are in each state. That treats
 * every rival as an independent draw from the recorded mix rather than holding the
 * split fixed at exactly 90 and 51 — an approximation, and one that is measured rather
 * than assumed: see "the mixed field stays close to the exact two-group answer" in the
 * tests, which integrates the exact version and bounds the gap for both real pools.
 */
export function prepareField(
  field: Field,
  weeks: number,
  lossesAllowed: number,
  seasons: number = SEASONS,
  rivalLosses?: number[],
): PreparedField {
  // xorshift32 with a fixed seed: the same seasons on every render and every machine,
  // so two candidates are always compared over identical worlds.
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };

  const span = weeks + 1;
  const crowdLost = new Uint8Array(seasons * weeks);
  const rivalBefore = new Float64Array(seasons * span);
  const rivalAt = new Float64Array(seasons * span);

  const base = new Float64Array(weeks);
  // Per week, so the current week can carry the bloc its KNOWN picks imply while later
  // weeks keep the rate assumed for picks nobody has made yet. See `crowdingAt`.
  const crowd = new Float64Array(weeks);
  for (let i = 0; i < weeks; i += 1) {
    crowd[i] = crowdingAt(field, i);
    base[i] = (1 - crowd[i]) * (1 - (field.restProbabilities?.[i] ?? field.probabilities[i]));
  }
  const lose = new Float64Array(weeks);
  const pmf = new Float64Array(span);
  const part = new Float64Array(span);
  const dp = new Float64Array(lossesAllowed + 3);

  // Shares by losses already taken. Only states with lives remaining are rivals at all.
  const counts = (rivalLosses ?? [1]).slice(0, lossesAllowed + 1).map((n) => Math.max(0, n));
  const total = counts.reduce((a, b) => a + b, 0);
  const shares = total > 0 ? counts.map((n) => n / total) : [1];

  for (let s = 0; s < seasons; s += 1) {
    const w0 = s * weeks;
    for (let i = 0; i < weeks; i += 1) {
      const lost = next() >= field.probabilities[i] ? 1 : 0;
      crowdLost[w0 + i] = lost;
      lose[i] = lost ? base[i] + crowd[i] : base[i];
    }
    if (shares.length === 1) {
      exitPmf(lose, lossesAllowed, pmf, dp);
    } else {
      pmf.fill(0);
      for (let k = 0; k < shares.length; k += 1) {
        if (shares[k] === 0) continue;
        exitPmf(lose, lossesAllowed - k, part, dp);
        for (let t = 0; t < span; t += 1) pmf[t] += shares[k] * part[t];
      }
    }
    const p0 = s * span;
    let before = 0;
    for (let t = 0; t < span; t += 1) {
      rivalBefore[p0 + t] = before;
      rivalAt[p0 + t] = pmf[t];
      before += pmf[t];
    }
  }
  return { weeks, lossesAllowed, seasons, crowdLost, rivalBefore, rivalAt };
}

/**
 * P(you are the last entrant standing), ties split.
 *
 * Only your own exit distribution is computed here; the field's was prepared once.
 */
export function lastStandingWin(
  line: ScoredLine,
  prepared: PreparedField,
  poolSize: number,
  /** Losses your entry has already taken. It plays the rest on the lives it has left. */
  myLosses = 0,
): number {
  const { weeks, seasons, crowdLost, rivalBefore, rivalAt } = prepared;
  const lossesAllowed = prepared.lossesAllowed - myLosses;
  // Already out: there is no season in which an eliminated entry takes the pool.
  if (lossesAllowed < 0) return 0;
  if (weeks === 0 || line.mine.length !== weeks) return 0;
  const rivals = Math.max(0, poolSize - 1);
  const span = weeks + 1;

  const lose = new Float64Array(weeks);
  const pmf = new Float64Array(span);
  const dp = new Float64Array(lossesAllowed + 3);
  // The weeks you are on your own ticket do not vary by season; only shared ones do.
  const solo = new Float64Array(weeks);
  for (let i = 0; i < weeks; i += 1) solo[i] = 1 - line.mine[i];

  let total = 0;
  for (let s = 0; s < seasons; s += 1) {
    const w0 = s * weeks;
    for (let i = 0; i < weeks; i += 1) {
      // On a shared week your result IS the crowd's; otherwise it is your own game.
      lose[i] = line.shared[i] ? crowdLost[w0 + i] : solo[i];
    }
    exitPmf(lose, lossesAllowed, pmf, dp);
    const p0 = s * span;
    for (let t = 0; t < span; t += 1) {
      const mass = pmf[t];
      if (mass > 1e-15) {
        total += mass * shareAgainstExits(rivalBefore[p0 + t], rivalAt[p0 + t], rivals);
      }
    }
  }
  return total / seasons;
}
