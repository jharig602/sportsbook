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

/**
 * Share of survivor entrants taking each team, for one week.
 *
 * Empty when nothing has been collected, which the caller must treat as "no basis for
 * preferring an unpopular team" rather than "nobody picked anything".
 */
/**
 * Which NFL week the upcoming slate is, counted from the season opener.
 *
 * This MUST agree with `current_week` in `collector/pick_popularity.py`, which files
 * each week's pick shares under this number — the same formula, from the same column,
 * for the same reason. If the two drift, `pickPopularity` reads a different week than
 * the collector wrote and quietly returns last week's shares against this week's teams:
 * plausible numbers, wrong slate, and nothing anywhere says so.
 *
 * Note it is deliberately NOT the planner's week index. The planner numbers from the
 * next unplayed week, so its week 1 is week 7 of the season in November.
 */
/**
 * The season's first kickoff, which is what every week number counts from.
 *
 * No time filter: the opener does not move, and anything derived from "the earliest
 * fixture still to come" would renumber the season every week -- which is exactly the
 * bug this exists to remove.
 */
export async function seasonOpener(league = "nfl"): Promise<string | null> {
  if (!databaseUrl()) return null;
  try {
    const db = await getPool();
    const result = await db.query(
      "SELECT MIN(commence_time) AS opener FROM season_games WHERE league = $1",
      [league],
    );
    const opener = result.rows[0]?.opener;
    if (!opener) return null;
    const first = opener instanceof Date ? opener : new Date(String(opener));
    return Number.isNaN(first.getTime()) ? null : first.toISOString();
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return null;
    throw error;
  }
}

export async function currentNflWeek(league = "nfl"): Promise<number> {
  const opener = await seasonOpener(league);
  if (opener === null) return 1;
  return nflWeek(opener, new Date());
}

/**
 * The NFL week `now` falls in: weeks run Tuesday to Monday, turning over at 12:00 UTC
 * Tuesday (8 AM Eastern), counted from the week of the opener.
 *
 * It used to count seven-day blocks from the opener's Thursday-night kickoff, which said
 * "last week" from every Tuesday until Thursday night -- so the popularity collector
 * (same formula) filed each new week's shares under the previous week and overwrote its
 * real ones. Mirrors `nfl_week` in collector/pick_popularity.py; change both together.
 */
export function nflWeek(openerIso: string, now: Date): number {
  const opener = new Date(openerIso);
  const eastern = new Date(opener.getTime() - 5 * 3_600_000);
  const sinceTuesday = (eastern.getUTCDay() - 2 + 7) % 7;
  const anchor = Date.UTC(eastern.getUTCFullYear(), eastern.getUTCMonth(), eastern.getUTCDate() - sinceTuesday, 12);
  if (now.getTime() <= anchor) return 1;
  return Math.floor((now.getTime() - anchor) / (7 * 86_400_000)) + 1;
}

export async function pickPopularity(week: number, league = "nfl"): Promise<Record<string, number>> {
  if (!databaseUrl()) return {};
  try {
    const db = await getPool();
    const result = await db.query(
      "SELECT team, pick_share FROM pick_popularity WHERE league = $1 AND week = $2",
      [league, week],
    );
    const out: Record<string, number> = {};
    for (const row of result.rows as { team: string; pick_share: number | string }[]) {
      out[row.team] = typeof row.pick_share === "string" ? Number(row.pick_share) : row.pick_share;
    }
    return out;
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return {};
    throw error;
  }
}
