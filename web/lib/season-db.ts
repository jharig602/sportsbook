import { databaseUrl } from "./env";
import type { SeasonGame } from "./survivor";

/**
 * The season as the odds feed sees it.
 *
 * Separate from `book_lines` because that table is keyed on ESPN event ids and only
 * holds games matched to our board. A survivor pool needs week 12 to exist in
 * September, so this keeps every fixture the feed returns whether or not it matched.
 */

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

const SEASON = `
  SELECT feed_event_id, commence_time, home_team, away_team, home_spread, books
    FROM season_games
   WHERE league = $1 AND commence_time > NOW()
   ORDER BY commence_time
`;

/** Upcoming fixtures only: a survivor pick is about weeks you have not played yet. */
export async function seasonGames(league = "nfl"): Promise<SeasonGame[]> {
  if (!databaseUrl()) return [];
  try {
    const db = await getPool();
    const result = await db.query(SEASON, [league]);
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      feedEventId: String(row.feed_event_id),
      commenceTime:
        row.commence_time instanceof Date
          ? row.commence_time.toISOString()
          : String(row.commence_time),
      homeTeam: String(row.home_team),
      awayTeam: String(row.away_team),
      homeSpread:
        row.home_spread === null || row.home_spread === undefined
          ? null
          : Number(row.home_spread),
      books: Number(row.books ?? 0),
    }));
  } catch (error) {
    // The table arrives with schema v7; an older database simply has no season yet.
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  }
}
