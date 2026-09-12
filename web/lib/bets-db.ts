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
  "supersedes", "voided", "parlay_id", "parlay_price",
];

/**
 * Column values for one row, with the NOT NULL flags defaulted.
 *
 * `bonus` and `voided` are NOT NULL in the schema, and a caller that simply does not
 * mention them would otherwise send null and fail the insert. Coerced here rather than
 * in each caller because "did you remember the boolean" is not a thing any write path
 * should have to know.
 */
function values(bet: Bet): unknown[] {
  const row = bet as unknown as Record<string, unknown>;
  return COLUMNS.map((c) =>
    c === "bonus" || c === "voided" ? row[c] === true : (row[c] ?? null),
  );
}

export async function saveBet(bet: Bet): Promise<void> {
  const db = await getPool();
  const marks = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  await db.query(
    `INSERT INTO bets (${COLUMNS.join(", ")}) VALUES (${marks})`,
    values(bet),
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
      else if (key === "parlay_price" && typeof value === "string") out[key] = Number(value);
      else if (key === "stake" && typeof value === "string") out[key] = Number(value);
      else if (key === "bonus" || key === "voided") out[key] = value === true;
      else out[key] = value;
    }
    return out as unknown as Bet;
  });
}

/**
 * Write every leg of a parlay, or none of them.
 *
 * A half-written parlay is worse than no parlay: the legs that landed would be graded
 * as singles, each carrying the full stake, and the ticket would report a result it
 * never had. One transaction, so the ledger never holds a partial ticket.
 */
export async function saveParlay(legs: Bet[]): Promise<void> {
  if (legs.length === 0) return;
  const db = await getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const marks = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
    for (const leg of legs) {
      await client.query(
        `INSERT INTO bets (${COLUMNS.join(", ")}) VALUES (${marks})`,
        values(leg),
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
