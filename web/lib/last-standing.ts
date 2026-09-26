import type { Bloc, Field, ScoredLine } from "./pool-win";

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
 * A bloc's share of the field at a given herding rate: the picks already made, plus the
 * rivals whose best remaining team this is, times how many of them follow the board.
 */
export function blocShare(bloc: Bloc, crowding: number): number {
  return Math.max(0, bloc.fixed + bloc.herd * crowding);
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
  /**
   * With a bloc field: SEASONS x weeks x `blocWidth`, 1 where that bloc's team lost, and
   * the blocs themselves so your own line can find the one it shares a game with.
   */
  blocs?: Bloc[][];
  blocLost?: Uint8Array;
  blocWidth?: number;
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

  const crowding = field.crowding;
  const base = new Float64Array(weeks);
  for (let i = 0; i < weeks; i += 1) {
    base[i] = (1 - crowding) * (1 - (field.restProbabilities?.[i] ?? field.probabilities[i]));
  }
  const bloc = field.blocs ? blocSchedule(field, weeks) : null;
  const blocLost = bloc ? new Uint8Array(seasons * weeks * bloc.width) : undefined;
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
    if (bloc && blocLost) {
      for (let i = 0; i < weeks; i += 1) {
        const w = bloc.weeks[i];
        // One draw per game on the week's slate, blocs or not, so two fields over the
        // same schedule see the same games go the same way. See `blocSchedule`.
        for (let g = 0; g < w.draws; g += 1) bloc.drawn[g] = next();
        const b0 = (w0 + i) * bloc.width;
        let rate = w.restLose;
        for (let k = 0; k < w.probability.length; k += 1) {
          const u = bloc.drawn[w.draw[k]];
          // A game is read from its first-listed bloc's side: that team loses when u >= p.
          // Its opponent is the same draw read the other way, so two blocs on one game
          // can never both win.
          const lost = w.flip[k] ? (u < w.probability[k] ? 1 : 0) : u >= w.probability[k] ? 1 : 0;
          blocLost[b0 + k] = lost;
          if (lost) rate += w.share[k];
        }
        crowdLost[w0 + i] = w.probability.length ? blocLost[b0] : 0;
        lose[i] = rate;
      }
    } else {
      for (let i = 0; i < weeks; i += 1) {
        const lost = next() >= field.probabilities[i] ? 1 : 0;
        crowdLost[w0 + i] = lost;
        lose[i] = lost ? base[i] + crowding : base[i];
      }
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
  return {
    weeks, lossesAllowed, seasons, crowdLost, rivalBefore, rivalAt,
    ...(bloc ? { blocs: field.blocs, blocLost, blocWidth: bloc.width } : {}),
  };
}

/**
 * The per-week arithmetic of a bloc field, worked out once rather than per season.
 *
 * Draws are laid out by GAME, in the order `field.events` lists the week's slate, so a
 * bloc's result is the same uniform whichever other blocs exist. That keeps comparisons
 * fair: two fields over the same schedule -- one knowing this week's picks, one not --
 * are scored over the same seasons, and a difference between them is the picks, not the
 * dice. A bloc on the other side of a game reads that game's draw the other way (`flip`),
 * holding the complement of the first side's probability.
 */
function blocSchedule(field: Field, weeks: number) {
  const blocs = field.blocs ?? [];
  let width = 1;
  let most = 1;
  const out = [];
  for (let i = 0; i < weeks; i += 1) {
    const list = blocs[i] ?? [];
    width = Math.max(width, list.length);
    // Every game on the slate gets a draw; games no bloc is on are drawn and ignored.
    const order = new Map<string, number>();
    for (const id of field.events?.[i] ?? []) if (!order.has(id)) order.set(id, order.size);
    const anchor = new Map<string, number>();
    const probability: number[] = [];
    const share: number[] = [];
    const draw: number[] = [];
    const flip: boolean[] = [];
    for (const b of list) {
      if (!order.has(b.eventId)) order.set(b.eventId, order.size);
      const first = anchor.get(b.eventId);
      if (first === undefined) anchor.set(b.eventId, b.probability);
      // The second side of a game is decided by the first side's draw and probability,
      // so the two are exact complements even if their priced odds do not quite sum to 1.
      probability.push(first === undefined ? b.probability : first);
      flip.push(first !== undefined);
      share.push(blocShare(b, field.crowding));
      draw.push(order.get(b.eventId)!);
    }
    // More on blocs than there are rivals can only be a read error upstream; scale it
    // back rather than let a rival lose with probability above one.
    const onBlocs = share.reduce((a, b) => a + b, 0);
    const scale = onBlocs > 1 ? 1 / onBlocs : 1;
    for (let k = 0; k < share.length; k += 1) share[k] *= scale;
    const rest = Math.max(0, 1 - onBlocs * scale);
    const restP = field.restProbabilities?.[i] ?? field.probabilities[i] ?? 1;
    most = Math.max(most, order.size);
    out.push({ probability, share, draw, flip, draws: order.size, restLose: rest * (1 - restP) });
  }
  return { weeks: out, width, drawn: new Float64Array(most) };
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
  // Against a bloc field you share a result with whichever bloc is on your team -- or
  // hold the opposite one, when a bloc is on the team you are playing. -1 is a week
  // your game is nobody else's.
  const { blocs, blocLost, blocWidth = 1 } = prepared;
  const follow = new Int32Array(weeks).fill(-1);
  const invert = new Uint8Array(weeks);
  if (blocs && blocLost && line.teams) {
    for (let i = 0; i < weeks; i += 1) {
      const team = line.teams[i];
      if (!team) continue;
      const list = blocs[i] ?? [];
      const same = list.findIndex((b) => b.team === team);
      const against = same < 0 ? list.findIndex((b) => b.opponent === team) : -1;
      follow[i] = same >= 0 ? same : against;
      invert[i] = against >= 0 ? 1 : 0;
    }
  }

  let total = 0;
  for (let s = 0; s < seasons; s += 1) {
    const w0 = s * weeks;
    if (blocs && blocLost && line.teams) {
      for (let i = 0; i < weeks; i += 1) {
        const k = follow[i];
        if (k < 0) lose[i] = solo[i];
        else {
          const lost = blocLost[(w0 + i) * blocWidth + k];
          lose[i] = invert[i] ? 1 - lost : lost;
        }
      }
    } else {
      for (let i = 0; i < weeks; i += 1) {
        // On a shared week your result IS the crowd's; otherwise it is your own game.
        lose[i] = line.shared[i] ? crowdLost[w0 + i] : solo[i];
      }
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
