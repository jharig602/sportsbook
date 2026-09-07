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
import { promises as fs } from "node:fs";
import path from "node:path";

import type {
  Alert,
  Game,
  Grade,
  GameResult,
  HistoryPoint,
  RecordRow,
  TrackRecord,
} from "./types";

/** Mirrors calibration.py. Below this many decided games, no rate is published. */
export const MIN_SAMPLES = 50;

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
  history(eventId: string): Promise<HistoryPoint[]>;
  grades(): Promise<Grade[]>;
  results(): Promise<GameResult[]>;
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
  history: async (eventId) => (await snapshot()).history[eventId] ?? [],
  grades: async () => {
    const data = await snapshot();
    return activeOnly(data.grades, data.activeRuleVersion);
  },
  results: async () => (await snapshot()).results,
};

// --- postgres backend ----------------------------------------------------------

// Queries are kept identical to collector/export_fixture.py so the two cannot drift.
const LATEST_QUOTES = `
WITH ranked AS (
    SELECT event_id, league, commence_time, home_team, away_team, market, side,
           line, price, observed_at,
           row_number() OVER (PARTITION BY event_id, market, side
                              ORDER BY observed_at DESC) AS rn
      FROM odds_snapshots
     WHERE observation_kind = 'pregame_observation'
)
SELECT event_id, league, commence_time, home_team, away_team, market, side,
       line, price, observed_at
  FROM ranked WHERE rn = 1`;

const ALERTS = `
SELECT alert_id, created_at, league, event_id, market, side, kind,
       prev_line, new_line, prev_price, new_price, predicted_side,
       line_at_alert, price_at_alert, magnitude, move_strength, message,
       rule_version_id, home_team, away_team, commence_time
  FROM alerts
 WHERE rule_version_id = (SELECT rule_version_id FROM active_rule WHERE id = 1)
 ORDER BY move_strength DESC, created_at DESC LIMIT 500`;

const GRADES = `
SELECT g.grade_id, g.alert_id, g.graded_at, g.rule_version_id, g.market,
       g.predicted_side, g.move_strength, g.line_value_points, g.line_value_won,
       g.result_covered, g.result_push, a.kind, a.league
  FROM alert_grades g JOIN alerts a USING (alert_id)
 WHERE g.rule_version_id = (SELECT rule_version_id FROM active_rule WHERE id = 1)`;

const RESULTS = `
SELECT event_id, league, home_team, away_team, home_score, away_score,
       went_overtime, commence_time
  FROM game_results WHERE completed = TRUE`;

const HISTORY = `
SELECT market, side, line, price, observed_at AS "observedAt"
  FROM odds_snapshots
 WHERE event_id = $1 AND observation_kind = 'pregame_observation'
 ORDER BY observed_at`;

/* eslint-disable @typescript-eslint/no-explicit-any */
let pool: any = null;

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  const result = await pool.query(sql, params);
  return result.rows as T[];
}

interface QuoteRow {
  event_id: string;
  league: string;
  commence_time: string;
  home_team: string | null;
  away_team: string | null;
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

const postgresSource: DataSource = {
  backend: "postgres",
  games: async () => buildBoard(await query<QuoteRow>(LATEST_QUOTES)),
  alerts: async () => query<Alert>(ALERTS),
  history: async (eventId) => query<HistoryPoint>(HISTORY, [eventId]),
  grades: async () => query<Grade>(GRADES),
  results: async () => query<GameResult>(RESULTS),
};

export function getData(): DataSource {
  return process.env.DATABASE_URL ? postgresSource : fixtureSource;
}

// --- derived views -------------------------------------------------------------

const STRENGTH_BUCKETS: Array<[number, number]> = [
  [0, 19],
  [20, 39],
  [40, 59],
  [60, 79],
  [80, 99],
];


/**
 * Collapse alerts that describe the same market move. A two-sided market prices both
 * sides, so one shift often appears twice — the over growing pricier and the under
 * growing cheaper are the same money moving. Mirrors collapse_for_display() in Python.
 */
export function collapseAlerts(alerts: Alert[]): Alert[] {
  const best = new Map<string, Alert>();
  for (const alert of alerts) {
    const key = [
      alert.event_id,
      alert.market,
      alert.kind,
      alert.predicted_side,
      alert.created_at,
    ].join("|");
    const current = best.get(key);
    if (!current || alert.move_strength > current.move_strength) best.set(key, alert);
  }
  return [...best.values()].sort(
    (a, b) =>
      b.move_strength - a.move_strength || b.created_at.localeCompare(a.created_at),
  );
}

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

export function buildTrackRecord(alerts: Alert[], grades: Grade[]): TrackRecord {
  const kinds = ["first_price", "steam", "key_number", "drift"] as const;
  const decided = grades.filter((g) => g.result_covered !== null);

  return {
    minSamples: MIN_SAMPLES,
    totalAlerts: alerts.length,
    totalGraded: grades.length,
    awaitingResults: alerts.length - grades.length,
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
