/**
 * Loads everything the bet of the day needs, for one ledger.
 *
 * Shared by the Shop page and the daily notification, so the screen and the phone can
 * never recommend different bets from the same board.
 */
import { listBets } from "./bets-db";
import { listCensus } from "./census";
import { calibrate, collapseCensus, gradeCensus, type EdgeCalibration } from "./edge-calibration";
import { allBookLines } from "./book-lines";
import { buildBoardShop } from "./board-shop";
import { openEvents, pickDailyBet, type DailyPick } from "./daily-bet";
import { getData } from "./data";
import { getFavourites, getMaxSpread, getMyBooks } from "./settings-db";
import { MIN_ALERT_EDGE_POINTS } from "./shop-alerts";
import { bestSameGameParlays, sgpGamesFromBoard, type SgpPick } from "./sgp";
import { collapseByOutcome } from "./shop-record";

export interface DailyBetView extends DailyPick {
  /** Graded line-shopping picks the learning drew on, across every market. */
  gradedTotal: number;
  myBooks: string[];
  /**
   * How much of a measured edge has actually turned up, or null while there is too
   * little censused to say. Shown so the discount being applied is visible rather than
   * silently folded into every number on the page.
   */
  calibration: EdgeCalibration | null;
  /**
   * The same-game ticket with the most room in it, or null.
   *
   * Carries a fair price rather than an edge, because no feed here holds a book's
   * same-game price. It is a number to check the slip against, not a claim about one.
   */
  sameGame: SgpPick | null;
}

export async function dailyBet(ownerId: string): Promise<DailyBetView> {
  const data = getData();
  const [games, models, scores, lines, ledger, results, grades, myBooks, maxSpread, census, favourites] =
    await Promise.all([
    data.games(),
    data.marginModels(),
    data.scoreModels(),
    allBookLines(),
    listBets(ownerId).catch(() => []),
    data.results().catch(() => []),
    data.shopGrades().catch(() => []),
    getMyBooks().catch(() => [] as string[]),
    getMaxSpread(),
    // Every line the board could compare, bet or not. The negative rows are what make
    // the positive ones readable -- see census.ts.
    listCensus().catch(() => []),
    getFavourites().catch(() => [] as string[]),
  ]);

  const shop = buildBoardShop(games, lines, models);
  const settled = new Set(results.map((r) => r.event_id));

  // One result per number rather than per book, or nine quotes on one game would shrink
  // the error bar around a sample that never grew.
  const scoreByEvent = new Map(
    results.map((r) => [r.event_id, { home_score: r.home_score, away_score: r.away_score }]),
  );
  const calibration = census.length > 0
    ? calibrate(collapseCensus(gradeCensus(census, scoreByEvent)))
    : null;
  const pick = pickDailyBet(shop.rows, {
    myBooks,
    open: openEvents(ledger, settled),
    // One result per outcome: a game quoted well at five books is one piece of evidence,
    // not five, and learning from the raw rows would let it count five times.
    grades: collapseByOutcome(grades),
    maxSpread,
    // A no-op until the slope clears its own error bar. An unproven discount is a guess,
    // and guessing here would invent the quantity being measured.
    calibration,
    favourites,
  });
  // Built from the same board and excluded from the same games, so the day's three
  // suggestions never collide with each other or with a bet already standing.
  const taken = openEvents(ledger, settled);
  if (pick.pick) taken.add(pick.pick.row.eventId);
  for (const leg of pick.parlay?.legs ?? []) taken.add(leg.row.eventId);
  const sameGame =
    bestSameGameParlays(sgpGamesFromBoard(shop.rows, { books: myBooks, favourites }), models, scores, {
      exclude: taken,
      limit: 1,
      // The same bar the single uses, applied leg by leg. Nothing qualifying is the
      // usual answer, and saying so beats offering a ticket with no edge in it.
      minEdgePoints: MIN_ALERT_EDGE_POINTS,
    })[0] ?? null;

  return { ...pick, gradedTotal: grades.length, myBooks, sameGame, calibration };
}
