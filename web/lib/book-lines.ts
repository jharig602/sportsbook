import { randomUUID } from "node:crypto";

import { databaseUrl } from "./env";
import type { BookQuote } from "./shop";
import type { Game, Market, Side } from "./types";

/**
 * Storing second opinions.
 *
 * ESPN returns exactly one book, so nothing it provides can ever disagree with
 * anything. This table is where a second number arrives — typed off your own book, or
 * pulled from an odds feed — and both land in the same shape so they price identically.
 *
 * Append-only, and read as "latest row per book". A line that moved and came back is
 * not the same as a line that never moved, and only keeping every observation tells
 * them apart. The cost of that is one window function; the alternative throws away the
 * movement this whole app exists to watch.
 */

export const MANUAL_SOURCE = "manual";

/**
 * How old a quote may be and still price against the current board.
 *
 * Books move. A number recorded on Tuesday is not a second opinion about Sunday's
 * line, it is a stale one, and the gap it opens against a live quote reads as an edge
 * when it is only elapsed time. Twenty-four hours is generous for a hand-typed entry
 * and comfortably longer than the feed's own polling interval near kickoff.
 */
/**
 * **This must exceed the collector's slowest polling interval, or the board empties
 * between polls.** It did not. Both were 24 hours, so college quotes expired at
 * precisely the moment they were due to be refreshed, and any delay -- GitHub drops
 * and delays scheduled runs routinely -- left the board blank. Caught live at "last
 * polled 23.2h ago", showing 16 games on a board that had 69.
 *
 * The collector's far interval is 24h (INTERVAL_FAR_HOURS in collector/shop_lines.py),
 * so 30 leaves six hours of slack for a late workflow. Midweek lines barely move over
 * that span, and every row shows its own age regardless.
 */
export const FRESHNESS_HOURS = 30;

export interface BookLineRow {
  quote_id: string;
  observed_at: string;
  league: string;
  event_id: string;
  book: string;
  market: Market;
  side: Side;
  line: number | null;
  price: number | null;
  source: string;
  note: string | null;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
let pool: any = null;

async function getPool() {
  const url = databaseUrl();
  if (!url) {
    throw new Error(
      "No database URL is configured, so a line cannot be saved. A number that looks " +
        "recorded but is not would quietly corrupt every comparison built on it.",
    );
  }
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  }
  return pool;
}

export interface NewBookLine {
  league: string;
  event_id: string;
  book: string;
  market: Market;
  side: Side;
  line: number | null;
  price: number | null;
  source?: string;
  note?: string | null;
}

export async function saveBookLine(row: NewBookLine): Promise<string> {
  const db = await getPool();
  const quoteId = randomUUID();
  await db.query(
    `INSERT INTO book_lines
       (quote_id, observed_at, league, event_id, book, market, side, line, price, source, note)
     VALUES ($1, NOW(), $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [
      quoteId,
      row.league,
      row.event_id,
      row.book,
      row.market,
      row.side,
      row.line,
      row.price,
      row.source ?? MANUAL_SOURCE,
      row.note ?? null,
    ],
  );
  return quoteId;
}

/**
 * The most recent quote from each book, for one game.
 *
 * Superseded rows stay in the table but never reach a comparison — pricing a stale
 * number against a live one would invent a gap that closed hours ago.
 */
const LATEST_PER_BOOK = `
  SELECT DISTINCT ON (book, market, side)
         quote_id, observed_at, league, event_id, book, market, side, line, price, source, note
    FROM book_lines
   WHERE event_id = $1
   ORDER BY book, market, side, observed_at DESC
`;

export async function bookLinesFor(eventId: string): Promise<BookLineRow[]> {
  const db = await getPool();
  try {
    const result = await db.query(LATEST_PER_BOOK, [eventId]);
    return (result.rows as Record<string, unknown>[]).map((row) => {
      const out: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(row)) {
        if (value instanceof Date) out[key] = value.toISOString();
        else if ((key === "price" || key === "line") && typeof value === "string") {
          out[key] = Number(value);
        } else out[key] = value;
      }
      return out as unknown as BookLineRow;
    });
  } catch (error) {
    // The table arrives with schema v4. An older database should show the board
    // without a comparison rather than 500 on a page that otherwise works.
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  }
}

const OPPOSITE: Record<Side, Side> = {
  home: "away",
  away: "home",
  over: "under",
  under: "over",
};

/**
 * Everything known about one game, as quotes ready to shop.
 *
 * The board's own DraftKings numbers are folded in here rather than copied into
 * `book_lines`. Two rows claiming to be the same book's line is a synchronisation
 * problem waiting to happen, and the snapshot is already the authority on what DK
 * shows. Deriving it means a manual entry always has something to compare against on
 * the first save, which is the whole point of typing one in.
 */
export function quotesForGame(
  game: Game | undefined,
  stored: BookLineRow[],
  feedBook = "DraftKings",
  now: Date = new Date(),
): BookQuote[] {
  const cutoff = now.getTime() - FRESHNESS_HOURS * 3600 * 1000;
  const isStale = (observedAt: string | null | undefined) => {
    if (!observedAt) return false;
    const seen = new Date(observedAt).getTime();
    // An unparseable timestamp is not evidence of staleness; leaving it in is the
    // lesser error, and the row still shows when it claims to have been seen.
    return Number.isFinite(seen) && seen < cutoff;
  };

  const quotes: BookQuote[] = [];

  if (game) {
    for (const market of ["spread", "total", "moneyline"] as Market[]) {
      const book = game[market];
      for (const [side, quote] of Object.entries(book) as [Side, { line: number | null; price: number | null }][]) {
        if (quote.price === null && quote.line === null) continue;
        quotes.push({
          book: feedBook,
          market,
          side,
          line: market === "moneyline" ? null : quote.line,
          price: quote.price,
          oppositePrice: book[OPPOSITE[side]]?.price ?? null,
          observedAt: game.lastObserved,
          stale: isStale(game.lastObserved),
        });
      }
    }
  }

  // A stored row for the feed's own book would shadow the snapshot and produce a
  // book compared against itself, whose gap is zero by construction.
  const seen = new Set(quotes.map((q) => `${q.book}:${q.market}:${q.side}`));

  for (const row of stored) {
    const key = `${row.book}:${row.market}:${row.side}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const opposite = stored.find(
      (other) =>
        other.book === row.book &&
        other.market === row.market &&
        other.side === OPPOSITE[row.side],
    );
    quotes.push({
      book: row.book,
      market: row.market,
      side: row.side,
      line: row.market === "moneyline" ? null : row.line,
      price: row.price,
      oppositePrice: opposite?.price ?? null,
      observedAt: row.observed_at,
      stale: isStale(row.observed_at),
    });
  }

  return quotes;
}

/**
 * The latest quote from every book, across every game at once.
 *
 * The per-game read answers "what does this game look like"; this answers the question
 * a weekend of collection actually poses — "did anything, anywhere, disagree enough to
 * be worth a bet". Without it the only way to find out is to open sixty-six pages,
 * which means the answer is in the database and nowhere a person will ever see it.
 *
 * Scoped to games that have not started. A gap on a game already kicked off is history,
 * not an opportunity.
 */
const LATEST_ALL = `
  SELECT DISTINCT ON (b.event_id, b.book, b.market, b.side)
         b.quote_id, b.observed_at, b.league, b.event_id, b.book, b.market, b.side,
         b.line, b.price, b.source, b.note
    FROM book_lines b
   WHERE b.observed_at > NOW() - INTERVAL '48 hours'
   ORDER BY b.event_id, b.book, b.market, b.side, b.observed_at DESC
`;

export async function allBookLines(): Promise<Map<string, BookLineRow[]>> {
  const byEvent = new Map<string, BookLineRow[]>();
  let db;
  try {
    db = await getPool();
  } catch {
    // No database configured (the fixture backend). An empty map is the honest
    // answer: nothing has been collected, rather than an error on a working page.
    return byEvent;
  }
  try {
    const result = await db.query(LATEST_ALL);
    for (const raw of result.rows as Record<string, unknown>[]) {
      const row: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(raw)) {
        if (value instanceof Date) row[key] = value.toISOString();
        else if ((key === "price" || key === "line") && typeof value === "string") {
          row[key] = Number(value);
        } else row[key] = value;
      }
      const typed = row as unknown as BookLineRow;
      const bucket = byEvent.get(typed.event_id);
      if (bucket) bucket.push(typed);
      else byEvent.set(typed.event_id, [typed]);
    }
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return byEvent;
    throw error;
  }
  return byEvent;
}
