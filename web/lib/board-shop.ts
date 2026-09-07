import type { BookLineRow } from "./book-lines";
import { quotesForGame } from "./book-lines";
import type { MarginModel } from "./probability";
import { shopAll, type ShopResult } from "./shop";
import type { Game } from "./types";

/**
 * Every cross-book comparison on the board, ranked.
 *
 * The Edges page's original question — does DraftKings' spread agree with DraftKings'
 * own moneyline — has a structural answer of zero, and seven seasons of backfill only
 * made that verdict more confident. This is the question with an answer worth acting
 * on, asked across the whole slate at once.
 *
 * Ranked by expected return per dollar, because that is what decides whether a bet is
 * worth making. A gap in points does not: the vig is charged in dollars, and at -110
 * about 2.4 points of edge buys exactly nothing.
 */

export interface BoardEdge extends ShopResult {
  eventId: string;
  league: Game["league"];
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  homeTeamId: string | null;
  awayTeamId: string | null;
}

export interface BoardShop {
  /** Everything comparable, best return first. */
  rows: BoardEdge[];
  /** The subset that actually clears the vig. Usually empty, and that is the finding. */
  positive: BoardEdge[];
  gamesCompared: number;
  gamesWithSecondBook: number;
  books: string[];
  /** Best return seen anywhere, even when negative — the distance left to cover. */
  best: BoardEdge | null;
}

export function buildBoardShop(
  games: Game[],
  linesByEvent: Map<string, BookLineRow[]>,
  models: Record<string, MarginModel>,
  now: Date = new Date(),
): BoardShop {
  const rows: BoardEdge[] = [];
  const books = new Set<string>();
  let gamesWithSecondBook = 0;

  for (const game of games) {
    // A game already under way is history, not an opportunity.
    if (new Date(game.commenceTime).getTime() <= now.getTime()) continue;

    const stored = linesByEvent.get(game.eventId) ?? [];
    if (stored.length === 0) continue;

    const quotes = quotesForGame(game, stored, "DraftKings", now);
    const distinct = new Set(quotes.filter((q) => !q.stale).map((q) => q.book));
    if (distinct.size < 2) continue;
    gamesWithSecondBook += 1;
    for (const book of distinct) books.add(book);

    const model = models[game.league] ?? null;
    for (const result of shopAll(quotes, model)) {
      // Rows with nothing to compare against carry no information here; the per-game
      // page is where "this book stands alone" is worth saying.
      if (result.booksCompared === 0 || result.stale) continue;
      rows.push({
        ...result,
        eventId: game.eventId,
        league: game.league,
        homeTeam: game.homeTeam ?? "Home",
        awayTeam: game.awayTeam ?? "Away",
        commenceTime: game.commenceTime,
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId,
      });
    }
  }

  rows.sort((a, b) => (b.expectedRoi ?? -Infinity) - (a.expectedRoi ?? -Infinity));

  return {
    rows,
    positive: rows.filter((row) => (row.expectedRoi ?? -1) > 0),
    gamesCompared: games.length,
    gamesWithSecondBook,
    books: [...books].sort(),
    best: rows[0] ?? null,
  };
}
