import type { BoardEdge } from "./board-shop";

/**
 * What a parlay is actually worth.
 *
 * The arithmetic is unforgiving and worth stating before anything else, because it is
 * the reason parlays exist as a product. For independent legs the expected return
 * COMPOUNDS:
 *
 *     1 + EV(parlay) = (1 + EV(leg 1)) x (1 + EV(leg 2)) x ...
 *
 * A book's ordinary hold is about 4.5% a leg. Four of those is 0.955^4 - 1 = -16.8%,
 * which is why the parlay is the most profitable thing on a sportsbook's menu and why
 * it is advertised the hardest. No amount of picking winners fixes that: the legs can
 * each be coin flips you love and the parlay still bleeds, because the vig is charged
 * four times.
 *
 * The same formula is the entire argument FOR one, and it is the only honest one. Feed
 * it legs that genuinely clear the vig and the compounding works in your favour instead:
 * two legs at +5% is 1.05^2 - 1 = +10.25%. That is not a trick — it is the same maths
 * pointed the other way, and it only exists because this board can find legs with a
 * positive number on them. Everywhere else, a parlay builder is a device for turning a
 * small loss into a large one.
 *
 * Two limits that decide whether the formula applies at all:
 *
 * 1. INDEPENDENCE. Legs from the same game are correlated — a team covering and its own
 *    team total going over move together — and the product is then simply wrong. Books
 *    know this and price same-game parlays with their own adjustment, which is not a
 *    multiplication of the leg prices. So the functions in THIS file apply only to legs
 *    from different games; `buildParlay` reports any repeated game in `correlatedGames`
 *    rather than pretending the number holds. Same-game tickets are priced in
 *    `joint-score.ts`, off one scoreline, and may be logged like any other.
 * 2. The book must actually pay the product. Cross-game parlays at the major books do
 *    multiply true decimal odds; some round the price down, which quietly takes a slice
 *    the maths here will not see.
 */

export interface ParlayLeg {
  row: BoardEdge;
}

export interface ParlayResult {
  legs: BoardEdge[];
  /** Chance every leg lands, per the model. */
  winProbability: number;
  /** Combined decimal odds: what one dollar returns, stake included. */
  decimal: number;
  /** American price for the combined odds. */
  americanPrice: number;
  /** Expected return per dollar staked. Compounds, in whichever direction. */
  expectedRoi: number;
  /** Games contributing more than one leg. Non-empty means the maths does not apply. */
  correlatedGames: string[];
  /** True when every leg has a price and a fair probability to work from. */
  priceable: boolean;
}

function decimalOdds(price: number): number {
  return price > 0 ? 1 + price / 100 : 1 + 100 / -price;
}

/** Decimal odds back to the American price a book would print. */
export function toAmerican(decimal: number): number {
  if (decimal <= 1) return 0;
  const profit = decimal - 1;
  return profit >= 1 ? Math.round(profit * 100) : -Math.round(100 / profit);
}

export function buildParlay(legs: BoardEdge[]): ParlayResult {
  const seen = new Map<string, number>();
  for (const leg of legs) seen.set(leg.eventId, (seen.get(leg.eventId) ?? 0) + 1);
  const correlatedGames = [...seen.entries()]
    .filter(([, count]) => count > 1)
    .map(([eventId]) => eventId);

  const priceable =
    legs.length > 0 &&
    legs.every((leg) => leg.price !== null && leg.fairProbability !== null);

  if (!priceable) {
    return {
      legs,
      winProbability: 0,
      decimal: 1,
      americanPrice: 0,
      expectedRoi: 0,
      correlatedGames,
      priceable: false,
    };
  }

  let winProbability = 1;
  let decimal = 1;
  for (const leg of legs) {
    winProbability *= leg.fairProbability as number;
    decimal *= decimalOdds(leg.price as number);
  }

  return {
    legs,
    winProbability,
    decimal,
    americanPrice: toAmerican(decimal),
    // Equivalent to multiplying (1 + each leg's return), but computed from the parts so
    // it cannot drift from the probability and price shown beside it.
    expectedRoi: winProbability * decimal - 1,
    correlatedGames,
    priceable: true,
  };
}

/**
 * What the same legs would be worth at an ordinary book hold.
 *
 * The comparison that makes the number above mean something. Without it "+10%" is a
 * figure with no scale; beside "a normal four-leg parlay returns -17%" it says what is
 * actually being claimed, and it says plainly that the claim depends entirely on the
 * legs having been positive to begin with.
 */
export function typicalParlayRoi(legCount: number, holdPerLeg = 0.045): number {
  return Math.pow(1 - holdPerLeg, legCount) - 1;
}

/**
 * How often a parlay of this shape actually pays, as "about one in N".
 *
 * Shown because expected value says nothing about how it feels. A four-leg parlay of
 * 70% legs is positive on paper and loses three times in four, and anyone who has not
 * been told that will conclude the number was wrong rather than that it was variance.
 */
export function oneInHowMany(winProbability: number): number {
  return winProbability > 0 ? 1 / winProbability : Infinity;
}

/** One leg as the ledger stores it, which is all the contradiction check needs. */
export interface TicketLeg {
  event_id: string;
  market: string;
  side: string;
  line: number | null;
}

/**
 * Why these legs cannot be one ticket, if they cannot.
 *
 * Same-game legs are allowed. They were refused here for a while on the grounds that
 * "grading it by multiplying would be wrong", which was wrong about this code:
 * `settleParlay` grades off the book's own stored combined price and the requirement
 * that every leg won, and never multiplies anything. Correlation changes what a ticket
 * is WORTH, not how it settles, so it belongs in the builder and not in the gate.
 *
 * What is still worth refusing is a ticket that cannot win: the same leg twice, or two
 * legs that directly oppose each other. Those are typing mistakes, and a book would
 * never have printed the price being logged.
 *
 * Only the syntactic contradictions are caught here, because this runs without a model.
 * A ticket can be impossible in subtler ways -- laying -7 and taking the other side's
 * moneyline -- and the builder shows those as a flat 0%, which is where a question that
 * needs the fitted distribution belongs.
 */
export function sameGameProblem(legs: TicketLeg[]): string | null {
  const seen = new Set<string>();
  for (const leg of legs) {
    const key = `${leg.event_id}|${leg.market}|${leg.side}|${leg.line ?? ""}`;
    if (seen.has(key)) return "The same leg is on the ticket twice.";
    seen.add(key);
  }

  const OPPOSITE: Record<string, string> = {
    home: "away", away: "home", over: "under", under: "over",
  };
  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      const a = legs[i];
      const b = legs[j];
      if (a.event_id !== b.event_id || a.market !== b.market) continue;
      if (OPPOSITE[a.side] !== b.side) continue;
      // Opposite sides of the SAME number cannot both win. Opposite sides of different
      // numbers can -- a middle -- so the line has to match before this refuses.
      if ((a.line ?? null) === (b.line ?? null)) {
        return "Two legs are opposite sides of the same market; that ticket cannot win.";
      }
    }
  }
  return null;
}
