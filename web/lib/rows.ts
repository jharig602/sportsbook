/**
 * Pure row transforms, shared by both data backends.
 *
 * Deliberately free of runtime imports (types only) so it can be unit-tested directly,
 * without dragging in `pg` or the filesystem. The bugs these guard against are shape
 * bugs, and shape bugs are exactly what a fixture cannot reproduce.
 */
import type { Alert } from "./types";

/**
 * BIGINT columns. node-postgres returns int8 as a *string* to avoid precision loss,
 * so these need converting back or arithmetic on them silently concatenates.
 *
 * Only these. `event_id` and friends are VARCHARs of digits — coercing those to
 * numbers would break every join and lookup that depends on them.
 */
const BIGINT_COLUMNS = new Set([
  "price",
  "prev_price",
  "new_price",
  "price_at_alert",
  "closing_price",
]);

/**
 * Make a Postgres row look exactly like the JSON fixture's version of the same row.
 *
 * The two backends must be genuinely interchangeable, and they were not: `pg` hands
 * back `Date` objects and BIGINT strings, while the fixture — having been through
 * JSON — hands back ISO strings and numbers. That difference took down /movers in
 * production while every local page worked. Normalising here fixes the whole class
 * rather than the one call site that happened to notice.
 */
export function normalizeRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (value instanceof Date) {
      out[key] = value.toISOString();
    } else if (typeof value === "string" && BIGINT_COLUMNS.has(key)) {
      const parsed = Number(value);
      out[key] = Number.isFinite(parsed) ? parsed : null;
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/**
 * Collapse alerts that say the same thing about the same market move.
 *
 * A two-sided market prices both sides, so one shift often shows up twice: the over
 * growing more expensive and the under growing cheaper are the same money moving. Both
 * observations are real and both are stored — but on a phone they are one card, and
 * showing two makes a single move look like corroboration from two sources.
 *
 * Grouped by (event, market, kind, predicted side, time); the strongest survives.
 * Mirrors collapse_for_display() in collector/signals.py.
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
      b.move_strength - a.move_strength ||
      // String comparison, not localeCompare: created_at is normalised to an ISO
      // string, but a raw Date would have no localeCompare at all and throw.
      String(b.created_at).localeCompare(String(a.created_at)),
  );
}
