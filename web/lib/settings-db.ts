import { DEFAULT_MAX_SPREAD, parseMaxSpread } from "./blowout";
import { parseFavourites, serializeFavourites } from "./favourites";
import { databaseUrl } from "./env";
import { DEFAULT_POOLS, parsePools, type StoredPool } from "./pools";
import { parseMyBooks, serializeMyBooks } from "./my-books";
import type { NotifiedOffer } from "./shop-alerts";

/**
 * Preferences and notification bookkeeping that must live outside the browser.
 *
 * "Which books do I hold an account at" started as a cookie, which is exactly right
 * for rendering a page and useless for a notification: the dispatcher runs from cron,
 * with no request and no cookie behind it. A preference that only the browser knows
 * cannot be consulted when deciding whether to make a phone buzz.
 */

export const MY_BOOKS_KEY = "my_books";

/* eslint-disable @typescript-eslint/no-explicit-any */
let pool: any = null;

async function getPool() {
  const url = databaseUrl();
  if (!url) throw new Error("No database URL is configured.");
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  }
  return pool;
}

/** Missing table or no row both mean "not chosen yet", which is not an error. */
export async function getMyBooks(): Promise<string[]> {
  if (!databaseUrl()) return [];
  try {
    const db = await getPool();
    const result = await db.query("SELECT value FROM app_settings WHERE key = $1", [
      MY_BOOKS_KEY,
    ]);
    return parseMyBooks(result.rows[0]?.value ?? null);
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  }
}

export async function setMyBooks(books: string[]): Promise<string[]> {
  const db = await getPool();
  const value = serializeMyBooks(books);
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [MY_BOOKS_KEY, value],
  );
  return parseMyBooks(value);
}

/**
 * Offers already pushed, so the same one never buzzes twice.
 *
 * Scoped to games that have not finished — an offer on last week's game can never
 * recur, and keeping it would grow the comparison set without bound.
 */
export async function notifiedOffers(): Promise<NotifiedOffer[]> {
  if (!databaseUrl()) return [];
  try {
    const db = await getPool();
    const result = await db.query(
      `SELECT offer_key, last_roi FROM shop_notifications
        WHERE notified_at > NOW() - INTERVAL '14 days'`,
    );
    return (result.rows as { offer_key: string; last_roi: number | string }[]).map((r) => ({
      offer_key: r.offer_key,
      last_roi: typeof r.last_roi === "string" ? Number(r.last_roi) : r.last_roi,
    }));
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  }
}

export async function recordNotified(
  rows: Array<{
    offer_key: string;
    event_id: string;
    book: string;
    market: string;
    side: string;
    /** The edge in points. Stored in the column still named `last_roi`. */
    edge: number;
  }>,
): Promise<void> {
  if (rows.length === 0) return;
  const db = await getPool();
  for (const row of rows) {
    await db.query(
      `INSERT INTO shop_notifications
         (offer_key, event_id, book, market, side, last_roi, notified_at)
       VALUES ($1, $2, $3, $4, $5, $6, NOW())
       ON CONFLICT (offer_key) DO UPDATE
         SET last_roi = EXCLUDED.last_roi, notified_at = NOW()`,
      [row.offer_key, row.event_id, row.book, row.market, row.side, row.edge],
    );
  }
}

export { poolLabel, parsePools, type StoredPool } from "./pools";

export const POOLS_KEY = "survivor_pools";

export async function getPools(): Promise<StoredPool[]> {
  if (!databaseUrl()) return DEFAULT_POOLS;
  try {
    const db = await getPool();
    const result = await db.query("SELECT value FROM app_settings WHERE key = $1", [POOLS_KEY]);
    return parsePools(result.rows[0]?.value ?? null);
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return DEFAULT_POOLS;
    throw error;
  }
}

export async function setPools(pools: StoredPool[]): Promise<StoredPool[]> {
  const db = await getPool();
  const cleaned = parsePools(JSON.stringify(pools));
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [POOLS_KEY, JSON.stringify(cleaned)],
  );
  return cleaned;
}

/** Whether a survivor reminder has already gone out for this week and window. */
export async function survivorSent(week: number, window: string): Promise<boolean> {
  if (!databaseUrl()) return false;
  try {
    const db = await getPool();
    const result = await db.query(
      "SELECT 1 FROM survivor_notifications WHERE week = $1 AND send_window = $2",
      [week, window],
    );
    return result.rows.length > 0;
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return false;
    throw error;
  }
}

export async function recordSurvivorSent(
  week: number,
  window: string,
  picks: unknown,
): Promise<void> {
  const db = await getPool();
  await db.query(
    `INSERT INTO survivor_notifications (week, send_window, picks_json, sent_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (week, send_window) DO UPDATE
       SET picks_json = EXCLUDED.picks_json, sent_at = NOW()`,
    [week, window, JSON.stringify(picks)],
  );
}

/**
 * The Central date the bet of the day last went out.
 *
 * A separate key from the old promotion reminder's on purpose: that one may already hold
 * today's date, and reusing it would silently skip the first bet-of-the-day notification.
 */
export const DAILY_SENT_KEY = "daily_bet_last_sent";

export async function dailySentOn(): Promise<string | null> {
  if (!databaseUrl()) return null;
  try {
    const db = await getPool();
    const result = await db.query("SELECT value FROM app_settings WHERE key = $1", [
      DAILY_SENT_KEY,
    ]);
    const value = result.rows[0]?.value;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return null;
    throw error;
  }
}

export async function recordDailySent(date: string): Promise<void> {
  const db = await getPool();
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [DAILY_SENT_KEY, date],
  );
}

export const MAX_SPREAD_KEY = "max_spread";

/**
 * How lopsided a game may be before its prices stop being shown.
 *
 * Stored rather than kept in the URL because the notification has to obey it too: a
 * board that hides a 56-point mismatch while the push recommends one is worse than
 * either behaviour on its own.
 */
export async function getMaxSpread(): Promise<number> {
  if (!databaseUrl()) return DEFAULT_MAX_SPREAD;
  try {
    const db = await getPool();
    const result = await db.query("SELECT value FROM app_settings WHERE key = $1", [
      MAX_SPREAD_KEY,
    ]);
    return parseMaxSpread(result.rows[0]?.value ?? null);
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return DEFAULT_MAX_SPREAD;
    throw error;
  }
}

export async function setMaxSpread(points: number): Promise<number> {
  const db = await getPool();
  const value = parseMaxSpread(String(points));
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [MAX_SPREAD_KEY, String(value)],
  );
  return value;
}

export const FAVOURITES_KEY = "favourite_teams";

/**
 * Teams you back every week regardless of the board.
 *
 * Server-side for the same reason "my books" is: a preference only the browser knows
 * cannot be consulted when deciding what a notification should say.
 */
export async function getFavourites(): Promise<string[]> {
  if (!databaseUrl()) return [];
  try {
    const db = await getPool();
    const result = await db.query("SELECT value FROM app_settings WHERE key = $1", [
      FAVOURITES_KEY,
    ]);
    return parseFavourites(result.rows[0]?.value ?? null);
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  }
}

export async function setFavourites(teams: string[]): Promise<string[]> {
  const db = await getPool();
  const value = serializeFavourites(teams);
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [FAVOURITES_KEY, value],
  );
  return parseFavourites(value);
}

export const FAVOURITE_SENT_KEY = "favourite_pushes_sent";

/** How many announced games are remembered. A season of one team's games, with room. */
const FAVOURITE_SENT_KEEP = 40;

/**
 * Games already announced to your phone, by `favouriteKey`.
 *
 * Remembered per game rather than per date, because the question is "has this game been
 * announced", and a game's window can span two calendar days.
 */
export async function favouritePushesSent(): Promise<Set<string>> {
  if (!databaseUrl()) return new Set();
  try {
    const db = await getPool();
    const result = await db.query("SELECT value FROM app_settings WHERE key = $1", [
      FAVOURITE_SENT_KEY,
    ]);
    const raw = result.rows[0]?.value;
    if (typeof raw !== "string" || raw.length === 0) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return new Set();
    if (error instanceof SyntaxError) return new Set();
    throw error;
  }
}

export async function recordFavouritePushSent(key: string): Promise<void> {
  const existing = [...(await favouritePushesSent())].filter((k) => k !== key);
  const next = [...existing, key].slice(-FAVOURITE_SENT_KEEP);
  const db = await getPool();
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [FAVOURITE_SENT_KEY, JSON.stringify(next)],
  );
}

/**
 * Failed passcode attempts in the last hour, for the rate limit.
 *
 * `null` means the check could not be made. The caller treats that as locked -- a limit
 * that switches itself off whenever the database hiccups is a limit an attacker only has
 * to wait for. A missing table is the one exception, returned as an empty list: that is a
 * deploy that ran ahead of its migration, not an attack.
 */
export async function recentUnlockFailures(): Promise<
  Array<{ sourceHash: string; at: Date }> | null
> {
  if (!databaseUrl()) return [];
  try {
    const db = await getPool();
    const result = await db.query(
      `SELECT source_hash, attempted_at FROM unlock_attempts
        WHERE attempted_at > NOW() - INTERVAL '60 minutes'`,
    );
    return (result.rows as Array<{ source_hash: string; attempted_at: Date | string }>).map(
      (row) => ({
        sourceHash: String(row.source_hash),
        at: row.attempted_at instanceof Date ? row.attempted_at : new Date(row.attempted_at),
      }),
    );
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return [];
    return null;
  }
}

/** Remember one wrong guess, and forget anything older than a day while here. */
export async function recordUnlockFailure(sourceHash: string): Promise<void> {
  if (!databaseUrl()) return;
  const db = await getPool();
  await db.query("INSERT INTO unlock_attempts (attempted_at, source_hash) VALUES (NOW(), $1)", [
    sourceHash,
  ]);
  await db.query("DELETE FROM unlock_attempts WHERE attempted_at < NOW() - INTERVAL '1 day'");
}

export const RESULT_SENT_KEY = "result_pushes_sent";

/** Results remembered as announced. A few busy weekends of tickets, with room. */
const RESULT_SENT_KEEP = 500;

/**
 * Results already announced, by `ResultMessage.key`.
 *
 * Only results inside the 36-hour window are ever considered, so the list only has to
 * outlast that window; the cap keeps it from growing for ever.
 */
export async function resultPushesSent(): Promise<Set<string>> {
  if (!databaseUrl()) return new Set();
  try {
    const db = await getPool();
    const result = await db.query("SELECT value FROM app_settings WHERE key = $1", [
      RESULT_SENT_KEY,
    ]);
    const raw = result.rows[0]?.value;
    if (typeof raw !== "string" || raw.length === 0) return new Set();
    const parsed = JSON.parse(raw);
    return new Set(Array.isArray(parsed) ? parsed.map(String) : []);
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return new Set();
    if (error instanceof SyntaxError) return new Set();
    throw error;
  }
}

export async function recordResultPushesSent(keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const existing = [...(await resultPushesSent())].filter((k) => !keys.includes(k));
  const next = [...existing, ...keys].slice(-RESULT_SENT_KEEP);
  const db = await getPool();
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [RESULT_SENT_KEY, JSON.stringify(next)],
  );
}
