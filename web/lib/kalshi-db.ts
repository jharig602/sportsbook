/**
 * Reads (and the one owner write, a manual link) for Kalshi's tables -- see `kalshi.ts`
 * for what they mean and `collector/kalshi.py` for how they are filled.
 *
 * Every read degrades to empty when the tables do not exist yet (42P01), so a deploy that
 * lands before the collector's v24 migration shows "no Kalshi data", not an error page.
 */
import { databaseUrl } from "./env";
import { pairSnapshots, type KalshiFlag, type KalshiGame, type KalshiSnapshot } from "./kalshi";
import type { League } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
let pool: any = null;

async function getPool() {
  const url = databaseUrl();
  if (!url) return null;
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  }
  return pool;
}

async function rows(sql: string, params: unknown[] = []): Promise<Record<string, any>[]> {
  const db = await getPool();
  if (!db) return [];
  try {
    return (await db.query(sql, params)).rows;
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  }
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function snapshot(r: Record<string, any>): KalshiSnapshot {
  return {
    eventId: String(r.event_id),
    league: r.league as League,
    side: r.side,
    marketTicker: String(r.market_ticker),
    observedAt: iso(r.observed_at) as string,
    yesBid: num(r.yes_bid),
    yesAsk: num(r.yes_ask),
    bidSize: num(r.bid_size),
    askSize: num(r.ask_size),
    lastPrice: num(r.last_price),
    thin: r.thin === true,
  };
}

/**
 * Each game's latest PREGAME snapshot per side, seen in the last 30 hours (the same
 * freshness book_lines gets). The collector writes nothing after kickoff, so the latest
 * row on a started game is its Kalshi close.
 */
const LATEST = `
  SELECT DISTINCT ON (event_id, side)
         event_id, league, side, market_ticker, observed_at, yes_bid, yes_ask,
         bid_size, ask_size, last_price, thin
    FROM exchange_quotes
   WHERE venue = 'kalshi' AND observed_at > NOW() - INTERVAL '30 hours'
     AND ($1::text IS NULL OR event_id = $1)
   ORDER BY event_id, side, observed_at DESC`;

export async function kalshiGames(eventId: string | null = null): Promise<Map<string, KalshiGame>> {
  return pairSnapshots((await rows(LATEST, [eventId])).map(snapshot));
}

/** Kalshi's two contracts for one game as they stood at `at` (latest at or before it). */
export async function kalshiAt(eventId: string, at: string): Promise<KalshiGame | null> {
  const found = await rows(
    `SELECT DISTINCT ON (side)
            event_id, league, side, market_ticker, observed_at, yes_bid, yes_ask,
            bid_size, ask_size, last_price, thin
       FROM exchange_quotes
      WHERE venue = 'kalshi' AND event_id = $1 AND observed_at <= $2
      ORDER BY side, observed_at DESC`,
    [eventId, at],
  );
  return pairSnapshots(found.map(snapshot)).get(eventId) ?? null;
}

function flag(r: Record<string, any>): KalshiFlag {
  return {
    flagId: String(r.flag_id),
    observedAt: iso(r.observed_at) as string,
    league: r.league as League,
    eventId: String(r.event_id),
    commenceTime: iso(r.commence_time),
    kind: r.kind,
    side: r.side,
    book: r.book ?? null,
    bookPrice: num(r.book_price),
    bookFair: num(r.book_fair),
    kalshiFair: Number(r.kalshi_fair),
    kalshiCost: num(r.kalshi_cost),
    consensus: num(r.consensus),
    edgePoints: Number(r.edge_points),
    books: Number(r.books),
  };
}

const FLAG_COLUMNS = `flag_id, observed_at, league, event_id, commence_time, kind, side, book,
  book_price, book_fair, kalshi_fair, kalshi_cost, consensus, edge_points, books`;

/** Flags on games still to start -- every kind; gate with `visibleFlags` before showing. */
export async function openFlags(eventId: string | null = null): Promise<KalshiFlag[]> {
  return (
    await rows(
      `SELECT ${FLAG_COLUMNS} FROM exchange_flags
        WHERE venue = 'kalshi' AND commence_time > NOW()
          AND ($1::text IS NULL OR event_id = $1)
        ORDER BY edge_points DESC`,
      [eventId],
    )
  ).map(flag);
}

export interface ShadowRow extends KalshiFlag {
  /** Did the flagged side win? Null until the game has a final score. */
  sideWon: boolean | null;
}

/** Every flag 2 and 3 ever recorded, with the result once known: the shadow log. */
export async function shadowLog(): Promise<ShadowRow[]> {
  return (
    await rows(
      `SELECT ${FLAG_COLUMNS.split(",").map((c) => `f.${c.trim()}`).join(", ")},
              r.home_score, r.away_score
         FROM exchange_flags f
         LEFT JOIN game_results r ON r.event_id = f.event_id
        WHERE f.venue = 'kalshi' AND f.kind IN ('kalshi_value', 'arb')
        ORDER BY f.observed_at DESC`,
    )
  ).map((r) => {
    const base = flag(r);
    const home = num(r.home_score);
    const away = num(r.away_score);
    const sideWon =
      home === null || away === null || home === away ? null : base.side === "home" ? home > away : away > home;
    return { ...base, sideWon };
  });
}

export interface UnmatchedEvent {
  eventTicker: string;
  league: League;
  title: string;
  gameDate: string | null;
  reason: string;
}

export async function unmatchedEvents(): Promise<UnmatchedEvent[]> {
  return (
    await rows(
      `SELECT event_ticker, league, title, game_date, reason FROM exchange_unmatched
        WHERE venue = 'kalshi' ORDER BY game_date, title`,
    )
  ).map((r) => ({
    eventTicker: String(r.event_ticker),
    league: r.league as League,
    title: String(r.title ?? r.event_ticker),
    gameDate: r.game_date instanceof Date ? r.game_date.toISOString().slice(0, 10) : r.game_date ? String(r.game_date).slice(0, 10) : null,
    reason: String(r.reason),
  }));
}

/** Board games (by event id) that have ANY Kalshi snapshot in the last 30 hours. */
export async function eventsWithKalshi(): Promise<Set<string>> {
  return new Set(
    (await rows(`SELECT DISTINCT event_id FROM exchange_quotes WHERE venue = 'kalshi' AND observed_at > NOW() - INTERVAL '30 hours'`)).map(
      (r) => String(r.event_id),
    ),
  );
}

/** Link a Kalshi event to a board game by hand. The collector applies it on its next run. */
export async function linkEvent(eventTicker: string, eventId: string, league: League): Promise<void> {
  const db = await getPool();
  if (!db) throw new Error("No database URL is configured.");
  await db.query(
    `INSERT INTO exchange_links (event_ticker, venue, league, event_id, linked_at)
     VALUES ($1, 'kalshi', $2, $3, NOW())
     ON CONFLICT (event_ticker) DO UPDATE SET event_id = EXCLUDED.event_id, league = EXCLUDED.league,
                                              linked_at = EXCLUDED.linked_at`,
    [eventTicker, league, eventId],
  );
}

/** Every stored snapshot for these games, for Kalshi-at-bet-time and at-kickoff on the ledger. */
export async function kalshiHistory(eventIds: string[]): Promise<Map<string, KalshiSnapshot[]>> {
  const out = new Map<string, KalshiSnapshot[]>();
  if (eventIds.length === 0) return out;
  for (const r of await rows(
    `SELECT event_id, league, side, market_ticker, observed_at, yes_bid, yes_ask,
            bid_size, ask_size, last_price, thin
       FROM exchange_quotes WHERE venue = 'kalshi' AND event_id = ANY($1::text[])
      ORDER BY observed_at`,
    [eventIds],
  )) {
    const s = snapshot(r);
    out.set(s.eventId, [...(out.get(s.eventId) ?? []), s]);
  }
  return out;
}
