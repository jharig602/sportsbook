/**
 * Reading and writing wagers.
 *
 * Inserts only — a bet row is never updated. The outcome is derived from
 * `game_results` at read time by `settle.ts`, so there is no stored verdict that can
 * drift out of step with the score it came from, and a corrected score corrects the
 * P&L by itself.
 */
import { databaseUrl } from "./env";
import type { Bet } from "./settle";

/* eslint-disable @typescript-eslint/no-explicit-any */
let pool: any = null;

async function getPool() {
  const url = databaseUrl();
  if (!url) {
    throw new Error(
      "No database URL is configured, so bets cannot be recorded. A bet that looks " +
        "saved but is not would be worse than an error here.",
    );
  }
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  }
  return pool;
}

const COLUMNS = [
  "bet_id", "placed_at", "league", "event_id", "home_team", "away_team",
  "commence_time", "market", "side", "line", "price", "stake", "book",
  "model_probability", "market_probability", "rule_version_id", "note", "bonus",
  "supersedes",
];

export async function saveBet(bet: Bet): Promise<void> {
  const db = await getPool();
  const marks = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  await db.query(
    `INSERT INTO bets (${COLUMNS.join(", ")}) VALUES (${marks})`,
    COLUMNS.map((c) => (bet as unknown as Record<string, unknown>)[c] ?? null),
  );
}

export async function listBets(): Promise<Bet[]> {
  const db = await getPool();
  const result = await db.query(
    `SELECT ${COLUMNS.join(", ")} FROM bets ORDER BY placed_at DESC LIMIT 500`,
  );
  return (result.rows as Record<string, unknown>[]).map((row) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(row)) {
      // Match the shapes the rest of the app uses: ISO strings, numbers not strings.
      if (value instanceof Date) out[key] = value.toISOString();
      else if (key === "price" && typeof value === "string") out[key] = Number(value);
      else if (key === "stake" && typeof value === "string") out[key] = Number(value);
      else if (key === "bonus") out[key] = value === true;
      else out[key] = value;
    }
    return out as unknown as Bet;
  });
}
