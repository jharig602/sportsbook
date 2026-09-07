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
  /**
   * Too old to price against today's board.
   *
   * A quote from Tuesday sitting in Sunday's consensus does not merely add noise, it
   * adds a number the market has already moved past, and the gap it opens up reads as
   * an edge. Stale quotes are therefore kept out of every consensus -- but still
   * returned, so the page can say a book was checked and when, rather than quietly
   * showing a thinner board than was actually observed.
   */
  stale?: boolean;
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
  /** Fewer than three other books, so the reference is one or two opinions. */
  thinConsensus: boolean;
  stale: boolean;
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

/**
 * How many other books it takes before a median is robust.
 *
 * The median of two numbers is their mean, so with one other book a single lazily
 * priced market sets the whole reference. Three is the smallest count at which the
 * median actually discards an outlier.
 *
 * This is a threshold for *ranking a whole board*, not for arithmetic. Mining sixty
 * games for the largest number selects the thinnest reference, so the board applies it.
 * A deliberate head-to-head -- you typed in what your own book shows, against the one
 * on the board -- is a different question with a real answer, so the game page does
 * not. Hence a parameter rather than a hard floor: forcing three books everywhere would
 * silently disable hand entry, which exists precisely because you can only bet where
 * you have an account.
 */
export const ROBUST_CONSENSUS_BOOKS = 3;

/**
 * The probability range where a de-vigged moneyline can be trusted.
 *
 * De-vigging here is multiplicative: it scales both sides down by the overround. That
 * assumes the book spreads its margin proportionally, which is roughly true near even
 * money and badly false in the tails, where books load almost all of it onto the
 * longshot -- the favourite-longshot bias.
 *
 * Worked through on a real pair, favourite -5000 against dog +2500: the overround is
 * 1.89%, and proportional de-vig takes the dog from 3.85% to 3.775%, removing seven
 * hundredths of a point. Against a book offering +3500 that "fair" 3.775% produces
 * +35.9% expected return out of nothing at all.
 *
 * That is not hypothetical. The first board this shipped against reported 79 rows
 * beating the vig, every one of them a big-underdog moneyline, several at +37%. All
 * artefacts of this. Outside the band the gap is still shown, but no return is quoted,
 * because the number required to quote one cannot be estimated this way.
 */
export const MONEYLINE_MIN_PROBABILITY = 0.2;
export const MONEYLINE_MAX_PROBABILITY = 0.8;

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
export function shopSide(
  quotes: BookQuote[],
  model: MarginModel | null,
  minBooks = 1,
): ShopResult[] {
  const density = model ? pointsToProbability(model) : 0;

  return quotes.map((quote) => {
    // A stale quote never becomes anyone's reference.
    const others = quotes.filter((q) => q.book !== quote.book && !q.stale);
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
      thinConsensus: others.length < ROBUST_CONSENSUS_BOOKS,
      stale: quote.stale === true,
      note: "",
    };

    if (quote.stale) {
      return { ...base, note: "Last seen too long ago to price against the current board." };
    }

    if (others.length === 0) {
      return { ...base, note: "Only one book has this line; nothing to compare against." };
    }

    if (others.length < minBooks) {
      return {
        ...base,
        note: `Only ${others.length} other book${others.length === 1 ? "" : "s"}; too thin a reference to rank against a whole board.`,
      };
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
      // Outside the band, report the comparison but refuse to price it.
      if (
        consensusProbability < MONEYLINE_MIN_PROBABILITY ||
        consensusProbability > MONEYLINE_MAX_PROBABILITY
      ) {
        return {
          ...base,
          consensusProbability,
          note:
            "Too far from even money to de-vig reliably; books load their margin onto " +
            "the longshot, so no return is quoted.",
        };
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
export function shopAll(
  quotes: BookQuote[],
  model: MarginModel | null,
  minBooks = 1,
): ShopResult[] {
  const groups = new Map<string, BookQuote[]>();
  for (const quote of quotes) {
    const key = `${quote.market}:${quote.side}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(quote);
    else groups.set(key, [quote]);
  }
  const out: ShopResult[] = [];
  for (const bucket of groups.values()) out.push(...shopSide(bucket, model, minBooks));
  return out.sort((a, b) => (b.expectedRoi ?? -Infinity) - (a.expectedRoi ?? -Infinity));
}
