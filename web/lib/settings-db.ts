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
    roi: number;
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
      [row.offer_key, row.event_id, row.book, row.market, row.side, row.roi],
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

export const PROMO_SENT_KEY = "promo_last_sent";

/**
 * The Central date the daily promo reminder last went out, or null.
 *
 * Kept in app_settings rather than given a table: it is one string, rewritten once a
 * day. What it buys is that the reminder no longer has to be lucky. The dispatcher can
 * run on every collect tick and this is what stops it buzzing twice.
 */
export async function promoSentOn(): Promise<string | null> {
  if (!databaseUrl()) return null;
  try {
    const db = await getPool();
    const result = await db.query("SELECT value FROM app_settings WHERE key = $1", [
      PROMO_SENT_KEY,
    ]);
    const value = result.rows[0]?.value;
    return typeof value === "string" && value.length > 0 ? value : null;
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return null;
    throw error;
  }
}

export async function recordPromoSent(date: string): Promise<void> {
  const db = await getPool();
  await db.query(
    `INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [PROMO_SENT_KEY, date],
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
