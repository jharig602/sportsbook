/**
 * Loads everything the bet of the day needs, for one ledger.
 *
 * Shared by the Shop page and the daily notification, so the screen and the phone can
 * never recommend different bets from the same board.
 */
import { listBets } from "./bets-db";
import { allBookLines } from "./book-lines";
import { buildBoardShop } from "./board-shop";
import { openEvents, pickDailyBet, type DailyPick } from "./daily-bet";
import { getData } from "./data";
import { getMaxSpread, getMyBooks } from "./settings-db";
import { MIN_ALERT_EDGE_POINTS } from "./shop-alerts";
import { bestSameGameParlays, sgpGamesFromBoard, type SgpPick } from "./sgp";
import { collapseByOutcome } from "./shop-record";

export interface DailyBetView extends DailyPick {
  /** Graded line-shopping picks the learning drew on, across every market. */
  gradedTotal: number;
  myBooks: string[];
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
  const [games, models, scores, lines, ledger, results, grades, myBooks, maxSpread] =
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
  ]);

  const shop = buildBoardShop(games, lines, models);
  const settled = new Set(results.map((r) => r.event_id));
  const pick = pickDailyBet(shop.rows, {
    myBooks,
    open: openEvents(ledger, settled),
    // One result per outcome: a game quoted well at five books is one piece of evidence,
    // not five, and learning from the raw rows would let it count five times.
    grades: collapseByOutcome(grades),
    maxSpread,
  });
  // Built from the same board and excluded from the same games, so the day's three
  // suggestions never collide with each other or with a bet already standing.
  const taken = openEvents(ledger, settled);
  if (pick.pick) taken.add(pick.pick.row.eventId);
  for (const leg of pick.parlay?.legs ?? []) taken.add(leg.row.eventId);
  const sameGame =
    bestSameGameParlays(sgpGamesFromBoard(shop.rows, { books: myBooks }), models, scores, {
      exclude: taken,
      limit: 1,
      // The same bar the single uses, applied leg by leg. Nothing qualifying is the
      // usual answer, and saying so beats offering a ticket with no edge in it.
      minEdgePoints: MIN_ALERT_EDGE_POINTS,
    })[0] ?? null;

  return { ...pick, gradedTotal: grades.length, myBooks, sameGame };
}
