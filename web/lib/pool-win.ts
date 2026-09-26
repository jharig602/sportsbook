import { lastStandingWin, prepareField, type PreparedField } from "./last-standing";
import { fieldState } from "./pools";
import { aliveCurve } from "./pool-odds";
import {
  buildPlan,
  refineForLives,
  type Candidate,
  type Pick,
  type Plan,
  type Week,
} from "./survivor";

/**
 * What a survivor plan is worth against a field that is not picking independently.
 *
 * `poolOdds` estimates the win chance as `your survival / (1 + expected rivals alive)`,
 * which quietly assumes every rival is running their own uncorrelated season. They are
 * not. Survivor entrants converge on the same team — the popularity feed had 27.6% of
 * the field on one side in week 1 — and that correlation is not a rounding detail. It
 * is most of the answer.
 *
 * The reason is that a pool pays the last entrant standing, so what you are buying is
 * not survival but SEPARATION. Take the crowd's team and you live or die with them:
 * the weeks you win, you win alongside everyone who shares the ticket, and the pool is
 * no closer to being decided. Take a different team and the weeks the crowd loses are
 * weeks you gain the whole field.
 *
 * Measured on the live 18-week plan, with the field crowding at the rate the
 * popularity feed actually reports:
 *
 *     crowding    Pool A (13)               Pool B (137)
 *                 plan    greedy   edge     plan    greedy   edge
 *        0%       4.79%   4.59%    1.04x    0.76%   0.73%    1.04x
 *       30%       3.83%   2.88%    1.33x    0.51%   0.31%    1.67x
 *       60%       3.30%   1.54%    2.15x    0.58%   0.13%    4.35x
 *
 * The 0% row is the check that this reduces to the old model: 1.04x is exactly the
 * ratio of the two survival numbers (7.04% / 6.74%), which is all the previous
 * estimate could ever see. Everything above that row is the part it was blind to.
 *
 * Note also which way the pool size cuts. The bigger pool rewards separation MORE, not
 * less — the opposite of what the previous single-week model concluded, because a
 * single week cannot see that the crowd's losses accumulate.
 *
 * That earlier model is worth recording rather than just deleting, because its central
 * measurement stands and only its conclusion was too narrow. Checked against real
 * week-1 numbers: the Chargers at 80% and 27.6% popular against Philadelphia at 68.3%
 * and 3.3%, going contrarian trimmed the surviving field by 6% and your own survival by
 * 15%. The chalk won at every pool size from 13 to 100,000. That remains true for ONE
 * week in isolation — and this module still returns the chalk in that situation. What
 * it adds is the eighteen weeks after it, where the crowd's shared losses pile up and
 * the arithmetic turns.
 */

/** How the rest of the pool is assumed to behave. */
export interface Field {
  /**
   * The crowd's win probability each week: the best team still available to someone
   * picking greedily. This is what most entrants actually play.
   */
  probabilities: number[];
  /**
   * Share of the field on the crowd's team in any given week, 0-1.
   *
   * Re-drawn each week rather than fixed for the season, because entrants converge on
   * a team, not on a strategy: the 27% who took the Chargers in week 1 are not the
   * same 27% who take the favourite in week 9. Modelling one permanent bloc instead
   * roughly doubles the measured edge, which is why it is not modelled that way.
   */
  crowding: number;
}

/**
 * Above this many weeks where your plan departs from the crowd, the exact enumeration
 * below gets expensive (it is 2^n). Past the cap the extra weeks are scored as though
 * the field were uncorrelated in them, which understates the edge rather than
 * inventing one.
 */
const MAX_SOLO_WEEKS = 14;

/** Seasons for the sensitivity search. A crossover is a threshold, not a level. */
const CROSSOVER_SEASONS = 3000;

/** E[1/(1+K)] for K ~ Binomial(rivals, q). Closed form; no loop, no sampling. */
export function shareOfPot(rivals: number, q: number): number {
  if (rivals <= 0) return 1;
  if (q <= 0) return 1;
  if (q >= 1) return 1 / (rivals + 1);
  return (1 - Math.pow(1 - q, rivals + 1)) / ((rivals + 1) * q);
}

/** One season as this model scores it: your weekly odds, and where you share them. */
export interface ScoredLine {
  mine: number[];
  shared: boolean[];
}

export interface PoolWinInput {
  /** Your plan's weekly win probabilities. */
  mine: number[];
  /** True in weeks where your pick IS the crowd's pick, so you share the outcome. */
  shared: boolean[];
  field: Field;
  lossesAllowed: number;
  /** Entrants including you. */
  poolSize: number;
}

/**
 * P(one rival survives), given which weeks the crowd's team lost.
 *
 * This runs once per enumerated branch — hundreds of times per candidate, tens of
 * thousands per page — so it is written to allocate nothing. The obvious version
 * (`probabilities.map(...)` into `aliveCurve`) builds a fresh array per week per
 * branch, and that allocation churn, not the arithmetic, was most of the render time.
 *
 * `baseLose[i]` is the part that does not depend on the branch: the chance this rival
 * loses in week i having NOT followed the crowd. Following adds the crowd's own result.
 * `dp` is caller-owned scratch, updated backwards so each step reads the previous
 * week's value before overwriting it.
 */
function rivalSurvival(
  baseLose: Float64Array,
  crowding: number,
  lost: boolean[],
  lossesAllowed: number,
  dp: Float64Array,
): number {
  dp.fill(0);
  dp[0] = 1;
  for (let i = 0; i < baseLose.length; i += 1) {
    const lose = lost[i] ? baseLose[i] + crowding : baseLose[i];
    const win = 1 - lose;
    for (let j = lossesAllowed; j >= 0; j -= 1) {
      const here = dp[j];
      if (here === 0) continue;
      // Anything past the allowance is elimination, and simply drops out of the sum.
      if (j + 1 <= lossesAllowed) dp[j + 1] += here * lose;
      dp[j] = here * win;
    }
  }
  let total = 0;
  for (let j = 0; j <= lossesAllowed; j += 1) total += dp[j];
  return total;
}

/** Distribution of your own losses across the weeks you are NOT on the crowd's team. */
function soloLossDistribution(probs: number[], cap: number): number[] {
  let dp = new Array(cap + 2).fill(0);
  dp[0] = 1;
  for (const p of probs) {
    const next = new Array(cap + 2).fill(0);
    for (let j = 0; j <= cap + 1; j += 1) {
      if (dp[j] === 0) continue;
      if (j > cap) {
        next[j] += dp[j];
        continue;
      }
      next[j] += dp[j] * p;
      next[j + 1] += dp[j] * (1 - p);
    }
    dp = next;
  }
  return dp;
}

/**
 * P(you take the pool), summed exactly over how the crowd's season could go.
 *
 * Exact rather than simulated, by the same reasoning as `aliveCurve`: this is a number
 * that gets compared against another number, and sampling noise in it would read as a
 * difference between plans.
 *
 * The enumeration is small because most of it is dead weight. In a week you share with
 * the crowd, their loss is your loss, so any branch where they lose more often than
 * your lives allow contributes exactly zero and is never built. That leaves
 * `C(shared, 0..lives) x 2^solo` branches — about 800 for a typical plan, not 2^18.
 */
export function poolWin(input: PoolWinInput): number {
  const { mine, shared, field, lossesAllowed, poolSize } = input;
  const weeks = mine.length;
  if (weeks === 0) return 0;
  const rivals = Math.max(0, poolSize - 1);

  const sharedIdx: number[] = [];
  const soloIdx: number[] = [];
  for (let i = 0; i < weeks; i += 1) (shared[i] ? sharedIdx : soloIdx).push(i);

  // A shared week is the same team on the same game, so the two probabilities are the
  // same number and the branch below rightly uses one Bernoulli for both. If they
  // disagree, the caller has mislabelled a week — and the cost of letting that pass is
  // a plausible-looking win probability computed against somebody else's season.
  for (const i of sharedIdx) {
    if (Math.abs(mine[i] - field.probabilities[i]) > 1e-9) {
      throw new Error(
        `week ${i + 1} is marked shared with the crowd but the probabilities differ ` +
          `(${mine[i]} vs ${field.probabilities[i]}); shared means the same team.`,
      );
    }
  }

  // Past the cap, treat the surplus weeks as uncorrelated for the field: they keep
  // their own probability but stop contributing a common shock.
  const enumerated = soloIdx.slice(0, MAX_SOLO_WEEKS);
  const flattened = soloIdx.slice(MAX_SOLO_WEEKS);

  const soloDist = soloLossDistribution(soloIdx.map((i) => mine[i]), lossesAllowed);

  // Branches over the shared weeks: only those you can actually survive.
  const sharedBranches: Array<{ weight: number; losses: number; lost: number[] }> = [];
  const buildShared = (at: number, weight: number, lost: number[]) => {
    if (lost.length > lossesAllowed) return;
    if (at === sharedIdx.length) {
      sharedBranches.push({ weight, losses: lost.length, lost: [...lost] });
      return;
    }
    const i = sharedIdx[at];
    const p = field.probabilities[i];
    buildShared(at + 1, weight * p, lost);
    lost.push(i);
    buildShared(at + 1, weight * (1 - p), lost);
    lost.pop();
  };
  buildShared(0, 1, []);

  let total = 0;
  const lostFlags: boolean[] = new Array(weeks).fill(false);

  // Hoisted out of the branch loop: the crowd-independent half of each week's loss
  // chance, and one reusable scratch buffer for the survival DP.
  const baseLose = new Float64Array(weeks);
  for (let i = 0; i < weeks; i += 1) {
    baseLose[i] = (1 - field.crowding) * (1 - field.probabilities[i]);
  }
  const dp = new Float64Array(lossesAllowed + 2);

  // Branches over the weeks you do not share: these move the field, never you.
  const walkSolo = (at: number, weight: number, onDone: (w: number) => void) => {
    if (at === enumerated.length) {
      onDone(weight);
      return;
    }
    const i = enumerated[at];
    const p = field.probabilities[i];
    lostFlags[i] = false;
    walkSolo(at + 1, weight * p, onDone);
    lostFlags[i] = true;
    walkSolo(at + 1, weight * (1 - p), onDone);
    lostFlags[i] = false;
  };

  for (const branch of sharedBranches) {
    // How often you clear the season given this many shared losses already banked.
    let youSurvive = 0;
    for (let j = 0; j + branch.losses <= lossesAllowed; j += 1) youSurvive += soloDist[j] ?? 0;
    if (youSurvive <= 0) continue;

    for (const i of sharedIdx) lostFlags[i] = false;
    for (const i of branch.lost) lostFlags[i] = true;
    // Flattened weeks carry no common shock: scored as though the crowd held.
    for (const i of flattened) lostFlags[i] = false;

    walkSolo(0, 1, (soloWeight) => {
      const q = rivalSurvival(baseLose, field.crowding, lostFlags, lossesAllowed, dp);
      total += branch.weight * soloWeight * youSurvive * shareOfPot(rivals, q);
    });
  }

  return total;
}

/**
 * How concentrated the field is, read off the popularity feed.
 *
 * The share on the team the crowd model actually plays — the biggest available
 * favourite — rather than the largest share in the table, because those are different
 * questions and only the first one is what `Field.crowding` means. Falls back to the
 * largest share when the crowd's team is missing from the feed, and to null when there
 * is no feed at all.
 *
 * Null is load-bearing. With no measurement there is no basis for assuming the field
 * converges, and the caller must fall back to crowding 0, which collapses this whole
 * model back to plain survival. Guessing a number here would manufacture an edge.
 */
export function crowdingFrom(
  popularity: Record<string, number>,
  crowdTeam: string | null,
): number | null {
  const shares = Object.values(popularity);
  if (shares.length === 0) return null;
  if (crowdTeam && popularity[crowdTeam] !== undefined) return popularity[crowdTeam];
  return Math.max(...shares);
}

/**
 * How much survival to trade for separation, in log-probability per shared week.
 *
 * Zero is the old plan: maximise survival and take whatever correlation comes with it.
 * Large values refuse the crowd's team at almost any cost. Neither end is right, and
 * the middle cannot be reasoned to — it depends on the pool size, the crowding rate and
 * how much worse the second-best team is that week. So the frontier is swept and each
 * point scored on the real objective.
 *
 * The range is chosen from what the numbers mean rather than by taste: 0.05 buys a
 * separation only when it costs under 5% of a week's log-probability, and 1.0 will give
 * up a team twice as likely to win. Beyond that the plan is no longer a plan.
 */
const SEPARATION_PENALTIES = [0, 0.02, 0.05, 0.1, 0.2, 0.35, 0.6, 1.0];

export interface PoolWinRanking {
  candidate: Candidate;
  /** P(take the pool) taking this team now, then planning optimally from next week. */
  poolWin: number;
  /** P(survive the season) on the same line. The number the page used to rank on. */
  survival: number;
  /** Share of the field on this team, when the popularity feed knows. */
  share: number | null;
  /** True when this is the team the crowd is modelled as playing. */
  isCrowdPick: boolean;
  /** The whole season that follows from taking this team now. */
  plan: Plan;
  /**
   * The scored line itself, kept so it can be re-scored at a different crowding rate
   * without re-planning the season. The plan does not depend on crowding — only what
   * it is worth does — so the sensitivity below is nearly free.
   */
  line: ScoredLine;
}

/**
 * How many of this week's teams to price properly.
 *
 * Each one costs a re-plan of the rest of the season, and the answer is never a team
 * the board has at 45%: separation is worth something, but not the game. Ranked by win
 * probability first, so this takes the genuine contenders and no more.
 */
const CONSIDER = 6;

/**
 * Rank this week's picks by what they are worth in the pool, not by how safe they are.
 *
 * For each candidate: take it now, re-plan the remaining season around having spent it,
 * and score the whole line against a field that crowds. That is the question a pool
 * actually asks, and it is not the same question the assignment solver answers — the
 * solver maximises survival, which is the right objective only when you are playing
 * the schedule rather than the other entrants.
 *
 * With `crowding` at 0 this returns the same order as ranking by survival, because
 * with an uncorrelated field there is nothing to separate from. That is the intended
 * degenerate case, and it is what runs when the popularity feed has nothing.
 */
/**
 * Walk the survival/separation frontier and keep the point that actually wins most.
 *
 * Each penalty gives a different exact assignment — the solver is still solving a
 * linear problem, just a differently-priced one — and each of those is a real, legal
 * season. Only then is the non-linear objective applied, to pick between them. That
 * keeps the exactness where the combinatorics live and the sampling where it belongs.
 */
function bestSeparationPenalty(
  planning: Week[],
  crowdPicks: (Candidate | null)[],
  prepared: PreparedField,
  options: {
    used: Set<string>;
    lossesAllowed: number;
    poolSize: number;
    pinned: Map<number, string>;
    myLosses: number;
  },
): number {
  const { used, lossesAllowed, poolSize, pinned, myLosses } = options;
  const livesLeft = Math.max(0, lossesAllowed - myLosses);
  const crowdByWeek = new Map<number, string>();
  planning.forEach((w, i) => {
    const team = crowdPicks[i]?.team;
    if (team) crowdByWeek.set(w.week, team);
  });

  let best = SEPARATION_PENALTIES[0];
  let bestScore = -1;
  for (const lambda of SEPARATION_PENALTIES) {
    const avoid = (week: number, team: string) =>
      team === (crowdByWeek.get(week) ?? null) ? lambda : 0;
    const plan = refineForLives(
      planning,
      buildPlan(planning, planning.length, used, new Map(), pinned, avoid),
      livesLeft,
      used,
      pinned,
    );
    const mine = plan.picks.map((p) => p.pick?.winProbability ?? 1);
    const shared = plan.picks.map(
      (p, i) => p.pick !== null && p.pick?.team === (crowdPicks[i]?.team ?? null),
    );
    if (mine.length !== prepared.weeks) continue;
    const score = lastStandingWin({ mine, shared }, prepared, poolSize, myLosses);
    if (score > bestScore) {
      bestScore = score;
      best = lambda;
    }
  }
  return best;
}

export function rankByPoolWin(
  weeks: Week[],
  options: {
    /** Teams this entry has already spent. */
    used?: Set<string>;
    /** Teams another entry has reserved this week, so two entries never share a game. */
    excludeThisWeek?: Set<string>;
    lossesAllowed: number;
    poolSize: number;
    crowding: number;
    popularity?: Record<string, number>;
    consider?: number;
    /**
     * Weeks fixed by hand. Later weeks constrain the re-plan behind every candidate;
     * a pin on the opening week instead guarantees that team is priced, however far
     * down the board it sits, so the page can show what choosing it would cost.
     */
    pinned?: Map<number, string>;
    /**
     * Rivals by losses already taken. Absent means an unbeaten field — true in week 1
     * and false every week after, so anything past the opener should pass it.
     */
    rivalLosses?: number[];
    /** Losses your own entry has taken; it plans on the lives it has left. */
    myLosses?: number;
  },
): PoolWinRanking[] {
  const { lossesAllowed, poolSize, crowding } = options;
  const myLosses = options.myLosses ?? 0;
  // What YOUR plan gets to absorb. The field's allowance stays `lossesAllowed`, with
  // each rival's own losses subtracted inside the simulation.
  const livesLeft = lossesAllowed - myLosses;
  const pinned = options.pinned ?? new Map<number, string>();
  const used = options.used ?? new Set<string>();
  const reserved = options.excludeThisWeek ?? new Set<string>();
  const popularity = options.popularity ?? {};

  // Filter once, up front, so week indices line up with the crowd's sequence. Leaving
  // it to buildPlan would silently offset the two by however many weeks are unpriced.
  const planning = weeks.filter((w) => w.candidates.length > 0);
  if (planning.length === 0) return [];

  // The crowd's season: the greedy line, which is what most entrants play. Built from
  // the full slate rather than from what YOU have spent — the field has its own
  // histories, and none of them are yours.
  const reference = buildPlan(planning);
  const crowdPicks = reference.greedyPicks;
  const crowdProbs = crowdPicks.map((c) => c?.winProbability ?? 1);
  const field: Field = { probabilities: crowdProbs, crowding };
  // The crowd's seasons and the rivals' exit distributions inside them do not depend on
  // which team you take, so they are built once here rather than per candidate.
  const prepared = prepareField(field, planning.length, lossesAllowed, undefined, options.rivalLosses);

  const crowdByWeek = new Map<number, string>();
  planning.forEach((w, i) => {
    const team = crowdPicks[i]?.team;
    if (team) crowdByWeek.set(w.week, team);
  });

  const opener = planning[0];
  const thisWeek = opener.candidates.filter((c) => !used.has(c.team) && !reserved.has(c.team));
  const rest = planning.slice(1);

  // The shortlist, plus whatever the opening week is pinned to. Without that second
  // part, pinning a team outside the top few would silently score nothing at all.
  const openerPin = pinned.get(opener.week);
  const considered = thisWeek.slice(0, options.consider ?? CONSIDER);
  if (openerPin !== undefined && !considered.some((c) => c.team === openerPin)) {
    const extra = thisWeek.find((c) => c.team === openerPin);
    if (extra) considered.push(extra);
  }

  // Which point on the survival/separation frontier this pool wants. Found once on the
  // unconstrained plan rather than per candidate: the best trade-off is a property of
  // the pool and the crowd, not of which team you happen to open with, and sweeping it
  // for every candidate multiplies the cost of the page by the length of the sweep.
  const lambda = bestSeparationPenalty(
    planning,
    crowdPicks,
    prepared,
    { used, lossesAllowed, poolSize, pinned, myLosses },
  );
  const avoid = (week: number, team: string) =>
    team === (crowdByWeek.get(week) ?? null) ? lambda : 0;

  const out: PoolWinRanking[] = [];
  for (const candidate of considered) {
    const excluded = new Set([...used, candidate.team]);
    const tail = refineForLives(
      rest,
      buildPlan(rest, rest.length, excluded, new Map(), pinned, avoid),
      Math.max(0, livesLeft),
      excluded,
      pinned,
    );

    const best = opener.candidates[0] ?? null;
    const picks: Pick[] = [
      {
        week: opener.week,
        startsAt: opener.startsAt,
        pick: candidate,
        greedy: best,
        sacrifice: best ? best.winProbability - candidate.winProbability : 0,
      },
      ...tail.picks,
    ];

    const teams = picks.map((p) => p.pick?.team ?? null);
    const mine = picks.map((p) => p.pick?.winProbability ?? 1);
    const shared = teams.map((team, i) => team !== null && team === (crowdPicks[i]?.team ?? null));

    // An entry already out survives nothing; aliveCurve has no state for "fewer than zero
    // lives" and would read past the end of its table rather than say so.
    const curve = livesLeft >= 0 ? aliveCurve(mine, livesLeft) : mine.map(() => 0);
    out.push({
      candidate,
      poolWin: lastStandingWin({ mine, shared }, prepared, poolSize, myLosses),
      survival: curve.length ? curve[curve.length - 1] : 1,
      share: popularity[candidate.team] ?? null,
      isCrowdPick: candidate.team === (crowdPicks[0]?.team ?? null),
      line: { mine, shared },
      plan: {
        picks,
        survival: mine.reduce((a, p) => a * p, 1),
        greedySurvival: reference.greedySurvival,
        greedyPicks: crowdPicks,
        weeksPlanned: picks.length,
        unplannedWeeks: weeks.length - planning.length,
      },
    });
  }

  return out.sort((a, b) => b.poolWin - a.poolWin);
}

/**
 * Does this week's pick survive changing how far ahead you look?
 *
 * The pool-win twin of `horizonStability`, and it has to exist rather than reuse it:
 * that one answers the question for the survival objective, and a page whose headline
 * pick comes from one objective while its stability card reports the other will
 * eventually contradict itself in public. Same reasoning as the original — a pick that
 * holds at four weeks and at eighteen is robust; one that moves is balanced on a
 * December line nobody has bet into, which is a reason to trust it less.
 */
export function poolWinStability(
  weeks: Week[],
  horizons: number[],
  options: {
    used?: Set<string>;
    lossesAllowed: number;
    poolSize: number;
    crowding: number;
    popularity?: Record<string, number>;
    rivalLosses?: number[];
    myLosses?: number;
  },
): Array<{ horizon: number; team: string | null }> {
  const priced = weeks.filter((w) => w.candidates.length > 0).length;
  const seen = new Set<number>();
  const out: Array<{ horizon: number; team: string | null }> = [];
  for (const horizon of horizons) {
    const capped = Math.min(Math.max(1, horizon), Math.max(1, priced));
    if (seen.has(capped)) continue;
    seen.add(capped);
    const ranked = rankByPoolWin(weeks.slice(0, capped), options);
    out.push({ horizon: capped, team: ranked[0]?.candidate.team ?? null });
  }
  return out.sort((a, b) => a.horizon - b.horizon);
}

/**
 * The crowding rate at which one pick overtakes another.
 *
 * Worth showing because the measured rate is a single weekly number assumed to hold
 * for the season, and the margin between the top two picks is often thin. "Philadelphia
 * is ahead" invites a confidence the input does not support; "Philadelphia is ahead
 * once the field is above 18% on one team, and it is measured at 28%" says how much
 * room the call actually has.
 *
 * Neither plan depends on the crowding rate — only what it is worth does — so both
 * lines are simply re-scored. Returns null when the order never changes anywhere in
 * [0, 1], which means the call does not hinge on this number at all.
 */
export function crossoverCrowding(
  challenger: ScoredLine,
  incumbent: ScoredLine,
  field: Field,
  lossesAllowed: number,
  poolSize: number,
  rivalLosses?: number[],
  myLosses = 0,
): number | null {
  // Scored on the same objective as the pick itself, but over far fewer seasons: this
  // is looking for the crowding rate where a sign flips, not for a level, and a
  // threshold tolerates noise a headline number would not. Both lines are measured
  // against the same seasons at each step, so the comparison stays clean.
  const weeks = challenger.mine.length;
  const gap = (crowding: number) => {
    const prepared = prepareField(
      { ...field, crowding }, weeks, lossesAllowed, CROSSOVER_SEASONS, rivalLosses,
    );
    return (
      lastStandingWin(challenger, prepared, poolSize, myLosses) -
      lastStandingWin(incumbent, prepared, poolSize, myLosses)
    );
  };
  // The sign at the low end is fixed, so take it once. Recomputing it inside the loop
  // costs two more scorings of an eighteen-week season every iteration, which is most
  // of the page's render time for a number displayed to the nearest percent.
  const low = Math.sign(gap(0));
  if (low === 0 || low === Math.sign(gap(1))) return null;

  let lo = 0;
  let hi = 1;
  // 2^-16 is far finer than the whole percentage point this is rendered at.
  for (let i = 0; i < 16; i += 1) {
    const mid = (lo + hi) / 2;
    if (Math.sign(gap(mid)) === low) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

export interface PoolWinPlan {
  pool: PoolEntry;
  ranking: PoolWinRanking[];
  /** The season that follows from the top-ranked pick. */
  plan: Plan;
  /** What this entry is worth: P(take the pool). */
  poolWin: number;
  /**
   * The pick plain survival would have named, when it differs. Null when the two
   * objectives agree, which is most weeks and is worth saying out loud.
   */
  insteadOf: Candidate | null;
  /**
   * Teams this entry could not use this week because an earlier entry took them.
   *
   * Reported because the constraint is otherwise invisible and its effects are not:
   * changing one entry's pick silently moves another's, and which entry wins a
   * contested team depends only on the order the pools happen to be stored in. A plan
   * that changes for a reason the page never states reads as a bug, and did.
   */
  keptOff: string[];
  /**
   * How crowded the field has to be for the top pick to beat the safest one. Null when
   * the order holds across every crowding rate, so the call does not depend on it.
   */
  crossover: number | null;
  /** The crowding this pool was actually planned against: its own, or the national feed. */
  crowding: number;
}

export interface PoolEntry {
  /** Display only. Absent means the caller derives it from the size. */
  name?: string;
  used: string[];
  size?: number;
  lossesAllowed?: number;
  /**
   * Weeks fixed by hand on this entry, week number to team.
   *
   * Per entry rather than global because the two pools hold different teams and are
   * asking different questions; a pin is a what-if about one of them.
   */
  pinned?: Map<number, string>;
  /** Entrants alive by losses already taken, you included. See `StoredPool.field`. */
  field?: number[];
  /** Losses your own entry has taken. */
  myLosses?: number;
  /** This pool's own herding, measured from its sheets. See `StoredPool.crowd`. */
  crowd?: { top: number; picks: number };
}

/**
 * How crowded THIS pool is, from its own picks blended with the national feed.
 *
 * The pool's own measurement wins as it accumulates, but never all at once: the national
 * figure counts as one more week of this pool, at its current size. Two weeks of an
 * 11-entry pool is 22 picks, and one of those weeks had 7 of 11 on Tampa Bay -- enough to
 * say this pool herds, not enough to let a single week set the number. For the 141-entry
 * pool the same rule barely moves its own 37%, because 282 picks outweigh one week.
 *
 * With no national figure measured, the pool's own ratio stands alone; with no pool
 * measurement, the national figure does. Neither case invents anything.
 */
export function poolCrowding(
  pool: { crowd?: { top: number; picks: number }; size?: number; field?: number[] },
  national: number,
  nationalMeasured: boolean,
): number {
  const crowd = pool.crowd;
  if (!crowd || !(crowd.picks > 0)) return national;
  const own = Math.min(1, Math.max(0, crowd.top / crowd.picks));
  if (!nationalMeasured) return own;
  const weight = Math.max(1, pool.field?.length ? pool.field.reduce((a, b) => a + b, 0) : pool.size ?? 1);
  return (crowd.top + weight * national) / (crowd.picks + weight);
}

/**
 * Plan every entry on the pool-win objective, keeping them off each other's games.
 *
 * Mirrors `buildPlans`, including the part that matters most about it: only the
 * CURRENT week is reserved across entries. Two entries on the same team this week is
 * one bet paid for twice, and that is the only risk a second entry exists to avoid —
 * constraining December as well would cost real probability to insure against
 * something that re-planning next week removes anyway.
 */
export function buildPoolWinPlans(
  weeks: Week[],
  pools: PoolEntry[],
  options: {
    crowding: number;
    popularity?: Record<string, number>;
    /**
     * Whether `crowding` came from the feed or is the zero standing in for "unknown".
     * Needed so a pool's own measurement can stand alone when the feed is empty instead
     * of being blended toward a zero nobody measured.
     */
    crowdingMeasured?: boolean;
  },
): PoolWinPlan[] {
  const reservedThisWeek = new Set<string>();
  const out: PoolWinPlan[] = [];

  const openerCandidates = weeks.find((w) => w.candidates.length > 0)?.candidates ?? [];
  const thisWeekTeams = new Set(openerCandidates.map((c) => c.team));

  for (const pool of pools) {
    const used = new Set(pool.used);
    const lossesAllowed = pool.lossesAllowed ?? 0;
    const pinned = pool.pinned ?? new Map<number, string>();
    // The field as recorded, with you taken out of your own bucket. The pool size the
    // model sees is the rivals still alive plus you -- not entrants who have already
    // gone out, who are nobody's rival any more.
    const state = fieldState(pool);
    const poolSize = state.rivals + 1;
    // Each pool's own herding when its sheets have been read, the national feed when not.
    const crowding = poolCrowding(pool, options.crowding, options.crowdingMeasured ?? options.crowding > 0);
    const ranking = rankByPoolWin(weeks, {
      used,
      excludeThisWeek: reservedThisWeek,
      lossesAllowed,
      poolSize,
      crowding,
      popularity: options.popularity,
      pinned,
      rivalLosses: state.rivalLosses,
      myLosses: state.myLosses,
    });

    // A pin on the opening week overrides the ranking: you asked for that team, so the
    // plan is built on it. The ranking is still returned in full, so the page can show
    // what it cost rather than just obeying.
    const openerWeek = weeks.find((w) => w.candidates.length > 0)?.week;
    const openerPin = openerWeek === undefined ? undefined : pinned.get(openerWeek);
    const top =
      (openerPin !== undefined
        ? ranking.find((r) => r.candidate.team === openerPin)
        : undefined) ??
      ranking[0] ??
      null;
    // What surviving alone would have chosen, for the page to show the disagreement.
    const safest = [...ranking].sort((a, b) => b.survival - a.survival)[0] ?? null;

    const crowd = top?.plan.greedyPicks ?? [];
    out.push({
      pool,
      ranking,
      crowding,
      crossover:
        top && safest && safest.candidate.team !== top.candidate.team
          ? crossoverCrowding(
              top.line,
              safest.line,
              { probabilities: crowd.map((c) => c?.winProbability ?? 1), crowding },
              lossesAllowed,
              poolSize,
              state.rivalLosses,
              state.myLosses,
            )
          : null,
      plan: top?.plan ?? {
        picks: [],
        survival: 0,
        greedySurvival: 0,
        greedyPicks: [],
        weeksPlanned: 0,
        unplannedWeeks: weeks.length,
      },
      poolWin: top?.poolWin ?? 0,
      insteadOf:
        top && safest && safest.candidate.team !== top.candidate.team ? safest.candidate : null,
      // Only the teams that were actually playable for this entry: a team it had already
      // spent was never available, and naming it would explain the wrong thing.
      keptOff: [...reservedThisWeek].filter(
        (team) => !used.has(team) && thisWeekTeams.has(team),
      ),
    });

    if (top) reservedThisWeek.add(top.candidate.team);
  }

  return out;
}
