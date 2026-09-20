/**
 * Two legs of one football game, priced together.
 *
 * A same-game parlay is not several bets. It is one final score, asked several
 * questions. Multiplying the legs' separate probabilities — which is what a naive
 * calculator does — answers a question nobody asked: what if this game were played
 * twice, independently, once for each leg.
 *
 * The error is not small and it does not have a fixed sign. "Home wins AND the game
 * goes over" and "home wins AND home scores 24+" are wrong in opposite directions, and
 * a builder that got the direction backwards would recommend precisely the parlays the
 * book is happiest to take.
 *
 * ## What every leg here has in common
 *
 * Every market in this file resolves off two numbers and no others: the margin
 * `D = home − away` and the total `S = home + away`. Team totals are not a third thing
 * — home points are `(S + D) / 2` and away points `(S − D) / 2`, so a team total is a
 * diagonal line through the plane a spread and a total already live in. That is why
 * they can be priced together at all, and it is also the sharpest case: even if `D` and
 * `S` were perfectly independent, a home team total and a home spread would still be
 * strongly related, because they are two readings of one pair. Measured on seven
 * seasons, that construction correlation is **0.70 in the NFL** and **0.73 in college**
 * — far larger than the correlation between `D` and `S` itself.
 *
 * So every leg becomes a half-plane, `aD·D + aS·S > c`, and a parlay becomes the region
 * where those half-planes overlap. Alternate lines need no special handling: a leg
 * carries its own number, and the priced line only enters when converting to residuals.
 *
 * ## Where the distribution comes from
 *
 * The margin keeps its **empirical** distribution — the fitted pmf on the half-point
 * grid, the same one every other page uses. This matters more than it may look. NFL
 * margins pile up on 3 and 7, and a normal curve smooths those lumps away; a parlay leg
 * sitting on a key number is exactly where that smoothing would cost real money.
 *
 * The total is normal, from `score_models`. There is no empirical pmf for it, and
 * totals have nothing like the margin's key numbers, so the cost is small — but it is
 * an assumption rather than a measurement, and it belongs in the open.
 *
 * The two are joined by a Gaussian copula at the measured correlation. That is exact
 * when both marginals are normal and an approximation when one is lumpy, as the margin
 * is. The approximation is doing very little work here: the measured correlation is
 * **+0.002 in the NFL** (2,020 games, a twentieth of a standard error from zero) and
 * **+0.095 in college**. A distortion of a number that small stays small. The
 * correlation that actually moves parlay prices is the construction kind described
 * above, and that one is arithmetic, not a fit.
 *
 * ## What is not here
 *
 * Player props. Nothing in this database holds a player line, and a receiving total is
 * not a function of `D` and `S`. A parlay touching one has to be refused, not estimated
 * — an invented number here would look exactly like a measured one.
 */
import { type MarginModel, normalCdf, residualTails } from "./probability.ts";
import { probit } from "./stats.ts";

/** How the final score scatters around the market's two numbers, per league. */
export interface ScoreModel {
  league: string;
  games: number;
  totalMean: number;
  totalSd: number;
  marginMean: number;
  marginSd: number;
  /** Pearson correlation of the two residuals. Measured, and usually near zero. */
  correlation: number;
}

/** The market's own numbers for the game every leg is drawn from. */
export interface GameLines {
  /** The home side's spread, negative when home is favoured. */
  homeSpread: number;
  total: number;
}

export type ScoreLeg =
  | { market: "spread"; side: "home" | "away"; line: number }
  | { market: "moneyline"; side: "home" | "away" }
  | { market: "total"; side: "over" | "under"; line: number }
  | { market: "team_total"; team: "home" | "away"; side: "over" | "under"; line: number };

/** A leg as a half-plane: it wins when `aD·D + aS·S > c`. */
export interface Constraint {
  aD: number;
  aS: number;
  c: number;
}

/**
 * The half-plane a leg wins in.
 *
 * A spread's `line` is that side's own number, the way a bet slip prints it: the home
 * leg of a home −3.5 is `{ side: "home", line: -3.5 }` and the away leg is
 * `{ side: "away", line: 3.5 }`.
 */
export function constraintFor(leg: ScoreLeg): Constraint {
  switch (leg.market) {
    case "spread":
      // Home covers when D + line > 0; away covers when −D + line > 0.
      return leg.side === "home"
        ? { aD: 1, aS: 0, c: -leg.line }
        : { aD: -1, aS: 0, c: -leg.line };
    case "moneyline":
      return leg.side === "home" ? { aD: 1, aS: 0, c: 0 } : { aD: -1, aS: 0, c: 0 };
    case "total":
      return leg.side === "over"
        ? { aD: 0, aS: 1, c: leg.line }
        : { aD: 0, aS: -1, c: -leg.line };
    case "team_total": {
      // Home points are (S + D)/2 and away points (S − D)/2, so doubling clears the
      // halves and leaves a plain line through the same two numbers.
      const sign = leg.side === "over" ? 1 : -1;
      const dSign = leg.team === "home" ? 1 : -1;
      return { aD: sign * dSign, aS: sign, c: sign * 2 * leg.line };
    }
  }
}

export interface GridPoint {
  /** Margin residual, on the half-point grid. */
  m: number;
  mass: number;
  /** Latent standard normal for the copula, by the mid-distribution transform. */
  z: number;
}

/** How far past the observed range the normal continuation is carried. */
const TAIL_SDS = 6;

/**
 * The margin residual as one complete half-point grid, empirical inside the fitted
 * range and normal beyond it.
 *
 * The pmf covers only what was observed. Stopping there would make every leg outside
 * that range impossible, so the tails continue as a normal — and are rescaled to weigh
 * exactly what `residualTails` says they should, which keeps the grid summing to one and
 * keeps this consistent with `residualAbove` rather than merely close to it.
 *
 * Each point also carries its copula latent, taken at the middle of its probability
 * interval. A point's latent has to stand for the whole half-point it represents; the
 * midpoint is the usual choice and the only one that leaves the marginal untouched.
 */
export function marginGrid(model: MarginModel): GridPoint[] {
  if (!(model.sd > 0)) return [];
  const { low, high, interior } = residualTails(model);

  const masses = new Map<number, number>();
  for (const [key, mass] of Object.entries(model.pmf)) {
    const m = Number(key) / 2;
    if (!Number.isFinite(m) || mass <= 0) continue;
    masses.set(m, (masses.get(m) ?? 0) + mass * interior);
  }

  // The continuation, one half-point at a time, then scaled to the tail weight the body
  // was already shrunk to leave room for.
  const addTail = (from: number, to: number, weight: number) => {
    if (weight <= 0 || !(to > from)) return;
    const points: Array<{ m: number; raw: number }> = [];
    let raw = 0;
    for (let m = Math.ceil(from * 2) / 2; m <= to + 1e-9; m += 0.5) {
      const piece =
        normalCdf((m + 0.25 - model.mean) / model.sd) -
        normalCdf((m - 0.25 - model.mean) / model.sd);
      if (piece > 0) {
        points.push({ m, raw: piece });
        raw += piece;
      }
    }
    if (raw <= 0) return;
    for (const point of points) {
      masses.set(point.m, (masses.get(point.m) ?? 0) + (point.raw / raw) * weight);
    }
  };
  addTail(model.mean - TAIL_SDS * model.sd, model.lo - 0.5, low);
  addTail(model.hi + 0.5, model.mean + TAIL_SDS * model.sd, high);

  const grid = [...masses.entries()]
    .map(([m, mass]) => ({ m, mass }))
    .sort((a, b) => a.m - b.m);

  const total = grid.reduce((sum, point) => sum + point.mass, 0);
  if (!(total > 0)) return [];

  let below = 0;
  return grid.map(({ m, mass }) => {
    const normalized = mass / total;
    const mid = below + normalized / 2;
    below += normalized;
    return { m, mass: normalized, z: probit(Math.min(1 - 1e-12, Math.max(1e-12, mid))) };
  });
}

export interface JointResult {
  /** Every leg wins outright. */
  win: number;
  /** No leg loses, but at least one lands exactly on its number. */
  push: number;
  /** At least one leg loses. */
  loss: number;
  /** Whether any leg could land on its number at all. */
  pushPossible: boolean;
}

/**
 * P(all of these legs win), from one scoreline.
 *
 * Walks the margin grid. For a fixed margin every leg is either already decided (a
 * spread or a moneyline) or becomes a plain bound on the total, so the legs collapse to
 * one interval and the conditional normal reads its probability off directly. Summing
 * over the grid is then exact for this model — no simulation, no sampling error, and the
 * same answer every time it is asked, which matters for something that has to be
 * testable.
 *
 * Pushes are counted rather than assumed away. The whole calculation runs twice, once
 * with each leg needing to clear its number and once with landing on it allowed; the
 * difference is the probability that nothing lost and something pushed. A pushed leg
 * drops out of a parlay and the rest reprice, so a caller that silently treated a push
 * as a loss would understate a −3 leg against a −3.5 one — exactly the comparison a
 * builder exists to make.
 */
export function jointProbability(
  margin: MarginModel,
  score: ScoreModel,
  lines: GameLines,
  legs: ScoreLeg[],
): JointResult | null {
  if (legs.length === 0) return null;
  if (!(score.totalSd > 0) || !(margin.sd > 0)) return null;
  if (!Number.isFinite(lines.homeSpread) || !Number.isFinite(lines.total)) return null;

  const grid = marginGrid(margin);
  if (grid.length === 0) return null;

  const rho = Math.max(-0.999999, Math.min(0.999999, score.correlation));
  const conditionalSd = Math.sqrt(1 - rho * rho);

  // D = M − homeSpread and S = total + T, so aD·D + aS·S > c becomes a condition on the
  // two residuals alone.
  const constraints = legs.map((leg) => {
    const { aD, aS, c } = constraintFor(leg);
    return { aD, aS, threshold: c + aD * lines.homeSpread - aS * lines.total };
  });

  const zOf = (t: number) => (t - score.totalMean) / score.totalSd;

  const sweep = (strict: boolean): number => {
    let acc = 0;
    for (const point of grid) {
      let lower = -Infinity;
      let upper = Infinity;
      let decided = true;
      for (const { aD, aS, threshold } of constraints) {
        const remaining = threshold - aD * point.m;
        if (aS === 0) {
          // Settled by the margin alone. Strict asks it to clear the number; weak lets
          // it land on it, which is the push.
          const clears = strict ? remaining < -1e-9 : remaining < 1e-9;
          if (!clears) {
            decided = false;
            break;
          }
        } else if (aS > 0) {
          lower = Math.max(lower, remaining / aS);
        } else {
          upper = Math.min(upper, remaining / aS);
        }
      }
      if (!decided || !(upper > lower)) continue;

      // The total is continuous, so its own boundary carries no mass and strict and
      // weak agree there.
      const mean = rho * point.z;
      const hi = upper === Infinity ? 1 : normalCdf((zOf(upper) - mean) / conditionalSd);
      const lo = lower === -Infinity ? 0 : normalCdf((zOf(lower) - mean) / conditionalSd);
      if (hi > lo) acc += point.mass * (hi - lo);
    }
    return Math.max(0, Math.min(1, acc));
  };

  const win = sweep(true);

  // When no leg can land on its number, mass sitting exactly on a boundary is an
  // artefact rather than a push. The fitted pmf pools whole-number and half-point lines
  // into one half-point grid, so a game priced at −3 still shows mass on residuals its
  // own margin can never produce. Counting that as a push would invent a refund.
  const pushPossible = legs.some(pushable);
  if (!pushPossible) return { win, push: 0, loss: Math.max(0, 1 - win), pushPossible };

  const noLoss = sweep(false);
  return {
    win,
    push: Math.max(0, noLoss - win),
    loss: Math.max(0, 1 - noLoss),
    pushPossible,
  };
}

/** Whether a leg can land exactly on its number. */
export function pushable(leg: ScoreLeg): boolean {
  switch (leg.market) {
    // A tie pushes the moneyline. College has no ties, but the margin model does not
    // need telling: a league that cannot tie simply has no mass there.
    case "moneyline":
      return true;
    case "spread":
    case "total":
      return Number.isInteger(leg.line);
    // Team points are whole numbers, so a whole-number team total can land on it.
    case "team_total":
      return Number.isInteger(leg.line);
  }
}

/**
 * What multiplying the legs would have said.
 *
 * Kept so the builder can show the gap rather than assert it. The whole claim of this
 * file is that the product is wrong; a number that ends up next to a dollar figure
 * should be checkable against the thing it replaced.
 */
export function independentProduct(
  margin: MarginModel,
  score: ScoreModel,
  lines: GameLines,
  legs: ScoreLeg[],
): number | null {
  let product = 1;
  for (const leg of legs) {
    const single = jointProbability(margin, score, lines, [leg]);
    if (single === null) return null;
    product *= single.win;
  }
  return product;
}
