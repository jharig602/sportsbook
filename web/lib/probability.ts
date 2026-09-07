/**
 * Turning prices and spreads into probabilities.
 *
 * Two independent estimates, and the interesting part is where they disagree:
 *
 * **Market probability** — de-vigged from the two-sided price. This is the book's own
 * opinion with its margin removed. It is not a prediction of ours and needs no model.
 *
 * **Model probability** — from the fitted distribution of residuals (`margin + spread`)
 * over past seasons. It answers "given this spread, how often does this side actually
 * win outright?" without reference to the price.
 *
 * For a *spread*, the two agree by construction and both sit near 50% — that is what a
 * spread is for, and a predictor claiming otherwise would be lying. The useful case is
 * the **moneyline**: the spread implies a win probability, the moneyline states one,
 * and when they diverge, one side of that book's own board is mispriced relative to
 * the other. That is checkable today, with no forward data.
 */
import type { Market, Side } from "./types";

export interface MarginModel {
  league: string;
  games: number;
  mean: number;
  sd: number;
  lo: number;
  hi: number;
  /**
   * P(residual == k/2), keyed in **half-point units** as a string.
   * Most spreads are half-points, so half-points are the natural grid: it is
   * what makes 'a half-point line cannot push' fall out for free.
   */
  pmf: Record<string, number>;
}

/** Break-even probability implied by an American price, vig included. */
export function impliedProbability(price: number | null | undefined): number | null {
  if (price === null || price === undefined || Math.abs(price) < 100) return null;
  const decimal = price > 0 ? 1 + price / 100 : 1 + 100 / -price;
  return 1 / decimal;
}

/**
 * Strip the bookmaker's margin from a two-sided market.
 *
 * Multiplicative de-vig: the two raw implied probabilities sum to more than 1, and the
 * excess is the book's margin. Splitting it proportionally is the standard baseline.
 * It is a choice, not a truth — favourite-longshot bias means the margin is probably
 * not shared evenly — which is why the raw hold is reported alongside.
 */
export function deVig(
  priceA: number | null,
  priceB: number | null,
): { a: number; b: number; hold: number } | null {
  const rawA = impliedProbability(priceA);
  const rawB = impliedProbability(priceB);
  if (rawA === null || rawB === null) return null;

  const total = rawA + rawB;
  if (total <= 0) return null;
  return { a: rawA / total, b: rawB / total, hold: total - 1 };
}

export function normalCdf(z: number): number {
  // Abramowitz-Stegun 7.1.26 via erf approximation; plenty for display precision.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p =
    d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

/**
 * How the empirical body and the normal tails are combined.
 *
 * The fitted pmf already sums to 1 over the observed range, so adding a tail on top of
 * it double-counts and pushes total probability past 1 — which showed up as a pick'em
 * reading 57% instead of 50%. The body is scaled down to leave room for the tails
 * instead, so the three pieces sum to exactly 1.
 */
function tails(model: MarginModel): { low: number; high: number; interior: number } {
  const high = 1 - normalCdf((model.hi + 0.25 - model.mean) / model.sd);
  const low = normalCdf((model.lo - 0.25 - model.mean) / model.sd);
  return { low, high, interior: Math.max(0, 1 - low - high) };
}

/** P(residual > threshold), empirical inside the observed range, normal tails beyond. */
export function residualAbove(model: MarginModel, threshold: number): number {
  if (model.sd <= 0) return NaN;

  if (threshold >= model.hi) {
    return Math.max(0, Math.min(1, 1 - normalCdf((threshold - model.mean) / model.sd)));
  }
  if (threshold < model.lo) {
    return Math.max(0, Math.min(1, 1 - normalCdf((threshold - model.mean) / model.sd)));
  }

  const { high, interior } = tails(model);
  const cutoff = threshold * 2; // pmf keys are half-points
  let inside = 0;
  for (const [key, mass] of Object.entries(model.pmf)) {
    if (Number(key) > cutoff) inside += mass;
  }
  return Math.max(0, Math.min(1, inside * interior + high));
}

export function residualAt(model: MarginModel, value: number): number {
  const key = value * 2;
  // Off the half-point grid there is no mass at all — which is exactly why a
  // half-point line cannot push.
  if (!Number.isInteger(key)) return 0;
  // Scaled by the same interior factor as residualAbove, or the push mass and the
  // cover mass would be measured against different totals.
  return (model.pmf[String(key)] ?? 0) * tails(model).interior;
}

/**
 * The line the book actually believes, given what it charges for it.
 *
 * A posted spread is only the book's true opinion when both sides are priced evenly.
 * Houston posted at -1.5 but juiced +102 / -122 de-vigs to home covering just 47.4% of
 * the time — the book does not believe -1.5, it believes something nearer -0.7. Reading
 * the posted number literally overstated a 1-point favourite as a 1.5-point one and
 * manufactured a 6.6-point "edge" that two books, checked by hand, did not agree existed.
 *
 * Converts the excess cover probability into points using the residual density at the
 * line, which is the standard local-linear approximation and is accurate for the small
 * shifts that juice implies.
 */
export function effectiveSpread(
  model: MarginModel,
  postedSpread: number,
  coverProbability: number | null,
): number {
  if (coverProbability === null || model.sd <= 0) return postedSpread;

  // Density of the residual at zero, per point: the peak of a normal with this sd.
  const densityAtZero = 1 / (model.sd * Math.sqrt(2 * Math.PI));
  if (densityAtZero <= 0) return postedSpread;

  // At the book's true line the cover probability would be 50%. Posting a line the
  // market only covers `p` of the time means the true line sits (0.5 - p) / density
  // points away — toward zero when p < 0.5, further out when p > 0.5.
  const shiftPoints = (0.5 - coverProbability) / densityAtZero;
  const adjusted = postedSpread + shiftPoints;

  // Never let the adjustment flip the favourite; that would be reading noise as a
  // different opinion entirely.
  return Math.sign(postedSpread) === Math.sign(adjusted) || postedSpread === 0
    ? adjusted
    : 0;
}

/**
 * P(this side wins outright), derived from the spread alone.
 *
 * A side laying `spread` points wins when margin > 0, i.e. when the residual exceeds
 * the spread itself. Ties are removed from the denominator rather than split: an NFL
 * tie pushes the moneyline, and college football has no ties.
 */
export function winProbabilityFromSpread(
  model: MarginModel,
  homeSpread: number,
  side: Side,
  /**
   * Whether to assume the closing line is unbiased.
   *
   * The fitted residual has a non-zero mean — +1.40 points in college, +0.35 in the
   * NFL — meaning home teams beat the closing spread on average in the sample. Left in,
   * that tilt applies to *every* game equally, so the model disagrees with the market
   * in one direction everywhere: 34 of 40 "edges" favoured the home side and the top
   * ten were all home teams. That is one hypothesis about the market, not forty
   * opportunities, and dressing it as forty is how a systematic offset gets mistaken
   * for a list of bets.
   *
   * Centring removes it, so a remaining edge is specific to that game. The bias itself
   * is still worth testing — separately, once, as the single claim it is.
   */
  assumeUnbiased = true,
): number | null {
  if (model.sd <= 0) return null;
  // residual = margin + spread, so margin > 0 means residual > spread.
  const threshold = assumeUnbiased ? homeSpread + model.mean : homeSpread;
  const homeWins = residualAbove(model, threshold);
  const tie = residualAt(model, threshold);
  const decided = 1 - tie;
  if (decided <= 0) return null;
  const home = homeWins / decided;
  return side === "home" ? home : 1 - home;
}

/** (cover, push) for a spread quoted from the given side. */
export function coverProbability(
  model: MarginModel,
  lineForSide: number,
): { cover: number; push: number } | null {
  if (model.sd <= 0) return null;
  return { cover: residualAbove(model, 0), push: residualAt(model, 0) };
}

export interface LineProbability {
  /** De-vigged market opinion for this side, 0-1. */
  market: number | null;
  /** Model opinion where one exists. Null for markets the model cannot speak to. */
  model: number | null;
  /** model - market, in percentage points. Null when either is missing. */
  edgePoints: number | null;
  hold: number | null;
  note: string;
}

/**
 * Probability for one side of one market.
 *
 * The model deliberately declines on spreads and totals. A spread's cover probability
 * is ~50% by construction, and quoting a model number there would invite reading noise
 * as signal. Only the moneyline gets a second opinion, because only there does the
 * spread provide independent information about the same question.
 */
export function lineProbability(
  market: Market,
  side: Side,
  priceThisSide: number | null,
  priceOtherSide: number | null,
  homeSpread: number | null,
  model: MarginModel | null,
  /** De-vigged probability that the home side covers the posted spread, if known. */
  homeCoverProbability: number | null = null,
): LineProbability {
  const fair = deVig(priceThisSide, priceOtherSide);
  const marketProbability = fair ? fair.a : impliedProbability(priceThisSide);
  const hold = fair ? fair.hold : null;

  if (market !== "moneyline" || model === null || homeSpread === null) {
    return {
      market: marketProbability,
      model: null,
      edgePoints: null,
      hold,
      note:
        market === "spread"
          ? "A spread is set to be a coin flip; both sides sit near 50% by design."
          : market === "total"
            ? "Totals are priced to be a coin flip; the model has no independent view."
            : "No fitted model for this league yet.",
    };
  }

  // Use what the book charges for the spread, not just the number it posts.
  const trueSpread = effectiveSpread(model, homeSpread, homeCoverProbability);
  const modelProbability = winProbabilityFromSpread(model, trueSpread, side);
  const edgePoints =
    modelProbability !== null && marketProbability !== null
      ? (modelProbability - marketProbability) * 100
      : null;

  return {
    market: marketProbability,
    model: modelProbability,
    edgePoints,
    hold,
    note:
      `Spread implies this win rate from ${model.games} past games; moneyline states ` +
      `its own.` +
      (Math.abs(trueSpread - homeSpread) >= 0.25
        ? ` The posted ${homeSpread} is priced like ${trueSpread.toFixed(1)}.`
        : ""),
  };
}
