/**
 * Data layer with two interchangeable backends.
 *
 * Production reads Neon. Until that database exists, a JSON fixture exported from the
 * local DuckDB (`collector/export_fixture.py`) serves the *same shapes* from real
 * collected data — so the UI is built against genuine empty states, real team names and
 * real sort orders rather than mock data that hides all three.
 *
 * Selection is by environment: DATABASE_URL present means Postgres, absent means fixture.
 */
import { unstable_cache } from "next/cache";
import { promises as fs } from "node:fs";
import path from "node:path";

import { databaseUrl } from "./env";
import type { MarginModel } from "./probability";
import { collapseAlerts, normalizeRow } from "./rows";

import type {
  Alert,
  Game,
  Grade,
  ShopGrade,
  GameResult,
  HistoryPoint,
  RecordRow,
  TrackRecord,
} from "./types";

export { collapseAlerts, normalizeRow };

/** Mirrors calibration.py. Below this many decided games, no rate is published. */
export const MIN_SAMPLES = 50;

export interface AlertCounts {
  alerts: number;
  grades: number;
  /** When the current rule version started producing alerts. */
  firstAlert: string | null;
  lastGraded: string | null;
  /** Grades written in the last seven days: the rate the verdict date is built on. */
  gradedLast7: number;
}

export interface Freshness {
  /** When the collector last completed a run. Null before the first one. */
  lastRun: string | null;
  /** Median hours between recent runs. Null until there are two to compare. */
  medianGapHours: number | null;
  /** Collection CYCLES seen, not individual polls. */
  runsSeen: number;
}

export interface DataSource {
  games(): Promise<Game[]>;
  /**
   * Alerts produced by the rule version currently in force.
   *
   * Retuning thresholds does not delete old alerts — they stay for audit — but showing
   * analysis from superseded rules next to current output would present two different
   * methods as one. `activeRuleVersion` is stamped by the pipeline on every run.
   */
  alerts(): Promise<Alert[]>;
  /** True totals, counted in SQL rather than inferred from the capped alert list. */
  alertCounts(): Promise<AlertCounts>;
  /** How current the data is, measured rather than promised. */
  freshness(): Promise<Freshness>;
  history(eventId: string): Promise<HistoryPoint[]>;
  grades(): Promise<Grade[]>;
  /**
   * Graded cross-book edges — the half of the app that was never scored until v16.
   *
   * Kept as its own method rather than folded into `grades()` because the two answer
   * different questions and pooling them would produce a rate describing neither. That
   * confusion is the reason this exists: the Record page said "Track Record" and showed
   * only the line-movement rule, which reads as a verdict on the whole app.
   */
  shopGrades(): Promise<ShopGrade[]>;
  results(): Promise<GameResult[]>;
  /** Fitted residual model per league; empty until fit_margins has run. */
  marginModels(): Promise<Record<string, MarginModel>>;
  backend: "postgres" | "fixture";
}

// --- fixture backend -----------------------------------------------------------

interface Snapshot {
  generatedAt: string;
  activeRuleVersion: string | null;
  games: Game[];
  history: Record<string, HistoryPoint[]>;
  alerts: Alert[];
  grades: Grade[];
  results: GameResult[];
  marginModels?: Record<string, MarginModel>;
}

let cached: Snapshot | null = null;
let cachedAt = 0;

async function snapshot(): Promise<Snapshot> {
  const file = path.join(process.cwd(), "fixtures", "snapshot.json");

  // Key the cache on mtime. A plain once-only cache means a re-exported fixture is
  // invisible until the server restarts, which during development looks exactly like
  // the export having silently failed.
  let mtime = 0;
  try {
    mtime = (await fs.stat(file)).mtimeMs;
  } catch {
    mtime = 0;
  }
  if (cached && mtime === cachedAt) return cached;

  try {
    cached = JSON.parse(await fs.readFile(file, "utf8")) as Snapshot;
    cachedAt = mtime;
  } catch {
    // An absent fixture is a legitimate state (nothing collected yet), not a crash.
    cached = {
      generatedAt: new Date().toISOString(),
      activeRuleVersion: null,
      games: [],
      history: {},
      alerts: [],
      grades: [],
      results: [],
      marginModels: {},
    };
  }
  return cached;
}

/** Keep only rows produced by the rule version currently in force. */
function activeOnly<T extends { rule_version_id: string }>(
  rows: T[],
  active: string | null,
): T[] {
  if (!active) return rows;
  return rows.filter((row) => row.rule_version_id === active);
}

const fixtureSource: DataSource = {
  backend: "fixture",
  games: async () => (await snapshot()).games,
  alerts: async () => {
    const data = await snapshot();
    return activeOnly(data.alerts, data.activeRuleVersion);
  },
  freshness: async () => ({ lastRun: null, medianGapHours: null, runsSeen: 0 }),
  alertCounts: async () => {
    // The fixture holds everything it has, so the arrays ARE the totals here.
    const data = await snapshot();
    const alerts = activeOnly(data.alerts, data.activeRuleVersion);
    const grades = activeOnly(data.grades ?? [], data.activeRuleVersion);
    return {
      alerts: alerts.length,
      grades: grades.length,
      firstAlert: alerts.map((a) => a.created_at).sort()[0] ?? null,
      lastGraded: null,
      gradedLast7: 0,
    };
  },
  history: async (eventId) => (await snapshot()).history[eventId] ?? [],
  // The fixture predates shop grading and has no such rows. An empty list is the
  // truthful answer -- nothing has been scored -- and the page says so rather than
  // pretending the feature is missing.
  shopGrades: async () => [],
  grades: async () => {
    const data = await snapshot();
    return activeOnly(data.grades, data.activeRuleVersion);
  },
  results: async () => (await snapshot()).results,
  marginModels: async () => (await snapshot()).marginModels ?? {},
};

// --- postgres backend ----------------------------------------------------------

// Queries are kept identical to collector/export_fixture.py so the two cannot drift.
const LATEST_QUOTES = `
WITH ranked AS (
    SELECT event_id, league, commence_time, home_team, away_team,
           home_team_id, away_team_id, market, side, line, price, observed_at,
           row_number() OVER (PARTITION BY event_id, market, side
                              ORDER BY observed_at DESC) AS rn
      FROM odds_snapshots
     WHERE observation_kind = 'pregame_observation'
)
SELECT event_id, league, commence_time, home_team, away_team,
       home_team_id, away_team_id, market, side, line, price, observed_at
  FROM ranked WHERE rn = 1`;

/**
 * The cap is for rendering, not for analysis.
 *
 * Worth being explicit because it has already misled once: every rate on the Track
 * Record is computed from GRADES, which is uncapped, so raising this number does not
 * add a single game to the sample. It only lengthens the list Movers can show. The
 * accuracy figures grow when games are PLAYED, and nothing here can hurry that.
 */
const ALERTS = `
SELECT alert_id, created_at, league, event_id, market, side, kind,
       prev_line, new_line, prev_price, new_price, predicted_side,
       line_at_alert, price_at_alert, magnitude, move_strength, message,
       rule_version_id, home_team, away_team, commence_time
  FROM alerts
 WHERE rule_version_id = (SELECT rule_version_id FROM active_rule WHERE id = 1)
 ORDER BY move_strength DESC, created_at DESC LIMIT 2000`;

/**
 * Scored cross-book edges, current rule only.
 *
 * No LIMIT. The alert list is capped at 2000 because it is ranked for display and the
 * cap once made `totalAlerts` read as exactly 500 forever; this list is a SAMPLE and a
 * cap on it would silently truncate the record itself -- the one thing that must never
 * be quietly shortened, since the whole argument on that page is about how long it is.
 */
const SHOP_GRADES = `
SELECT grade_id, pick_id, graded_at, rule_version_id, league, market, side,
       line, price, fair_probability, expected_roi, result_covered, result_push
  FROM shop_grades
 WHERE rule_version_id = (SELECT rule_version_id FROM active_rule WHERE id = 1)
 ORDER BY graded_at DESC`;

const GRADES = `
SELECT g.grade_id, g.alert_id, g.graded_at, g.rule_version_id, g.market,
       g.predicted_side, g.move_strength, g.line_value_points, g.line_value_won,
       g.result_covered, g.result_push, a.kind, a.league
  FROM alert_grades g JOIN alerts a USING (alert_id)
 WHERE g.rule_version_id = (SELECT rule_version_id FROM active_rule WHERE id = 1)`;

/**
 * How many alerts and grades there actually are.
 *
 * Counted in SQL rather than measured off the arrays, because ALERTS is capped at the
 * strongest 500 while GRADES is uncapped. Subtracting one from the other produced an
 * "awaiting results" figure that was not a backlog at all -- it was the cap minus every
 * grade ever written, and it moved when the cap bound rather than when games were
 * played. Exactly the kind of number this project exists not to publish.
 */
const COUNTS = `
SELECT
  (SELECT COUNT(*) FROM alerts
    WHERE rule_version_id = (SELECT rule_version_id FROM active_rule WHERE id = 1)) AS alerts,
  (SELECT COUNT(*) FROM alert_grades
    WHERE rule_version_id = (SELECT rule_version_id FROM active_rule WHERE id = 1)) AS grades,
  (SELECT MIN(created_at) FROM alerts
    WHERE rule_version_id = (SELECT rule_version_id FROM active_rule WHERE id = 1)) AS first_alert,
  (SELECT MAX(graded_at) FROM alert_grades
    WHERE rule_version_id = (SELECT rule_version_id FROM active_rule WHERE id = 1)) AS last_graded,
  -- How fast the sample is actually growing, measured rather than assumed. A projected
  -- date from a guessed rate is worse than no date.
  (SELECT COUNT(*) FROM alert_grades
    WHERE rule_version_id = (SELECT rule_version_id FROM active_rule WHERE id = 1)
      AND graded_at > NOW() - INTERVAL '7 days') AS graded_last_7`;

/**
 * When the collector last ran, and how often it actually does.
 *
 * Deliberately NOT a countdown. The cron asks for five runs a day midweek and about
 * forty-eight at a weekend; GitHub delivers three to five, at arbitrary minutes, and
 * drops the rest. A timer counting down to the next scheduled minute would be a
 * confident number that is wrong most of the time -- the same class of thing as the
 * "397 awaiting" that turned out to be a cap.
 *
 * So this reports the last run, which is a fact, and the MEDIAN gap over recent runs,
 * which is a measurement. Between them you can tell whether the loop is alive without
 * being promised a minute nobody controls.
 */
const FRESHNESS = `
SELECT started_at FROM poll_runs
 WHERE status <> 'error'
 ORDER BY started_at DESC LIMIT 200`;

const RESULTS = `
SELECT event_id, league, home_team, away_team, home_score, away_score,
       went_overtime, commence_time
  FROM game_results WHERE completed = TRUE`;

const MARGIN_MODELS = `
SELECT league, games, mean, sd, lo, hi, pmf_json, buckets_json
  FROM margin_models`;

const HISTORY = `
SELECT market, side, line, price, observed_at AS "observedAt"
  FROM odds_snapshots
 WHERE event_id = $1 AND observation_kind = 'pregame_observation'
 ORDER BY observed_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
let pool: any = null;

/** Postgres error codes worth handling rather than crashing on. */
const UNDEFINED_TABLE = "42P01";

/**
 * Why the database has no data, when that is the case.
 *
 * Module-level rather than returned, so pages can render normally and read the reason
 * afterwards. Reset on every successful query.
 */
let databaseIssue: "schema_missing" | "unreachable" | null = null;

export function databaseStatus() {
  return databaseIssue;
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({
      connectionString: databaseUrl() ?? undefined,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }

  try {
    const result = await pool.query(sql, params);
    databaseIssue = null;
    return (result.rows as Record<string, unknown>[]).map((row) => normalizeRow<T>(row));
  } catch (error) {
    // A freshly provisioned database has no tables until the collector first runs.
    // That is a normal step in setup, not a fault, and answering it with a 500 hides
    // the one thing the person needs to be told: run the collector.
    if ((error as { code?: string })?.code === UNDEFINED_TABLE) {
      databaseIssue = "schema_missing";
      return [];
    }
    // Anything else — bad credentials, paused compute, network — must not take the
    // whole page down either. The banner says the database is unreachable and the
    // real error still reaches the server logs.
    databaseIssue = "unreachable";
    console.error("database query failed:", error);
    return [];
  }
}

interface QuoteRow {
  event_id: string;
  league: string;
  commence_time: string;
  home_team: string | null;
  away_team: string | null;
  home_team_id: string | null;
  away_team_id: string | null;
  market: string;
  side: string;
  line: number | null;
  price: number | null;
  observed_at: string;
}

/** Fold per-side quote rows into one card per game. Mirrors build_board() in Python. */
export function buildBoard(rows: QuoteRow[]): Game[] {
  const games = new Map<string, Game>();
  for (const row of rows) {
    let game = games.get(row.event_id);
    if (!game) {
      game = {
        eventId: row.event_id,
        league: row.league as Game["league"],
        commenceTime: new Date(row.commence_time).toISOString(),
        homeTeam: row.home_team,
        awayTeam: row.away_team,
        homeTeamId: row.home_team_id,
        awayTeamId: row.away_team_id,
        lastObserved: new Date(row.observed_at).toISOString(),
        spread: {},
        total: {},
        moneyline: {},
      };
      games.set(row.event_id, game);
    }
    const market = game[row.market as "spread" | "total" | "moneyline"];
    market[row.side as keyof typeof market] = { line: row.line, price: row.price };
    const observed = new Date(row.observed_at).toISOString();
    if (observed > game.lastObserved) game.lastObserved = observed;
  }
  return [...games.values()].sort((a, b) =>
    a.commenceTime === b.commenceTime
      ? a.eventId.localeCompare(b.eventId)
      : a.commenceTime.localeCompare(b.commenceTime),
  );
}

/**
 * How long a cached query may be stale, in seconds.
 *
 * The collector writes every 30 minutes at its most frequent, so a minute of staleness
 * is invisible. What it buys is large: without it every page view hit Neon directly
 * (`x-vercel-cache: MISS`, `no-store` on every response), and Neon's free tier suspends
 * compute after a few minutes idle — so the first visit after any gap paid a cold start.
 * Cached reads skip the database entirely.
 *
 * The pages themselves cannot be route-cached: they read `searchParams`, which is a
 * Request-time API and forces dynamic rendering. Caching the queries instead gets the
 * benefit without fighting that.
 */
const CACHE_SECONDS = 60;

/** Wrap a query so repeat views are served without touching the database. */
function cachedQuery<T>(fn: () => Promise<T>, key: string): () => Promise<T> {
  return unstable_cache(fn, ["line-tracker", key], {
    revalidate: CACHE_SECONDS,
    tags: [key],
  });
}

const postgresSource: DataSource = {
  backend: "postgres",
  games: cachedQuery(async () => buildBoard(await query<QuoteRow>(LATEST_QUOTES)), "games"),
  alerts: cachedQuery(() => query<Alert>(ALERTS), "alerts"),
  history: async (eventId) => query<HistoryPoint>(HISTORY, [eventId]),
  grades: cachedQuery(() => query<Grade>(GRADES), "grades"),
  shopGrades: cachedQuery(() => query<ShopGrade>(SHOP_GRADES).catch(() => []), "shopGrades"),
  freshness: cachedQuery(async () => {
    const rows = await query<{ started_at: string }>(FRESHNESS);
    const times = rows
      .map((r) => new Date(r.started_at).getTime())
      .filter((t) => Number.isFinite(t))
      .sort((a, b) => b - a);
    if (times.length === 0) return { lastRun: null, medianGapHours: null, runsSeen: 0 };

    // Collapse each collection CYCLE to one timestamp before measuring anything.
    // poll_runs holds a row per poll, and one workflow run polls NCAAF, NFL and the
    // shop feed within seconds of each other -- so the raw gaps are the minutes between
    // those, not the hours between cycles. Measured straight it read "typically every
    // 3m", which then made every genuine gap look like a stall.
    const SAME_CYCLE_MINUTES = 30;
    const cycles: number[] = [];
    for (const t of times) {
      if (cycles.length === 0 || cycles[cycles.length - 1] - t > SAME_CYCLE_MINUTES * 60000) {
        cycles.push(t);
      }
    }

    const gaps: number[] = [];
    for (let i = 1; i < cycles.length; i += 1) gaps.push((cycles[i - 1] - cycles[i]) / 3600000);
    gaps.sort((a, b) => a - b);
    return {
      lastRun: new Date(cycles[0]).toISOString(),
      // Median, not mean: one overnight gap should not read as the norm.
      medianGapHours: gaps.length ? gaps[Math.floor(gaps.length / 2)] : null,
      runsSeen: cycles.length,
    };
  }, "freshness"),
  alertCounts: cachedQuery(async () => {
    const rows = await query<Record<string, unknown>>(COUNTS);
    const row = rows[0] ?? {};
    const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
    return {
      alerts: num(row.alerts),
      grades: num(row.grades),
      firstAlert: row.first_alert ? String(row.first_alert) : null,
      lastGraded: row.last_graded ? String(row.last_graded) : null,
      gradedLast7: num(row.graded_last_7),
    };
  }, "alertCounts"),
  results: cachedQuery(() => query<GameResult>(RESULTS), "results"),
  // Refit only by the backfill workflow, so it can be cached far longer.
  marginModels: unstable_cache(async () => {
    const rows = await query<{
      league: string; games: number; mean: number; sd: number;
      lo: number; hi: number; pmf_json: string; buckets_json: string | null;
    }>(MARGIN_MODELS);
    const models: Record<string, MarginModel> = {};
    for (const row of rows) {
      try {
        models[row.league] = {
          ...row,
          pmf: JSON.parse(row.pmf_json),
          // Absent on models fitted before dispersion was measured by line size.
          buckets: row.buckets_json ? JSON.parse(row.buckets_json) : undefined,
        };
      } catch {
        // A corrupt pmf must not take the page down; the league simply has no model.
      }
    }
    return models;
  }, ["line-tracker", "margin-models"], { revalidate: 3600, tags: ["margin-models"] }),
};

export function getData(): DataSource {
  return databaseUrl() ? postgresSource : fixtureSource;
}

// --- derived views -------------------------------------------------------------

const STRENGTH_BUCKETS: Array<[number, number]> = [
  [0, 19],
  [20, 39],
  [40, 59],
  [60, 79],
  [80, 99],
];


function summarise(label: string, grades: Grade[]): RecordRow {
  const decidedLine = grades.filter((g) => g.line_value_won !== null);
  const decidedResult = grades.filter((g) => g.result_covered !== null);
  const pushes = grades.filter((g) => g.result_push).length;
  const lineValueWon = decidedLine.filter((g) => g.line_value_won).length;
  const covered = decidedResult.filter((g) => g.result_covered).length;
  const sufficient = decidedResult.length >= MIN_SAMPLES;

  return {
    label,
    fired: grades.length,
    decided: decidedResult.length,
    pushes,
    lineValueWon,
    covered,
    // Refuse to publish a rate on a thin sample. A percentage from nine games looks
    // exactly as authoritative as one from nine hundred, which is the whole problem.
    lineValueRate:
      decidedLine.length >= MIN_SAMPLES ? lineValueWon / decidedLine.length : null,
    coverRate: sufficient ? covered / decidedResult.length : null,
    sufficient,
  };
}

/**
 * Measured win rate per Move Strength bucket, or null where the bucket has not earned
 * one. This is the only thing allowed to unlock Kelly sizing: a null here means the
 * stake stays flat no matter how strong the alert looks.
 */
export function calibratedProbability(
  grades: Grade[],
  moveStrength: number,
): number | null {
  const bucket = STRENGTH_BUCKETS.find(
    ([low, high]) => moveStrength >= low && moveStrength <= high,
  );
  if (!bucket) return null;

  const inBucket = grades.filter(
    (g) =>
      g.move_strength >= bucket[0] &&
      g.move_strength <= bucket[1] &&
      g.result_covered !== null,
  );
  if (inBucket.length < MIN_SAMPLES) return null;

  return inBucket.filter((g) => g.result_covered).length / inBucket.length;
}

export function buildTrackRecord(
  alerts: Alert[],
  grades: Grade[],
  /**
   * True totals. Without these the headline numbers come off a capped list: ALERTS
   * takes the strongest 500, so "alerts" read as exactly 500 forever and "awaiting"
   * was that cap minus every grade ever written -- a figure that moved when the cap
   * bound rather than when a game was played.
   */
  counts?: { alerts: number; grades: number },
): TrackRecord {
  const kinds = ["first_price", "steam", "key_number", "drift"] as const;
  const decided = grades.filter((g) => g.result_covered !== null);

  return {
    minSamples: MIN_SAMPLES,
    totalAlerts: counts?.alerts ?? alerts.length,
    totalGraded: counts?.grades ?? grades.length,
    awaitingResults: Math.max(
      0,
      (counts?.alerts ?? alerts.length) - (counts?.grades ?? grades.length),
    ),
    byKind: kinds.map((kind) =>
      summarise(kind, grades.filter((g) => g.kind === kind)),
    ),
    byStrength: STRENGTH_BUCKETS.map(([low, high]) =>
      summarise(
        `${low}-${high}`,
        grades.filter((g) => g.move_strength >= low && g.move_strength <= high),
      ),
    ),
    baseline:
      decided.length > 0
        ? {
            coinFlip: 0.5,
            alerts:
              decided.length >= MIN_SAMPLES
                ? decided.filter((g) => g.result_covered).length / decided.length
                : null,
          }
        : null,
  };
}
