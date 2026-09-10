import { databaseUrl } from "./env";
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

export const POOLS_KEY = "survivor_pools";

/**
 * Survivor entries and the teams each has already spent.
 *
 * Kept in app_settings as JSON rather than given a table: it is a handful of rows for
 * one person, it changes once a week, and a table would buy nothing but a migration.
 * Validated on read, because it is data that came back from a browser.
 */
export interface StoredPool {
  name: string;
  used: string[];
}

const DEFAULT_POOLS: StoredPool[] = [
  { name: "Pool A", used: [] },
  { name: "Pool B", used: [] },
];

export function parsePools(raw: string | null | undefined): StoredPool[] {
  if (!raw) return DEFAULT_POOLS;
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return DEFAULT_POOLS;
    const pools = value
      .filter((p) => p && typeof p.name === "string")
      .slice(0, 8)
      .map((p) => ({
        name: String(p.name).slice(0, 40),
        used: Array.isArray(p.used)
          ? [...new Set<string>(p.used.map((t: unknown) => String(t).slice(0, 60)))].slice(0, 25)
          : ([] as string[]),
      }));
    return pools.length > 0 ? pools : DEFAULT_POOLS;
  } catch {
    return DEFAULT_POOLS;
  }
}

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
