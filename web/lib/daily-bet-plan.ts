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

export interface DailyBetView extends DailyPick {
  /** Graded line-shopping picks the learning drew on, across every market. */
  gradedTotal: number;
  myBooks: string[];
}

export async function dailyBet(ownerId: string): Promise<DailyBetView> {
  const data = getData();
  const [games, models, lines, ledger, results, grades, myBooks, maxSpread] = await Promise.all([
    data.games(),
    data.marginModels(),
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
    grades,
    maxSpread,
  });
  return { ...pick, gradedTotal: grades.length, myBooks };
}
