/**
 * Reading and writing promos, per ledger.
 *
 * Owner first, no default, for the same reason `bets-db` does it: a missing filter on a
 * multi-tenant table does not throw, it quietly returns somebody else's rows. Here that
 * would mean a dashboard counting a stranger's tokens toward your expiring value.
 *
 * Promos are edited, unlike bets. A bet is a fact about something that happened, so the
 * ledger is append-only; a promo is a record of terms you typed, and typos in terms are
 * just typos. Uses, though, are facts -- they are only ever inserted.
 */
import { databaseUrl } from "./env";
import type { Promo, PromoUse } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
let pool: any = null;

async function getPool() {
  const url = databaseUrl();
  if (!url) {
    throw new Error("No database URL is configured, so promos cannot be stored or read.");
  }
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 3 });
  }
  return pool;
}

const COLUMNS = [
  "promo_id", "owner_id", "book", "type", "title", "claimed_at", "expires_at",
  "cap_refund", "max_stake", "boost_pct", "bonus_face", "boosted_price", "base_price",
  "deposit_bonus", "rollover_multiple", "min_odds_american", "min_legs",
  "eligible_markets", "eligible_from", "eligible_to", "excluded", "stackable",
  "status", "created_at",
];

const READ = COLUMNS.filter((c) => c !== "owner_id");

function toPromo(raw: Record<string, unknown>): Promo {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value instanceof Date) out[key] = value.toISOString();
    else if (typeof value === "string" && /_(price|odds_american|legs)$/.test(key)) {
      out[key] = Number(value);
    } else if (
      typeof value === "string" &&
      ["cap_refund", "max_stake", "boost_pct", "bonus_face", "deposit_bonus", "rollover_multiple"].includes(key)
    ) {
      out[key] = Number(value);
    } else out[key] = value;
  }
  // Stored as JSON text rather than a Postgres array: they are free-text tags the user
  // types, and one column that round-trips is simpler than a type the driver maps.
  for (const key of ["eligible_markets", "excluded"]) {
    const value = out[key];
    out[key] = typeof value === "string" && value.length > 0 ? safeParse(value) : [];
  }
  return out as unknown as Promo;
}

function safeParse(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((v) => String(v).slice(0, 60)).slice(0, 20) : [];
  } catch {
    return [];
  }
}

export async function listPromos(ownerId: string): Promise<Promo[]> {
  const db = await getPool();
  const result = await db.query(
    `SELECT ${READ.join(", ")} FROM promos WHERE owner_id = $1 ORDER BY expires_at ASC`,
    [ownerId],
  );
  return (result.rows as Record<string, unknown>[]).map(toPromo);
}

export async function savePromo(ownerId: string, promo: Promo): Promise<void> {
  const db = await getPool();
  const row = promo as unknown as Record<string, unknown>;
  const values = COLUMNS.map((c) => {
    if (c === "owner_id") return ownerId;
    if (c === "eligible_markets" || c === "excluded") return JSON.stringify(row[c] ?? []);
    if (c === "stackable") return row[c] === true;
    return row[c] ?? null;
  });
  const marks = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  const updates = COLUMNS.filter((c) => c !== "promo_id" && c !== "owner_id" && c !== "created_at")
    .map((c) => `${c} = EXCLUDED.${c}`)
    .join(", ");
  // Upsert, so fixing a typed term edits rather than duplicates -- but only ever your
  // own row: the WHERE keeps one ledger's promo id from overwriting another's.
  await db.query(
    `INSERT INTO promos (${COLUMNS.join(", ")}) VALUES (${marks})
       ON CONFLICT (promo_id) DO UPDATE SET ${updates}
       WHERE promos.owner_id = $2`,
    values,
  );
}

export async function setPromoStatus(
  ownerId: string,
  promoId: string,
  status: "available" | "used",
): Promise<boolean> {
  const db = await getPool();
  const result = await db.query(
    "UPDATE promos SET status = $3 WHERE promo_id = $1 AND owner_id = $2",
    [promoId, ownerId, status],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deletePromo(ownerId: string, promoId: string): Promise<boolean> {
  const db = await getPool();
  const result = await db.query("DELETE FROM promos WHERE promo_id = $1 AND owner_id = $2", [
    promoId,
    ownerId,
  ]);
  return (result.rowCount ?? 0) > 0;
}

const USE_COLUMNS = [
  "use_id", "promo_id", "owner_id", "placed_at", "stake", "odds_american", "legs",
  "bet_id", "fair_prob", "ev_at_placement", "settled_at", "result",
  "returned_cash", "returned_bonus",
];

export async function listUses(ownerId: string): Promise<PromoUse[]> {
  const db = await getPool();
  const result = await db.query(
    `SELECT ${USE_COLUMNS.filter((c) => c !== "owner_id").join(", ")}
       FROM promo_uses WHERE owner_id = $1 ORDER BY placed_at DESC LIMIT 500`,
    [ownerId],
  );
  return (result.rows as Record<string, unknown>[]).map((raw) => {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      if (value instanceof Date) out[key] = value.toISOString();
      else if (typeof value === "string" && key !== "use_id" && key !== "promo_id" && key !== "bet_id" && key !== "result") {
        out[key] = Number(value);
      } else out[key] = value;
    }
    return out as unknown as PromoUse;
  });
}

/**
 * Record a promo as used, and what it was used on, together.
 *
 * One transaction because they are one fact: a use whose promo still reads "available"
 * would sit in the dashboard's expiring total for days, which is exactly the leak this
 * feature exists to close.
 */
export async function recordUse(ownerId: string, use: PromoUse): Promise<void> {
  const db = await getPool();
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const row = use as unknown as Record<string, unknown>;
    const values = USE_COLUMNS.map((c) => (c === "owner_id" ? ownerId : (row[c] ?? null)));
    const marks = USE_COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
    await client.query(`INSERT INTO promo_uses (${USE_COLUMNS.join(", ")}) VALUES (${marks})`, values);
    await client.query(
      "UPDATE promos SET status = 'used' WHERE promo_id = $1 AND owner_id = $2",
      [use.promo_id, ownerId],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
