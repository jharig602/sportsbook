import type { BoardEdge } from "./board-shop";
import { expectedRoi } from "./shop";
import { centralDate } from "./promo-window";
import type { Bet } from "./settle";
import type { Candidate } from "./survivor";

/**
 * A qualifying-bet promotion: each $5 stake earns a $50 bonus bet, six days running.
 *
 * The framing that matters, and it is the opposite of everything else in this app.
 * Elsewhere the question is "is there a bet worth making" and the answer is usually no.
 * Here the bet is compulsory: six of them will be placed whatever the board looks like,
 * because not placing them forfeits the bonus. So the question becomes "what is the
 * cheapest way to satisfy this", and the right answer is frequently a negative number.
 *
 * Reporting that honestly matters. A daily nudge that implies each $5 is a good bet
 * would be lying six times; one that says "this is the least it will cost you today"
 * is telling the truth about a cost you have already agreed to pay.
 */

/** Expected cost of the whole promotion: six stakes at whatever the board offers. */
export interface PromoPlan {
  /** Best available bet at the required book, which may still lose money. */
  pick: BoardEdge | null;
  /** Expected profit on this one stake. Usually negative. */
  expectedProfit: number;
  /** True when the board genuinely offers a bet that beats the vig. */
  beatsVig: boolean;
}

/**
 * The cheapest qualifying bet at a given book.
 *
 * Ranked by expected return, not by probability of winning: the bet must be placed, so
 * the only question is what it costs in expectation. A heavy favourite at a terrible
 * price is a worse way to spend $5 than a fair coin flip at a fair one.
 */
export function bestQualifier(
  rows: BoardEdge[],
  book: string,
  stake: number,
  /**
   * Event ids you already hold a bet on.
   *
   * Skipped rather than merely flagged. The promotion needs seven bets and the board
   * offers forty rows, so avoiding a game entirely costs nothing — while recommending
   * one you are already on is both useless advice and a quiet concentration of risk,
   * since the two tickets then win and lose together.
   */
  alreadyOn: Set<string> = new Set(),
): PromoPlan {
  const mine = rows.filter(
    (row) =>
      row.book === book &&
      row.expectedRoi !== null &&
      !row.stale &&
      !alreadyOn.has(row.eventId),
  );
  if (mine.length === 0) {
    return { pick: null, expectedProfit: 0, beatsVig: false };
  }
  const best = mine.reduce((a, b) => ((b.expectedRoi ?? -1) > (a.expectedRoi ?? -1) ? b : a));
  const roi = best.expectedRoi ?? 0;
  return { pick: best, expectedProfit: stake * roi, beatsVig: roi > 0 };
}

export interface BonusTarget {
  candidate: Candidate;
  price: number;
  /** Expected value of the bonus bet, in dollars. */
  value: number;
  /** Share of face value converted into real expected dollars. */
  conversion: number;
}

/**
 * Where to put a bonus bet whose stake is the book's and whose winnings are yours.
 *
 * A cash bet risks the stake; this does not. The $50 is gone either way, so the losing
 * side costs nothing extra and the only thing that matters is how much a win pays:
 *
 *     value = P(win) x (decimal odds - 1) x face
 *
 * Which makes long odds strictly better, up to a point. The probability here is the
 * one the fitted residual model gives for the spread, NOT the one implied by the
 * moneyline: using the implied price would bake in the favourite-longshot bias and
 * push every recommendation toward +5000 shots that win far less often than they are
 * priced to.
 */
export function bestBonusTarget(
  candidates: Array<{ candidate: Candidate; price: number }>,
  face: number,
  minPrice = 250,
  maxPrice = 1200,
  /** Event ids you already hold a bet on. Same reasoning as `bestQualifier`. */
  alreadyOn: Set<string> = new Set(),
): BonusTarget | null {
  let best: BonusTarget | null = null;
  for (const { candidate, price } of candidates) {
    if (alreadyOn.has(candidate.eventId)) continue;
    // Below the floor a bonus bet converts poorly; above the ceiling the model is
    // extrapolating past where the spread data supports it.
    if (price < minPrice || price > maxPrice) continue;
    const profit = price > 0 ? price / 100 : 100 / -price;
    const value = candidate.winProbability * profit * face;
    if (best === null || value > best.value) {
      best = { candidate, price, value, conversion: value / face };
    }
  }
  return best;
}

export interface Progress {
  /** Qualifying days completed, 0-based count of days already logged. */
  done: number;
  required: number;
  /** True once every qualifying bet has been placed. */
  complete: boolean;
  /** 1-based day number for today, or null once complete. */
  today: number | null;
}

/**
 * How far through the qualifying period we are.
 *
 * Counted from dates on which a bet was actually logged, not from the calendar. A day
 * you forgot is a day that did not count, and a promotion tracker that assumes
 * otherwise would announce completion while the bonus was still unearned.
 */
export function qualifyingDates(bets: Bet[], book: string, stake: number): string[] {
  return bets
    .filter(
      (bet) =>
        bet.book === book &&
        bet.bonus !== true &&
        // The bonus bets are the $50 side of the same promotion and are not what earns
        // it; only the qualifying stake counts a day. Matched loosely on size so a $4.95
        // rounding or a $5.50 does not silently stop counting.
        Math.abs(bet.stake - stake) <= stake * 0.25,
    )
    .map((bet) => centralDate(new Date(bet.placed_at)));
}

export function progress(loggedDates: string[], required: number): Progress {
  const done = new Set(loggedDates).size;
  return {
    done,
    required,
    complete: done >= required,
    today: done >= required ? null : done + 1,
  };
}

/**
 * Cash expected value of the whole promotion.
 *
 * EACH qualifying stake earns its own bonus, so both sides scale with the number of
 * days -- which makes this lopsided rather than marginal. Seven $5 bets cost about
 * $1.60 in expectation at the usual hold; seven $50 bonus bets placed well are worth
 * something near $340. Getting this relationship wrong in the other direction (one
 * bonus for seven stakes) would understate the promotion sevenfold and could make a
 * plainly good deal look like a close call.
 */
export function promoValue(
  costPerBet: number,
  required: number,
  bonusValuePerBet: number,
): number {
  return required * (bonusValuePerBet - Math.abs(costPerBet));
}

/**
 * Games you already have money on.
 *
 * Settled bets do not count: last week's result cannot be doubled down on, and keeping
 * them would slowly starve the board as the season went by.
 */
export function eventsAlreadyBet(bets: Bet[], scores: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const bet of bets) {
    if (!scores.has(bet.event_id)) out.add(bet.event_id);
  }
  return out;
}
