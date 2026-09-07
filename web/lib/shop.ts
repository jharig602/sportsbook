import { impliedProbability, deVig, type MarginModel } from "./probability";
import type { Market, Side } from "./types";

/**
 * Comparing one book against the others.
 *
 * The Edges page asks whether DraftKings' spread agrees with DraftKings' moneyline.
 * That is a self-consistency check on a single opinion, and a book that prices its own
 * board coherently cannot disagree with itself by more than rounding noise — which is
 * exactly what it found: every row within a shrunk +0.0 of zero.
 *
 * This asks a different question, and the only one at this scale with an answer that
 * beats the hold: does *this* book disagree with the *other* books? A point of line is
 * worth 3.24 points of win probability in the NFL and 2.64 in college, against a
 * 2.4-point vig at -110. So a one-point disagreement between books clears the vig
 * outright, where a same-book inconsistency never does.
 *
 * Everything here is per-side and leave-one-out: the consensus a quote is measured
 * against never includes that quote. Including it would drag the reference toward the
 * number being tested and shrink the very gap this exists to find.
 */

export interface BookQuote {
  book: string;
  market: Market;
  side: Side;
  /** Null for moneyline. */
  line: number | null;
  price: number | null;
  /** Price on the opposite side at the same book, needed to de-vig. */
  oppositePrice?: number | null;
  observedAt?: string;
}

export interface ShopResult {
  book: string;
  market: Market;
  side: Side;
  line: number | null;
  price: number | null;
  /** Median line across the other books, in this side's own convention. */
  consensusLine: number | null;
  /** Median de-vigged probability across the other books. */
  consensusProbability: number | null;
  /** How many points better than consensus this quote is. Positive is better. */
  advantagePoints: number | null;
  /** Fair probability of this side winning at THIS line, per the consensus. */
  fairProbability: number | null;
  /** Win rate the offered price requires just to break even. */
  breakEven: number | null;
  /** Expected return per dollar staked. Negative means the vig eats it. */
  expectedRoi: number | null;
  booksCompared: number;
  note: string;
}

/**
 * Orient a line so that larger is always better for the side holding it.
 *
 * Home +3 beats home +2.5, and home -2.5 beats home -3, so the home spread needs no
 * flip. The away side's line is the negation of the home spread and is stored that
 * way, so it does not either. On a total the over wants the smallest number it can
 * get, so its sign inverts; the under wants the largest and does not.
 */
export function orientedLine(market: Market, side: Side, line: number): number {
  if (market === "total") return side === "over" ? -line : line;
  return line;
}

/** Undo `orientedLine`, for display. It is its own inverse. */
export function postedLine(market: Market, side: Side, oriented: number): number {
  return orientedLine(market, side, oriented);
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Points of win probability bought by one point of line, at the middle of the
 * distribution. This is the peak density of the fitted residual, 1/(sd*sqrt(2pi)) —
 * the same local-linear approximation `effectiveSpread` uses to price juice, applied
 * in the opposite direction.
 *
 * Being local, it is honest near a coin flip and overstates the value of a point far
 * out in the tail. Gaps large enough to matter here are small enough for it to hold.
 */
export function pointsToProbability(model: MarginModel): number {
  if (!model || model.sd <= 0) return 0;
  return 1 / (model.sd * Math.sqrt(2 * Math.PI));
}

/** De-vigged probability for one quote, falling back to the raw implied price. */
function fairOf(quote: BookQuote): number | null {
  const paired = deVig(quote.price ?? null, quote.oppositePrice ?? null);
  return paired ? paired.a : impliedProbability(quote.price ?? null);
}

/**
 * Expected return per dollar staked, given a probability and an American price.
 *
 * A win pays the price, a loss costs the stake. This is the number that answers
 * whether a bet is worth making; an edge in probability points does not, because the
 * vig is charged in dollars.
 */
export function expectedRoi(probability: number, price: number): number {
  const profit = price > 0 ? price / 100 : 100 / -price;
  return probability * profit - (1 - probability);
}

/**
 * Compare every quote for one game/market/side against the others.
 *
 * `quotes` must all describe the same side of the same market on the same game; the
 * caller groups them. A lone quote returns a row with no comparison rather than being
 * dropped, so the UI can say that a book stands alone instead of silently hiding it.
 */
export function shopSide(quotes: BookQuote[], model: MarginModel | null): ShopResult[] {
  const density = model ? pointsToProbability(model) : 0;

  return quotes.map((quote) => {
    const others = quotes.filter((q) => q.book !== quote.book);
    const base: ShopResult = {
      book: quote.book,
      market: quote.market,
      side: quote.side,
      line: quote.line,
      price: quote.price ?? null,
      consensusLine: null,
      consensusProbability: null,
      advantagePoints: null,
      fairProbability: null,
      breakEven: impliedProbability(quote.price ?? null),
      expectedRoi: null,
      booksCompared: others.length,
      note: "",
    };

    if (others.length === 0) {
      return { ...base, note: "Only one book has this line; nothing to compare against." };
    }

    const consensusProbability = median(
      others.map(fairOf).filter((p): p is number => p !== null),
    );

    // A moneyline has no number to shop, only a price. The comparison is directly
    // between what the other books think this side is worth and what this one charges.
    if (quote.market === "moneyline" || quote.line === null) {
      if (consensusProbability === null || quote.price === null) {
        return { ...base, consensusProbability, note: "Not enough priced books to compare." };
      }
      return {
        ...base,
        consensusProbability,
        fairProbability: consensusProbability,
        expectedRoi: expectedRoi(consensusProbability, quote.price),
        note: `Priced against the median of ${others.length} other book${others.length === 1 ? "" : "s"}.`,
      };
    }

    const otherLines = others
      .filter((q) => q.line !== null)
      .map((q) => orientedLine(q.market, q.side, q.line as number));
    const consensusOriented = median(otherLines);

    if (consensusOriented === null) {
      return { ...base, consensusProbability, note: "No other book posts this line." };
    }

    const mine = orientedLine(quote.market, quote.side, quote.line);
    const advantagePoints = mine - consensusOriented;

    // The consensus line is by definition the number the market treats as a coin flip.
    // Standing that many points better than it moves the cover probability by the
    // density, in the direction of the advantage.
    const fairProbability =
      density > 0
        ? Math.min(0.99, Math.max(0.01, 0.5 + advantagePoints * density))
        : null;

    return {
      ...base,
      consensusLine: postedLine(quote.market, quote.side, consensusOriented),
      consensusProbability,
      advantagePoints,
      fairProbability,
      expectedRoi:
        fairProbability !== null && quote.price !== null
          ? expectedRoi(fairProbability, quote.price)
          : null,
      note:
        density > 0
          ? `${advantagePoints >= 0 ? "+" : ""}${advantagePoints.toFixed(1)} pts against ${others.length} other book${others.length === 1 ? "" : "s"}.`
          : "No fitted model for this league, so points cannot be priced.",
    };
  });
}

/** Group flat quotes by market and side, shop each group, best return first. */
export function shopAll(quotes: BookQuote[], model: MarginModel | null): ShopResult[] {
  const groups = new Map<string, BookQuote[]>();
  for (const quote of quotes) {
    const key = `${quote.market}:${quote.side}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(quote);
    else groups.set(key, [quote]);
  }
  const out: ShopResult[] = [];
  for (const bucket of groups.values()) out.push(...shopSide(bucket, model));
  return out.sort((a, b) => (b.expectedRoi ?? -Infinity) - (a.expectedRoi ?? -Infinity));
}
