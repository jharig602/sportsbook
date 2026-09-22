/**
 * The bet of the day: the one line-shopping edge most likely to win, corrected by what
 * the graded record has taught.
 *
 * Three rules, each with a reason.
 *
 * **It must actually clear the house edge**, by the same 1.5 points of probability the
 * shop alerts demand. The promotion this replaced was allowed to recommend a losing bet
 * because the bet was compulsory; this one is not, so on a day with nothing real the
 * right output is "no bet today", and that is the usual day.
 *
 * **Among those, the likeliest winner**, not the biggest return. Every candidate is
 * already worth making; ranking by return would drift toward long prices, where the
 * estimates are shakiest and a losing streak is longest.
 *
 * **Never a game you already have money on.** A second ticket on the same game is not a
 * second opinion -- the two win and lose together.
 *
 * ## Parlay of the day
 *
 * The same rules, two legs at a time: every leg clears the bar on its own, the two are
 * on different games at one book (a same-game parlay is priced with a correlation
 * adjustment nothing here can reproduce, and a ticket cannot span books), and neither
 * is on the single's game, so taking both does not stack two tickets on one result.
 * The likeliest pair wins. It is priced at the combined price rounded DOWN, as books
 * pay it, and must still show a positive return at that price.
 *
 * ## Learning
 *
 * Every line-shopping pick is graded against what happened (`shop_grades`). For each
 * market and league, `learnedShift` compares how often those picks won with how often
 * they were predicted to, and moves future predictions by that gap -- shrunk toward zero
 * by `PRIOR_STRENGTH`, so twenty lucky results move it a little and five hundred move it
 * a lot. That is what "getting more accurate" can honestly mean: predictions that match
 * outcomes more closely as the record grows. It is not a promise of more wins each
 * week; at a few bets a week, variance swamps any edge for a long time.
 */
import type { BoardEdge } from "./board-shop";
import { isBlowout } from "./blowout";
import { expectedRoi } from "./shop";
import { type EdgeCalibration, calibratedEdgePoints } from "./edge-calibration";
import { parlayPrice, profitPerDollar } from "./profit-boost";
import { MIN_ALERT_EDGE_POINTS } from "./shop-alerts";
import { activeBets, type Bet } from "./settle";

/**
 * Graded picks at which the observed record counts for half.
 *
 * Below this the correction stays small, which is the point: with a few dozen results
 * the difference between predicted and actual is mostly luck, and a system that chased
 * it would be "learning" noise and calling it progress.
 */
export const PRIOR_STRENGTH = 100;

export interface GradedPick {
  market: string;
  league: string;
  fair_probability: number;
  /** Null is a push, which says nothing about a probability. */
  result_covered: boolean | null;
}

export interface Adjustment {
  market: string;
  league: string;
  /** Decided picks behind the correction. */
  n: number;
  hits: number;
  /** Wins the picks were predicted to produce. */
  expected: number;
  /** Added to every future probability in this cell. */
  shift: number;
}

export function learnedShift(
  grades: GradedPick[],
  market: string,
  league: string,
  prior = PRIOR_STRENGTH,
): Adjustment {
  let n = 0;
  let hits = 0;
  let expected = 0;
  for (const g of grades) {
    if (g.market !== market || g.league !== league || g.result_covered === null) continue;
    n += 1;
    expected += g.fair_probability;
    if (g.result_covered) hits += 1;
  }
  // (hits - expected) / n is the raw gap; multiplying by n / (n + prior) shrinks it.
  const shift = n === 0 ? 0 : (hits - expected) / (n + prior);
  return { market, league, n, hits, expected, shift };
}

/**
 * Games you still have money riding on.
 *
 * Only bets that still stand: a corrected row is replaced by its correction and a voided
 * one is gone, so neither blocks a game you no longer hold. A cashed-out ticket is
 * finished even while its game is not, and a settled game has nothing left to double
 * up on.
 */
export function openEvents(bets: Bet[], settledEventIds: Set<string>): Set<string> {
  const out = new Set<string>();
  for (const bet of activeBets(bets)) {
    if (bet.cashout !== undefined && bet.cashout !== null) continue;
    if (!settledEventIds.has(bet.event_id)) out.add(bet.event_id);
  }
  return out;
}

export interface DailyCandidate {
  row: BoardEdge;
  /** Win probability after the learned correction. */
  p: number;
  /** Points of probability above what the price needs to break even. */
  edgePoints: number;
  roi: number;
  adjustment: Adjustment;
}

export interface DailyParlay {
  legs: DailyCandidate[];
  book: string;
  /** Combined American price, rounded down the way books pay it. */
  price: number;
  /** Chance every leg wins, treating different games as independent. */
  p: number;
  /** Expected return per dollar at `price`. */
  roi: number;
}

/**
 * The likeliest two-leg ticket from bets that each clear the bar.
 *
 * `candidates` must already be sorted likeliest-first, which makes the best pair at each
 * book simply its top two games.
 */
export function bestParlay(
  candidates: DailyCandidate[],
  exclude: Set<string>,
  legCount = 2,
): DailyParlay | null {
  const byBook = new Map<string, DailyCandidate[]>();
  for (const c of candidates) {
    if (exclude.has(c.row.eventId) || c.row.price === null) continue;
    byBook.set(c.row.book, [...(byBook.get(c.row.book) ?? []), c]);
  }

  let best: DailyParlay | null = null;
  for (const [book, list] of byBook) {
    const legs: DailyCandidate[] = [];
    const games = new Set<string>();
    for (const c of list) {
      if (games.has(c.row.eventId)) continue;
      legs.push(c);
      games.add(c.row.eventId);
      if (legs.length === legCount) break;
    }
    if (legs.length < legCount) continue;

    const price = parlayPrice(legs.map((l) => l.row.price as number));
    const p = legs.reduce((acc, l) => acc * l.p, 1);
    const roi = p * (1 + profitPerDollar(price)) - 1;
    if (!(roi > 0)) continue;
    if (!best || p > best.p || (p === best.p && roi > best.roi)) {
      best = { legs, book, price, p, roi };
    }
  }
  return best;
}

export interface DailyPick {
  pick: DailyCandidate | null;
  /** Null when fewer than two qualifying bets share a book on different games. */
  parlay: DailyParlay | null;
  /** Fresh, priced rows at your books, before the "already on it" filter. */
  considered: number;
  /** Rows dropped because you already have money on that game. */
  skippedOpen: number;
  /** Rows that cleared the bar after learning. */
  qualifying: number;
  /** Why there is no pick, when there is none. */
  reason: string | null;
}

export function pickDailyBet(
  rows: BoardEdge[],
  options: {
    /** Books you can bet at. Empty means none chosen, so every book counts. */
    myBooks: string[];
    open: Set<string>;
    grades: GradedPick[];
    maxSpread: number;
    minEdgePoints?: number;
    prior?: number;
    /**
     * How much of a measured edge has actually turned up, from the line census.
     *
     * Applied to the edge rather than to the bar, which is the same arithmetic read the
     * honest way round: at a measured half-delivery, a claimed 3 points becomes 1.5 and
     * lands exactly on the threshold. Null until enough of the board has been graded,
     * and then a no-op until the slope clears its own error bar -- an unproven discount
     * is a guess, and guessing here would invent the quantity being measured.
     */
    calibration?: EdgeCalibration | null;
  },
): DailyPick {
  const minEdge = options.minEdgePoints ?? MIN_ALERT_EDGE_POINTS;
  const cells = new Map<string, Adjustment>();
  const adjustmentFor = (market: string, league: string) => {
    const key = `${market}|${league}`;
    let found = cells.get(key);
    if (!found) {
      found = learnedShift(options.grades, market, league, options.prior);
      cells.set(key, found);
    }
    return found;
  };

  let considered = 0;
  let skippedOpen = 0;
  const qualifying: DailyCandidate[] = [];

  for (const row of rows) {
    if (options.myBooks.length > 0 && !options.myBooks.includes(row.book)) continue;
    if (row.stale || row.fairProbability === null || row.price === null || row.breakEven === null) {
      continue;
    }
    if (isBlowout(row.gameSpread, options.maxSpread)) continue;
    considered += 1;
    if (options.open.has(row.eventId)) {
      skippedOpen += 1;
      continue;
    }

    const adjustment = adjustmentFor(row.market, row.league);
    const p = Math.min(0.99, Math.max(0.01, row.fairProbability + adjustment.shift));
    const measuredEdge = (p - row.breakEven) * 100;
    const edgePoints = calibratedEdgePoints(measuredEdge, options.calibration ?? null);
    const roi = expectedRoi(p, row.price);
    if (edgePoints >= minEdge && roi > 0) {
      qualifying.push({ row, p, edgePoints, roi, adjustment });
    }
  }

  qualifying.sort((a, b) => b.p - a.p || b.roi - a.roi);
  const pick = qualifying[0] ?? null;
  const parlay = bestParlay(qualifying, new Set(pick ? [pick.row.eventId] : []));

  let reason: string | null = null;
  if (!pick) {
    if (considered === 0) {
      reason = "Nothing is priced at your books yet.";
    } else if (considered === skippedOpen) {
      reason = "Every priced game at your books is one you already have money on.";
    } else {
      reason =
        `Nothing at your books clears the house edge by ${minEdge} points today. ` +
        "That is the usual answer, and the right one to act on.";
    }
  }
  return { pick, parlay, considered, skippedOpen, qualifying: qualifying.length, reason };
}
