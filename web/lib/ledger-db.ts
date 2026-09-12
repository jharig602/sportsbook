/**
 * Moving one anonymous ledger to a second device.
 *
 * The identifier that makes a ledger personal is a random value in a cookie, which is
 * what lets someone keep a season's record without ever giving this app a name, an
 * email or a password. Left there it would also strand that record in one browser — and
 * a betting ledger is not a snapshot, it is a SAMPLE. The Record page's whole argument
 * is whether enough games have settled to separate a real edge from noise, and the
 * honest answer today is "not yet, come back in a few hundred". A record that cannot
 * reach the phone the bets are actually placed on, and that a cache clear deletes, never
 * gets to make that argument.
 *
 * So: a short code, read off one screen and typed into another.
 *
 * While it lives, the code IS the ledger — anyone holding it becomes that owner. Every
 * decision here follows from admitting that rather than dressing it up: eight characters
 * from a 29-letter alphabet, fifteen minutes, one use, deleted on claim rather than kept
 * for an audit trail nobody will read. And the owner's own ledger cannot be transferred
 * at all, because it is not reachable by identifier in the first place.
 */
import { databaseUrl } from "./env";
import { HOUSE, newTransferCode, TRANSFER_TTL_MS, transferExpired } from "./owner";

/* eslint-disable @typescript-eslint/no-explicit-any */
let pool: any = null;

async function getPool() {
  const url = databaseUrl();
  if (!url) throw new Error("No database URL is configured, so ledgers cannot be moved.");
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  }
  return pool;
}

export interface Transfer {
  code: string;
  expiresAt: string;
}

/**
 * Issue a code for a ledger.
 *
 * Refuses the house outright. The owner's ledger is reached by knowing APP_PASSCODE and
 * by nothing else; minting a code for it would create exactly the identifier-shaped path
 * to it that `validOwnerId` exists to deny, and the passcode already works on a phone.
 */
export async function issueTransfer(ownerId: string): Promise<Transfer> {
  if (ownerId === HOUSE) {
    throw new Error(
      "The owner's ledger is not moved with a code — sign in with the passcode on the " +
        "other device instead. A code would be a second way into it, and a weaker one.",
    );
  }
  const db = await getPool();
  const code = newTransferCode();
  const now = new Date();
  // Old codes for this ledger go first: two live codes for one ledger doubles the
  // window without doubling anything useful.
  await db.query("DELETE FROM ledger_transfers WHERE owner_id = $1", [ownerId]);
  await db.query(
    "INSERT INTO ledger_transfers (code, owner_id, created_at) VALUES ($1, $2, $3)",
    [code, ownerId, now.toISOString()],
  );
  return { code, expiresAt: new Date(now.getTime() + TRANSFER_TTL_MS).toISOString() };
}

/**
 * Redeem a code, returning the ledger it names — or null when it names nothing.
 *
 * Deleted on the way out, inside the same statement that reads it, so two devices racing
 * the same code cannot both win it. `DELETE ... RETURNING` is doing real work here: a
 * SELECT then a DELETE would leave a gap in which the second request also sees a valid
 * row, and both would land on a ledger only one of them was given.
 *
 * Expiry is checked after the delete, on purpose. An expired code is spent either way —
 * having been typed at all, it has been off-screen long enough that letting it survive
 * the attempt gains nothing and leaves it live.
 */
export async function claimTransfer(code: string): Promise<string | null> {
  const db = await getPool();
  const result = await db.query(
    "DELETE FROM ledger_transfers WHERE code = $1 RETURNING owner_id, created_at",
    [code],
  );
  const row = result.rows[0] as { owner_id: string; created_at: string | Date } | undefined;
  if (!row) return null;
  if (transferExpired(row.created_at)) return null;
  return row.owner_id;
}

/** How many bets a ledger holds. Shown before a claim replaces the current one. */
export async function ledgerSize(ownerId: string): Promise<number> {
  const db = await getPool();
  const result = await db.query(
    "SELECT COUNT(*)::int AS n FROM bets WHERE owner_id = $1 AND voided = FALSE",
    [ownerId],
  );
  return Number(result.rows[0]?.n ?? 0);
}
