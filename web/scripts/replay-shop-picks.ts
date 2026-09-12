/**
 * Reconstruct the cross-book board from stored history and record what the rule
 * would have said, at the moment it would have said it.
 *
 * The shop rule went a season ungraded, so its record starts at zero — but the evidence
 * to grade it is already in the database. `book_lines` and `odds_snapshots` are both
 * append-only and both carry `observed_at`, so the board at any past moment can be
 * rebuilt exactly, and games that have already finished can be scored tonight instead
 * of in three weeks.
 *
 * **This runs the real rule, not a reimplementation.** `buildBoardShop` and `shop.ts`
 * are imported, not copied. The only thing that changes is the two queries, which gain
 * an `observed_at <= T` clause. A second implementation of the pricing would be a second
 * thing to keep in step, and the first sign of a drift would be a shop record that
 * disagreed with the shop page about the same game.
 *
 * `buildBoardShop` already takes `now`, so passing the historical timestamp makes it
 * skip games that had already kicked off at that moment — exactly as it does live. No
 * special-casing, and no risk of recording an "edge" on a game in progress.
 *
 * What it cannot fix, and therefore flags: the margin model is the one fitted today. If
 * `historical_lines` holds any of the games being replayed, the density that prices a
 * point has partly seen its own answers. Every row written here sets `replayed`, so the
 * two populations can always be pulled apart.
 *
 * Idempotent. Picks are keyed by a hash of the offer, so re-running adds only what was
 * genuinely missing and the first sighting of each edge is what survives.
 */
import { buildBoardShop } from "../lib/board-shop";
import { buildBoard } from "../lib/data";
import { recordShopPicks } from "../lib/shop-picks";
import type { BookLineRow } from "../lib/book-lines";
import type { MarginModel } from "../lib/probability";

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Read from the environment, never argv, so it stays out of shell history and `ps`. */
const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set. Refusing to run: there is nothing to replay.");
  process.exit(2);
}

const { Pool } = await import("pg");
const db = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const result = await db.query(sql, params);
  return result.rows as T[];
}

function normalise(raw: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value instanceof Date) row[key] = value.toISOString();
    else if (typeof value === "string" && (key === "price" || key === "line")) {
      row[key] = Number(value);
    } else row[key] = value;
  }
  return row;
}

/**
 * Every moment the feed wrote a quote.
 *
 * Rounded to the minute and de-duplicated: one poll writes hundreds of rows within a
 * few seconds, and replaying each row's timestamp separately would rebuild the same
 * board hundreds of times for nothing.
 */
const CYCLES = `
SELECT DISTINCT date_trunc('minute', observed_at) AS t
  FROM book_lines
 WHERE source <> 'espn'
 ORDER BY t`;

/** The board as it stood at T. Identical to LATEST_QUOTES but bounded above. */
const BOARD_AS_OF = `
WITH ranked AS (
    SELECT event_id, league, commence_time, home_team, away_team,
           home_team_id, away_team_id, market, side, line, price, observed_at,
           row_number() OVER (PARTITION BY event_id, market, side
                              ORDER BY observed_at DESC) AS rn
      FROM odds_snapshots
     WHERE observation_kind = 'pregame_observation' AND observed_at <= $1
)
SELECT event_id, league, commence_time, home_team, away_team,
       home_team_id, away_team_id, market, side, line, price, observed_at
  FROM ranked WHERE rn = 1`;

/**
 * Every book's latest quote at T.
 *
 * The 48-hour window mirrors the live query rather than being dropped, because it is
 * part of the rule: a quote older than that is not a second opinion, it is a stale
 * number that would sit in the consensus and corrupt it. Replaying without the window
 * would price against quotes the live board would have refused.
 */
const LINES_AS_OF = `
SELECT DISTINCT ON (b.event_id, b.book, b.market, b.side)
       b.quote_id, b.observed_at, b.league, b.event_id, b.book, b.market, b.side,
       b.line, b.price, b.source, b.note
  FROM book_lines b
 WHERE b.observed_at <= $1 AND b.observed_at > $1::timestamptz - INTERVAL '48 hours'
 ORDER BY b.event_id, b.book, b.market, b.side, b.observed_at DESC`;

const MODELS = `SELECT league, games, mean, sd, lo, hi, pmf_json, buckets_json FROM margin_models`;

async function main(): Promise<number> {
  const ruleRows = await query<{ rule_version_id: string }>(
    "SELECT rule_version_id FROM active_rule WHERE id = 1",
  );
  const ruleVersion = ruleRows[0]?.rule_version_id;
  if (!ruleVersion) {
    console.error("No active rule version. The pipeline has never run; nothing to stamp.");
    return 2;
  }

  const models: Record<string, MarginModel> = {};
  for (const row of await query<any>(MODELS)) {
    models[row.league] = {
      league: row.league,
      games: Number(row.games),
      mean: Number(row.mean),
      sd: Number(row.sd),
      lo: Number(row.lo),
      hi: Number(row.hi),
      pmf: JSON.parse(row.pmf_json),
      buckets: row.buckets_json ? JSON.parse(row.buckets_json) : null,
    } as MarginModel;
  }

  const cycles = await query<{ t: Date }>(CYCLES);
  let written = 0;
  let positiveSeen = 0;
  const cycleSummaries: Array<{ at: string; positive: number; written: number }> = [];

  for (const { t } of cycles) {
    const at = t instanceof Date ? t.toISOString() : String(t);
    const [boardRows, lineRows] = await Promise.all([
      query<any>(BOARD_AS_OF, [at]),
      query<any>(LINES_AS_OF, [at]),
    ]);

    const byEvent = new Map<string, BookLineRow[]>();
    for (const raw of lineRows) {
      const row = normalise(raw) as unknown as BookLineRow;
      const bucket = byEvent.get(row.event_id);
      if (bucket) bucket.push(row);
      else byEvent.set(row.event_id, [row]);
    }

    const games = buildBoard(boardRows.map((r) => normalise(r)) as any);
    // `now` is the historical moment, so games already under way at T are skipped
    // exactly as they would have been live.
    const shop = buildBoardShop(games, byEvent, models, new Date(at));
    positiveSeen += shop.positive.length;
    if (shop.positive.length === 0) continue;

    const result = await recordShopPicks(shop.positive, ruleVersion, at, true);
    written += result.written;
    if (result.written > 0) {
      cycleSummaries.push({ at, positive: shop.positive.length, written: result.written });
    }
  }

  console.log(
    JSON.stringify({
      type: "shop_replay_summary",
      ran_at: new Date().toISOString(),
      rule_version: ruleVersion,
      cycles: cycles.length,
      positive_rows_seen: positiveSeen,
      picks_written: written,
      first_cycle: cycles[0] ? String(cycles[0].t) : null,
      last_cycle: cycles.at(-1) ? String(cycles.at(-1)!.t) : null,
      cycles_that_added: cycleSummaries.length,
    }),
  );

  // 3 means "ran clean but wrote nothing", matching the collector's convention.
  return written > 0 ? 0 : 3;
}

const code = await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  return 2;
});
await db.end();
process.exit(code);
