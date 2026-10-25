/**
 * Storage for the connector's sign-in (schema v27). Every secret is stored as its SHA-256
 * (oauth.ts `hashSecret`); the plain value exists only in the response that hands it out.
 *
 * Single-use and expiry are enforced in the UPDATE itself, not read-then-write, so two
 * requests racing with the same code cannot both win.
 */
import { databaseUrl } from "./env";
import {
  ACCESS_TTL_SECONDS,
  CODE_TTL_SECONDS,
  hashSecret,
  isMetadataClientId,
  newSecret,
  REFRESH_TTL_SECONDS,
  redirectAllowed,
} from "./oauth";

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

export interface OAuthClient {
  client_id: string;
  client_name: string | null;
  redirect_uris: string[];
}

function parseUris(raw: unknown): string[] {
  try {
    const value = JSON.parse(String(raw));
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** Registrations in the last hour, so an open endpoint cannot be used to fill a table. */
export async function recentRegistrations(): Promise<number> {
  const db = await getPool();
  const result = await db.query(
    "SELECT COUNT(*)::int AS n FROM oauth_clients WHERE created_at > NOW() - INTERVAL '1 hour'",
  );
  return result.rows[0]?.n ?? 0;
}

export async function registerClient(name: string | null, redirectUris: string[]): Promise<OAuthClient> {
  const db = await getPool();
  const clientId = newSecret("dcl");
  await db.query(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES ($1, $2, $3, NOW())",
    [clientId, name ? name.slice(0, 100) : null, JSON.stringify(redirectUris)],
  );
  return { client_id: clientId, client_name: name, redirect_uris: redirectUris };
}

/**
 * A client by id: one registered here, or a client ID metadata document (CIMD) on one of
 * Claude's hosts, fetched and remembered. A document that does not name itself, or lists
 * a redirect this app will not use, is refused.
 */
export async function findClient(clientId: string, allowLoopback: boolean): Promise<OAuthClient | null> {
  const db = await getPool();
  const stored = await db.query(
    "SELECT client_id, client_name, redirect_uris FROM oauth_clients WHERE client_id = $1",
    [clientId],
  );
  if (stored.rows[0] && !isMetadataClientId(clientId)) {
    const row = stored.rows[0];
    return { client_id: row.client_id, client_name: row.client_name, redirect_uris: parseUris(row.redirect_uris) };
  }
  if (!isMetadataClientId(clientId)) return null;

  try {
    const response = await fetch(clientId, {
      headers: { Accept: "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) return null;
    const doc = (await response.json()) as { client_id?: unknown; client_name?: unknown; redirect_uris?: unknown };
    if (doc.client_id !== clientId || !Array.isArray(doc.redirect_uris)) return null;
    const uris = doc.redirect_uris.filter(
      (u): u is string => typeof u === "string" && redirectAllowed(u, allowLoopback),
    );
    if (uris.length === 0) return null;
    const name = typeof doc.client_name === "string" ? doc.client_name.slice(0, 100) : null;
    await db.query(
      `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES ($1, $2, $3, NOW())
       ON CONFLICT (client_id) DO UPDATE SET client_name = EXCLUDED.client_name, redirect_uris = EXCLUDED.redirect_uris`,
      [clientId, name, JSON.stringify(uris)],
    );
    return { client_id: clientId, client_name: name, redirect_uris: uris };
  } catch {
    return null;
  }
}

/** A one-time code for this client, redirect and PKCE challenge. Returns the plain code. */
export async function createCode(clientId: string, redirectUri: string, challenge: string): Promise<string> {
  const db = await getPool();
  const code = newSecret("dsc");
  await db.query("DELETE FROM oauth_codes WHERE expires_at < NOW() - INTERVAL '1 day'");
  await db.query(
    `INSERT INTO oauth_codes (code_hash, client_id, redirect_uri, code_challenge, expires_at, used)
     VALUES ($1, $2, $3, $4, NOW() + make_interval(secs => $5), FALSE)`,
    [await hashSecret(code), clientId, redirectUri, challenge, CODE_TTL_SECONDS],
  );
  return code;
}

/** Spend a code: succeeds once, inside its ten minutes, and never again. */
export async function consumeCode(
  code: string,
): Promise<{ client_id: string; redirect_uri: string; code_challenge: string } | null> {
  const db = await getPool();
  const result = await db.query(
    `UPDATE oauth_codes SET used = TRUE
      WHERE code_hash = $1 AND NOT used AND expires_at > NOW()
      RETURNING client_id, redirect_uri, code_challenge`,
    [await hashSecret(code)],
  );
  return result.rows[0] ?? null;
}

export interface IssuedTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
}

export async function issueTokens(clientId: string): Promise<IssuedTokens> {
  const db = await getPool();
  const access = newSecret("dsa");
  const refresh = newSecret("dsr");
  await db.query(
    `INSERT INTO oauth_tokens (token_hash, kind, client_id, created_at, expires_at, revoked) VALUES
       ($1, 'access', $3, NOW(), NOW() + make_interval(secs => $4), FALSE),
       ($2, 'refresh', $3, NOW(), NOW() + make_interval(secs => $5), FALSE)`,
    [await hashSecret(access), await hashSecret(refresh), clientId, ACCESS_TTL_SECONDS, REFRESH_TTL_SECONDS],
  );
  return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_SECONDS };
}

/**
 * Trade a refresh token for a new pair. The old one is spent in the same statement.
 *
 * A refresh token presented AFTER it was spent means two parties hold it -- the client
 * and someone who copied it -- so every token the client holds is revoked and it has to
 * be approved again. That is the standard reuse rule and costs a legitimate client one
 * re-approval at worst.
 */
export async function rotateRefresh(refresh: string, clientId: string): Promise<IssuedTokens | "reused" | null> {
  const db = await getPool();
  const hash = await hashSecret(refresh);
  const spent = await db.query(
    `UPDATE oauth_tokens SET revoked = TRUE
      WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2 AND NOT revoked AND expires_at > NOW()
      RETURNING token_hash`,
    [hash, clientId],
  );
  if (spent.rows.length === 1) return issueTokens(clientId);
  const known = await db.query(
    "SELECT revoked FROM oauth_tokens WHERE token_hash = $1 AND kind = 'refresh' AND client_id = $2",
    [hash, clientId],
  );
  if (known.rows[0]?.revoked) {
    await db.query("UPDATE oauth_tokens SET revoked = TRUE WHERE client_id = $1 AND NOT revoked", [clientId]);
    return "reused";
  }
  return null;
}

/** The client behind a live access token, or null. */
export async function verifyAccess(
  token: string,
): Promise<{ clientId: string; tokenHash: string; expiresAt: number } | null> {
  if (!token.startsWith("dsa_")) return null;
  const db = await getPool();
  const hash = await hashSecret(token);
  const result = await db.query(
    `SELECT client_id, expires_at FROM oauth_tokens
      WHERE token_hash = $1 AND kind = 'access' AND NOT revoked AND expires_at > NOW()`,
    [hash],
  );
  const row = result.rows[0];
  if (!row) return null;
  return { clientId: row.client_id, tokenHash: hash, expiresAt: Math.floor(new Date(row.expires_at).getTime() / 1000) };
}

/** RFC 7009: revoke one token. Unknown tokens are not an error. */
export async function revokeToken(token: string): Promise<void> {
  const db = await getPool();
  await db.query("UPDATE oauth_tokens SET revoked = TRUE WHERE token_hash = $1", [await hashSecret(token)]);
}

/** The Settings button: every token, every client. Claude has to be approved again. */
export async function revokeAll(): Promise<number> {
  const db = await getPool();
  const result = await db.query("UPDATE oauth_tokens SET revoked = TRUE WHERE NOT revoked");
  return result.rowCount ?? 0;
}

export interface ConnectorStatus {
  /** Refresh tokens still usable: how many connections exist. */
  connections: number;
  lastCall: string | null;
  callsToday: number;
}

export async function connectorStatus(): Promise<ConnectorStatus> {
  if (!databaseUrl()) return { connections: 0, lastCall: null, callsToday: 0 };
  try {
    const db = await getPool();
    const [tokens, calls] = await Promise.all([
      db.query(
        "SELECT COUNT(*)::int AS n FROM oauth_tokens WHERE kind = 'refresh' AND NOT revoked AND expires_at > NOW()",
      ),
      db.query(
        `SELECT MAX(called_at) AS last,
                COUNT(*) FILTER (WHERE called_at > NOW() - INTERVAL '1 day')::int AS today
           FROM mcp_calls`,
      ),
    ]);
    const last = calls.rows[0]?.last;
    return {
      connections: tokens.rows[0]?.n ?? 0,
      lastCall: last ? new Date(last).toISOString() : null,
      callsToday: calls.rows[0]?.today ?? 0,
    };
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return { connections: 0, lastCall: null, callsToday: 0 };
    throw error;
  }
}

/** Every tool call, for audit. Inputs are the tool's own arguments -- never a secret. */
export async function logCall(tokenHash: string, tool: string, inputs: unknown): Promise<void> {
  const db = await getPool();
  await db.query(
    "INSERT INTO mcp_calls (call_id, called_at, token_hash, tool, inputs) VALUES ($1, NOW(), $2, $3, $4)",
    [crypto.randomUUID(), tokenHash, tool, JSON.stringify(inputs ?? {}).slice(0, 2000)],
  );
  // Ninety days is plenty of audit for one person; trimmed now and then, not every call.
  if (Math.random() < 0.02) {
    await db.query("DELETE FROM mcp_calls WHERE called_at < NOW() - INTERVAL '90 days'");
  }
}

/** Calls this token has made in the last `seconds`, for the rate limit. */
export async function callsSince(tokenHash: string, seconds: number): Promise<number> {
  const db = await getPool();
  const result = await db.query(
    "SELECT COUNT(*)::int AS n FROM mcp_calls WHERE token_hash = $1 AND called_at > NOW() - make_interval(secs => $2)",
    [tokenHash, seconds],
  );
  return result.rows[0]?.n ?? 0;
}
