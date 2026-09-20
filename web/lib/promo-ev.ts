/**
 * What a promotion is worth, and the best way to spend it.
 *
 * A calculator and a calendar, not a handicapper. Every function here takes terms and
 * a price and returns money; none of them name a team. The output of the optimiser is
 * an odds range and a stake, because that is what the promo structure actually
 * supports — "the longest qualifying price you would take" is a rule, while "take the
 * Lions" is a claim about a game that nothing in this file can back.
 *
 * What costs money here is not choosing the wrong side. It is a token expiring unused,
 * or a refunded bonus bet sitting in the account until it lapses. `expiryState` and the
 * dashboard that sorts on it are the point; the formulas below are the supporting act.
 */
import { impliedProbability } from "./probability";
import { profitPerDollar } from "./profit-boost";

export type PromoType =
  | "stake_back"
  | "profit_boost"
  | "odds_boost"
  | "bonus_bet"
  | "deposit_match";

/**
 * What a dollar of bonus bet is really worth, as a fraction of face.
 *
 * A bonus bet keeps its stake, so it is worth far less than face — and how much less
 * depends entirely on where it is used. This default assumes it goes somewhere sensible;
 * it is a setting because a user who reliably puts refunds on long prices should raise
 * it, and one who dumps them on -150 favourites should lower it. Both are real habits,
 * and the difference between them is most of the value of a stake-back promo.
 */
export const DEFAULT_CONVERSION = 0.7;

/** Assumed two-way hold when only one side of a market is known. */
export const DEFAULT_TWO_WAY_HOLD = 0.045;

/** Typical hold on one parlay leg. Legs are usually priced worse than a standalone. */
export const DEFAULT_LEG_HOLD = 0.045;

/** Decimal odds from an American price. */
export function decimalFrom(american: number): number {
  return 1 + profitPerDollar(american);
}

/* --- fair probability ------------------------------------------------------------ */

export interface Devigged {
  /** Fair probability of the side asked about. */
  p: number;
  /** The book's margin on the pair. */
  hold: number;
  method: "multiplicative" | "shin" | "assumed";
  /** True when this came from one price plus an assumed hold, not a real pair. */
  estimated: boolean;
}

/**
 * Strip the book's margin from a two-way market.
 *
 * Multiplicative splits the margin in proportion to each side's price, which is the
 * standard reading and the one the rest of this app uses. Shin instead asks what
 * proportion of money is informed, and pushes more of the margin onto the longshot —
 * on a +600 they can differ by a couple of points of probability, which is enough to
 * flip a marginal promo's sign. Offering both is the honest way to say that a promo
 * whose verdict depends on the method has no verdict worth acting on.
 */
export function devigTwoWay(
  side: number,
  other: number,
  method: "multiplicative" | "shin" = "multiplicative",
): Devigged | null {
  const a = impliedProbability(side);
  const b = impliedProbability(other);
  if (a === null || b === null) return null;
  const total = a + b;
  if (!(total > 0)) return null;
  const hold = total - 1;
  if (method === "multiplicative" || hold <= 0) {
    return { p: a / total, hold, method: "multiplicative", estimated: false };
  }
  return { p: shinProbability(a, b), hold, method: "shin", estimated: false };
}

/**
 * Shin's fair probability for the first of two outcomes.
 *
 * Solved by bisection rather than a remembered closed form: the two-outcome formula is
 * short enough to look right while being wrong, and this runs a few dozen times per
 * page. The probabilities are increasing in z, so the sum crosses 1 exactly once.
 */
export function shinProbability(a: number, b: number): number {
  const total = a + b;
  const pAt = (z: number) => {
    const f = (x: number) =>
      (Math.sqrt(z * z + 4 * (1 - z) * ((x * x) / total)) - z) / (2 * (1 - z));
    return { a: f(a), b: f(b) };
  };
  let lo = 0;
  let hi = 0.999999;
  for (let i = 0; i < 80; i += 1) {
    const mid = (lo + hi) / 2;
    const at = pAt(mid);
    if (at.a + at.b > 1) lo = mid;
    else hi = mid;
  }
  const solved = pAt((lo + hi) / 2);
  const sum = solved.a + solved.b;
  return sum > 0 ? solved.a / sum : a / total;
}

/**
 * Fair probability from one price alone, assuming a hold.
 *
 * Marked `estimated` so the UI can say so. A promo's whole verdict can hinge on this
 * number, and a guessed input that looks like a measured one is the failure this app is
 * organised against.
 */
export function fairFromOneSide(price: number, hold = DEFAULT_TWO_WAY_HOLD): Devigged | null {
  const implied = impliedProbability(price);
  if (implied === null) return null;
  return { p: Math.min(0.999, implied / (1 + hold)), hold, method: "assumed", estimated: true };
}

/* --- what a bonus bet converts to ------------------------------------------------- */

/**
 * Share of face a bonus bet is worth at a given price, priced fairly.
 *
 * `EV = p(d-1)B`, and at fair odds `p = 1/d`, so this is `1 - 1/d`: about half of face
 * at even money, three quarters at +300, six sevenths at +600. Longer converts better,
 * which is the whole rule for spending one.
 */
export function bonusConversion(price: number): number {
  const d = decimalFrom(price);
  return Number.isFinite(d) && d > 1 ? 1 - 1 / d : 0;
}

/* --- parlay holds ----------------------------------------------------------------- */

/** Hold on a parlay of independent legs: it compounds, it does not average. */
export function parlayHold(legs: number, holdPerLeg = DEFAULT_LEG_HOLD): number {
  if (legs <= 0) return 0;
  return 1 - Math.pow(1 - holdPerLeg, legs);
}

/**
 * The most hold a profit boost can overcome.
 *
 * With hold `h` the unboosted bet is worth `-h` per dollar; a boost `b` adds about
 * `b(1-h)` on a long price, so it clears zero while `h < b/(1+b)`. A 50% boost covers
 * about 33% hold — which a six-leg parlay passes comfortably. Hence: long odds from
 * FEW legs, never a leg-stuffed ticket.
 */
export function boostCoversHold(boost: number): number {
  return boost / (1 + boost);
}

/* --- the five promo types --------------------------------------------------------- */

export interface PromoTerms {
  type: PromoType;
  capRefund?: number | null;
  maxStake?: number | null;
  boostPct?: number | null;
  bonusFace?: number | null;
  boostedPrice?: number | null;
  basePrice?: number | null;
  depositBonus?: number | null;
  rolloverMultiple?: number | null;
  minOddsAmerican?: number | null;
  minLegs?: number | null;
}

export interface EvInput {
  /** Fair win probability of the side being considered. */
  p: number;
  price: number;
  stake: number;
  legs?: number;
  /** What a refunded bonus bet is worth, as a share of face. */
  conversion?: number;
  /** Expected loss per dollar turned over, for rollover maths. */
  edgePerTurnover?: number;
  /**
   * Hold on a single parlay leg, for the boost-versus-hold check.
   *
   * A parameter because the honest number depends on what you are parlaying: 4.5% is
   * the measured two-way hold at -110, while legs picked off a boosted-parlay menu are
   * routinely priced worse. The spec's own examples are not self-consistent about it --
   * 8% on two legs implies 4.1% a leg, 20% on three implies 7.2%, 30% on six implies
   * 5.8% -- so the assumption is stated rather than buried.
   */
  holdPerLeg?: number;
}

export interface EvResult {
  /** Expected profit in dollars. */
  ev: number;
  /** Per dollar of stake, or of face for a bonus bet. */
  evPerDollar: number;
  /** Terms that bound the answer, in plain words. */
  binding: string[];
  /** Real problems: the promo is not worth taking as entered. */
  warnings: string[];
  /** Turnover a deposit match demands, in dollars. */
  requiredTurnover?: number;
}

/**
 * Expected value of using a promo at a given price and stake.
 *
 * Every branch reports what bound it. A number without its binding constraint invites
 * the obvious mistake — staking above a refund cap, where the extra dollars are simply
 * unprotected.
 */
export function promoEv(terms: PromoTerms, input: EvInput): EvResult {
  const conversion = input.conversion ?? DEFAULT_CONVERSION;
  const legs = input.legs ?? 1;
  const binding: string[] = [];
  const warnings: string[] = [];
  const d = decimalFrom(input.price);
  const p = input.p;

  if (terms.minOddsAmerican !== null && terms.minOddsAmerican !== undefined) {
    const floor = decimalFrom(terms.minOddsAmerican);
    if (d < floor - 1e-9) {
      warnings.push(
        `Price is shorter than the ${formatAmerican(terms.minOddsAmerican)} minimum, so it does not qualify.`,
      );
    } else {
      binding.push(`${formatAmerican(terms.minOddsAmerican)} minimum price`);
    }
  }
  if (terms.minLegs && legs < terms.minLegs) {
    warnings.push(`Needs at least ${terms.minLegs} legs; this has ${legs}.`);
  }
  const legHold = input.holdPerLeg ?? DEFAULT_LEG_HOLD;
  if (legs > 4) {
    warnings.push(
      `${legs} legs carries about ${(parlayHold(legs, legHold) * 100).toFixed(0)}% hold, and it ` +
        "compounds per leg. Long odds from few legs beat a stuffed ticket.",
    );
  }

  switch (terms.type) {
    case "stake_back": {
      const cap = terms.capRefund ?? 0;
      const stake = Math.min(input.stake, cap > 0 ? cap : input.stake);
      if (cap > 0 && input.stake > cap) {
        binding.push(`stake capped at $${cap} — anything above it is unprotected`);
      }
      const refund = Math.min(stake, cap > 0 ? cap : stake) * conversion;
      const ev = p * stake * (d - 1) - (1 - p) * stake + (1 - p) * refund;
      return { ev, evPerDollar: stake > 0 ? ev / stake : 0, binding, warnings };
    }
    case "profit_boost": {
      const stake = capStake(input.stake, terms.maxStake, binding);
      const boost = terms.boostPct ?? 0;
      const ev = p * stake * (d - 1) * (1 + boost) - (1 - p) * stake;
      if (legs > 1 && parlayHold(legs, legHold) >= boostCoversHold(boost)) {
        warnings.push(
          `A ${(boost * 100).toFixed(0)}% boost only overcomes about ` +
            `${(boostCoversHold(boost) * 100).toFixed(0)}% hold, and ${legs} legs carry more.`,
        );
      }
      return { ev, evPerDollar: stake > 0 ? ev / stake : 0, binding, warnings };
    }
    case "odds_boost": {
      const stake = capStake(input.stake, terms.maxStake, binding);
      const boosted = terms.boostedPrice ?? input.price;
      const ev = p * stake * (decimalFrom(boosted) - 1) - (1 - p) * stake;
      if (ev <= 0) {
        warnings.push(
          "Boosted price is still short of fair value — this one is not worth taking.",
        );
      }
      return { ev, evPerDollar: stake > 0 ? ev / stake : 0, binding, warnings };
    }
    case "bonus_bet": {
      const face = terms.bonusFace ?? input.stake;
      const ev = p * (d - 1) * face;
      return { ev, evPerDollar: face > 0 ? ev / face : 0, binding, warnings };
    }
    case "deposit_match": {
      const bonus = terms.depositBonus ?? 0;
      const rollover = terms.rolloverMultiple ?? 0;
      // Under proportional de-vig the expected loss per dollar turned over is h/(1+h)
      // at ANY price, so a minimum-odds term does not change this by itself. Books do
      // hold more on longshots, which is why this is a parameter and not a constant.
      const edge = input.edgePerTurnover ?? DEFAULT_TWO_WAY_HOLD / (1 + DEFAULT_TWO_WAY_HOLD);
      const requiredTurnover = rollover * bonus;
      const ev = bonus * (1 - rollover * edge);
      binding.push(`${rollover}x rollover means $${requiredTurnover.toFixed(0)} of bets`);
      if (ev <= 0) {
        warnings.push(
          `The rollover costs more than the bonus is worth at about ` +
            `${(edge * 100).toFixed(1)}% per dollar turned over.`,
        );
      }
      return { ev, evPerDollar: bonus > 0 ? ev / bonus : 0, binding, warnings, requiredTurnover };
    }
  }
}

function capStake(stake: number, maxStake: number | null | undefined, binding: string[]): number {
  if (maxStake === null || maxStake === undefined || maxStake <= 0) return stake;
  if (stake > maxStake) binding.push(`stake capped at $${maxStake}`);
  return Math.min(stake, maxStake);
}

export function formatAmerican(price: number): string {
  return price > 0 ? `+${price}` : String(price);
}

/* --- the optimiser ---------------------------------------------------------------- */

export interface CurvePoint {
  price: number;
  /** Fair probability at this price, if the market were priced fairly. */
  p: number;
  ev: number;
  evPerDollar: number;
  qualifies: boolean;
}

/**
 * EV across a range of prices, assuming each is priced fairly.
 *
 * Fair pricing is the honest assumption for a curve: the promo's value comes from its
 * structure, not from finding a soft number, and drawing it any other way would smuggle
 * a handicapping claim into a calculator. Seeing the shape teaches the rule — longer is
 * better, up to the qualifying limits — faster than being told.
 */
export function evCurve(
  terms: PromoTerms,
  stake: number,
  prices: number[] = [-200, -150, -110, 100, 150, 200, 300, 500, 800, 1200],
  options: { conversion?: number; hold?: number; legs?: number } = {},
): CurvePoint[] {
  const hold = options.hold ?? DEFAULT_TWO_WAY_HOLD;
  return prices.map((price) => {
    const fair = fairFromOneSide(price, hold);
    const p = fair ? fair.p : 0;
    const result = promoEv(terms, {
      p,
      price,
      stake,
      legs: options.legs,
      conversion: options.conversion,
    });
    const qualifies =
      terms.minOddsAmerican === null || terms.minOddsAmerican === undefined
        ? true
        : decimalFrom(price) >= decimalFrom(terms.minOddsAmerican) - 1e-9;
    return { price, p, ev: result.ev, evPerDollar: result.evPerDollar, qualifies };
  });
}

/** The stake the terms point at: the cap for a stake-back, the max for a boost. */
export function bestStake(terms: PromoTerms, fallback = 25): number {
  if (terms.type === "stake_back" && terms.capRefund) return terms.capRefund;
  if (terms.maxStake) return terms.maxStake;
  if (terms.type === "bonus_bet" && terms.bonusFace) return terms.bonusFace;
  return fallback;
}

/* --- expiry ------------------------------------------------------------------------ */

export interface ExpiryState {
  expired: boolean;
  hoursLeft: number;
  /** Under a day. The colour that has to be impossible to miss. */
  urgent: boolean;
}

export function expiryState(expiresAt: string | Date, now: Date = new Date()): ExpiryState {
  const end = expiresAt instanceof Date ? expiresAt : new Date(expiresAt);
  const ms = end.getTime() - now.getTime();
  if (!Number.isFinite(ms)) return { expired: true, hoursLeft: 0, urgent: false };
  const hoursLeft = ms / 3600000;
  return { expired: ms <= 0, hoursLeft, urgent: ms > 0 && hoursLeft <= 24 };
}

/**
 * Which token goes on which price, when several are live.
 *
 * Stake-back first onto the longest price: its refund is a fixed number of dollars, so
 * the longer the odds the more upside each protected dollar buys. The profit boost
 * takes the next longest, since it scales with profit rather than replacing a loss.
 * Everything else follows. One promo per bet unless a promo says otherwise — books
 * rarely stack, and assuming they do would double-count the value of a night.
 */
const ASSIGNMENT_ORDER: PromoType[] = [
  "stake_back",
  "profit_boost",
  "odds_boost",
  "bonus_bet",
  "deposit_match",
];

export function assignTokens<T extends { type: PromoType }>(
  tokens: T[],
  prices: number[],
): Array<{ token: T; price: number | null }> {
  const ordered = [...tokens].sort(
    (a, b) => ASSIGNMENT_ORDER.indexOf(a.type) - ASSIGNMENT_ORDER.indexOf(b.type),
  );
  const longest = [...prices].sort((a, b) => decimalFrom(b) - decimalFrom(a));
  return ordered.map((token, i) => ({ token, price: longest[i] ?? null }));
}
