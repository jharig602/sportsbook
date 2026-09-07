/**
 * Push subscription storage and delivery.
 *
 * Subscriptions live in Postgres (`push_subscriptions`, created by collector/schema.py).
 * Without DATABASE_URL these are no-ops that throw a clear message rather than pretending
 * to have saved something — a silently dropped subscription looks identical to working
 * notifications right up until the moment one matters.
 */
import { databaseUrl } from "./env";
import type { Alert } from "./types";

/* eslint-disable @typescript-eslint/no-explicit-any */
let pool: any = null;

async function getPool() {
  const url = databaseUrl();
  if (!url) {
    throw new Error(
      "No database URL is configured (DATABASE_URL / POSTGRES_URL), so "
      + "notifications cannot be stored yet.",
    );
  }
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({
      connectionString: url,
      ssl: { rejectUnauthorized: false },
      max: 3,
    });
  }
  return pool;
}

export interface StoredSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
  userAgent?: string | null;
}

export async function saveSubscription(subscription: StoredSubscription): Promise<void> {
  const db = await getPool();
  await db.query(
    `INSERT INTO push_subscriptions
       (endpoint, p256dh, auth, created_at, user_agent, failure_count)
     VALUES ($1, $2, $3, now(), $4, 0)
     ON CONFLICT (endpoint) DO UPDATE
       SET p256dh = EXCLUDED.p256dh,
           auth = EXCLUDED.auth,
           user_agent = EXCLUDED.user_agent,
           failure_count = 0`,
    [subscription.endpoint, subscription.p256dh, subscription.auth,
     subscription.userAgent ?? null],
  );
}

export async function deleteSubscription(endpoint: string): Promise<void> {
  const db = await getPool();
  await db.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
}

export async function listSubscriptions(): Promise<StoredSubscription[]> {
  const db = await getPool();
  const result = await db.query(
    "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE failure_count < 5",
  );
  return result.rows as StoredSubscription[];
}

/** Alerts not yet notified, strongest first. */
export async function pendingAlerts(minStrength: number): Promise<Alert[]> {
  const db = await getPool();
  const result = await db.query(
    `SELECT alert_id, created_at, league, event_id, market, side, kind,
            prev_line, new_line, prev_price, new_price, predicted_side,
            line_at_alert, price_at_alert, magnitude, move_strength, message,
            rule_version_id, home_team, away_team, commence_time
       FROM alerts
      WHERE notified_at IS NULL
        AND move_strength >= $1
        AND kind <> 'first_price'
        AND created_at > now() - interval '6 hours'
      ORDER BY move_strength DESC
      LIMIT 20`,
    [minStrength],
  );
  return result.rows as Alert[];
}

export async function markNotified(alertIds: string[]): Promise<void> {
  if (alertIds.length === 0) return;
  const db = await getPool();
  await db.query("UPDATE alerts SET notified_at = now() WHERE alert_id = ANY($1)", [
    alertIds,
  ]);
}

export async function recordFailure(endpoint: string): Promise<void> {
  const db = await getPool();
  await db.query(
    "UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE endpoint = $1",
    [endpoint],
  );
}

/**
 * Notification copy. Says what moved and by how much — never "bet this". The strength
 * number is included as context, not as a verdict.
 */
export function alertNotification(alert: Alert) {
  const matchup = `${alert.away_team ?? "?"} @ ${alert.home_team ?? "?"}`;
  return {
    title: `${matchup} · ${alert.market}`,
    body: `${alert.message} (strength ${alert.move_strength})`,
    // One notification per game at a time, so a busy market cannot bury the phone.
    tag: `alert-${alert.event_id}`,
    url: `/game/${alert.event_id}`,
  };
}
