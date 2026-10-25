/**
 * The Claude connector's sign-in: a minimal OAuth 2.1 authorization server for one user.
 *
 * Why build it rather than add Clerk or WorkOS: the app already has exactly one person who
 * may approve anything -- whoever holds the owner passcode -- and a second identity
 * provider would be a second front door to keep locked. So the consent page sits behind
 * the existing passcode gate, and the only thing this module adds is the protocol around
 * it: clients register, the owner approves once, Claude gets short-lived tokens.
 *
 * What it refuses, and why each matters:
 *
 * * Redirects anywhere but Claude's own callback (plus loopback, off production, for the
 *   MCP Inspector). A code sent to a stranger's URL is a token for a stranger.
 * * Anything but PKCE with S256. A code that leaks in transit is useless without the
 *   verifier, which never leaves the client.
 * * Secrets at rest. Codes and tokens are stored as SHA-256 digests, so a copy of the
 *   database hands out nothing.
 *
 * Pure functions only (Web Crypto, no driver), so the rules can be tested without a
 * database. Storage is in oauth-db.ts.
 */

export const SCOPE = "dissent:read";
export const CODE_TTL_SECONDS = 10 * 60;
export const ACCESS_TTL_SECONDS = 60 * 60;
export const REFRESH_TTL_SECONDS = 30 * 24 * 60 * 60;

/** Claude's OAuth callbacks (claude.ai, and claude.com which it is moving to). */
export const CLAUDE_CALLBACKS = [
  "https://claude.ai/api/mcp/auth_callback",
  "https://claude.com/api/mcp/auth_callback",
];

/** Hosts whose client metadata documents we will fetch (CIMD). Nothing else is fetched. */
export const CIMD_HOSTS = ["claude.ai", "claude.com"];

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1");
}

/**
 * Whether a redirect URI may receive a code. Exact match against Claude's callbacks;
 * loopback only when `allowLoopback` (local development, for the MCP Inspector).
 */
export function redirectAllowed(uri: string, allowLoopback: boolean): boolean {
  if (CLAUDE_CALLBACKS.includes(uri)) return true;
  if (!allowLoopback) return false;
  try {
    const url = new URL(uri);
    return isLoopback(url) && !url.hash;
  } catch {
    return false;
  }
}

/** Loopback redirects are for local testing only, never the deployed site. */
export function loopbackAllowed(env: Record<string, string | undefined> = process.env): boolean {
  return env.VERCEL_ENV !== "production" && env.NODE_ENV !== "production";
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** How a code or token is stored: its SHA-256, hex. */
export async function hashSecret(secret: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)));
}

/** 32 random bytes, base64url, with a short prefix saying what it is. */
export function newSecret(prefix: "dsc" | "dsa" | "dsr" | "dcl"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return `${prefix}_${base64url(bytes)}`;
}

/** PKCE S256: base64url(SHA-256(verifier)) must equal the challenge sent at /authorize. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  // RFC 7636: 43-128 characters from the unreserved set.
  if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const expected = base64url(digest);
  if (expected.length !== challenge.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ challenge.charCodeAt(i);
  return diff === 0;
}

/** A client id that is itself the URL of its metadata document (CIMD), on a host we trust. */
export function isMetadataClientId(clientId: string): boolean {
  try {
    const url = new URL(clientId);
    return url.protocol === "https:" && CIMD_HOSTS.includes(url.hostname) && url.pathname !== "/";
  } catch {
    return false;
  }
}

export interface AuthorizeRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string;
  resource: string | null;
}

/**
 * Check the shape of an authorization request. Whether the client exists and owns the
 * redirect URI is checked against storage separately; this is everything that can be
 * refused from the query alone.
 */
export function parseAuthorize(
  params: URLSearchParams | Record<string, string | undefined>,
  mcpResource: string,
  allowLoopback: boolean,
): { ok: true; request: AuthorizeRequest } | { ok: false; error: string } {
  const get = (key: string) =>
    params instanceof URLSearchParams ? params.get(key) : (params[key] ?? null);
  const clientId = get("client_id");
  const redirectUri = get("redirect_uri");
  if (!clientId) return { ok: false, error: "Missing client_id." };
  if (!redirectUri || !redirectAllowed(redirectUri, allowLoopback)) {
    return { ok: false, error: "That redirect address is not one this app sends codes to." };
  }
  if (get("response_type") !== "code") return { ok: false, error: "Only response_type=code is supported." };
  const challenge = get("code_challenge");
  if (!challenge || !/^[A-Za-z0-9\-_]{43}$/.test(challenge)) {
    return { ok: false, error: "A PKCE code_challenge is required." };
  }
  if (get("code_challenge_method") !== "S256") return { ok: false, error: "Only PKCE S256 is supported." };
  const resource = get("resource");
  if (resource && resource.replace(/\/$/, "") !== mcpResource) {
    return { ok: false, error: "That resource is not this server." };
  }
  const scope = get("scope");
  if (scope && !scope.split(" ").every((s) => s === SCOPE || s === "")) {
    return { ok: false, error: `Only the ${SCOPE} scope exists.` };
  }
  return {
    ok: true,
    request: {
      clientId,
      redirectUri,
      codeChallenge: challenge,
      state: get("state"),
      scope: SCOPE,
      resource,
    },
  };
}

/** Where the browser goes after the owner decides: the client's callback, with the result. */
export function callbackUrl(
  redirectUri: string,
  result: { code: string } | { error: string },
  state: string | null,
  issuer: string,
): string {
  const url = new URL(redirectUri);
  if ("code" in result) url.searchParams.set("code", result.code);
  else url.searchParams.set("error", result.error);
  if (state) url.searchParams.set("state", state);
  // RFC 9207: says which server issued the response, so a client talking to several
  // cannot be tricked into sending this code to the wrong one.
  url.searchParams.set("iss", issuer);
  return url.toString();
}

/** RFC 8414 authorization server metadata. */
export function authServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
  };
}

/** CORS for the endpoints a browser-based client (the MCP Inspector) calls. No cookies. */
export const OPEN_CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, mcp-protocol-version",
  "Access-Control-Max-Age": "86400",
};

/** An OAuth error response body (RFC 6749 5.2). */
export function oauthError(error: string, description: string, status = 400): Response {
  return Response.json(
    { error, error_description: description },
    { status, headers: { ...OPEN_CORS, "Cache-Control": "no-store" } },
  );
}

/** Read a token or registration request body: form-encoded per the spec, JSON tolerated. */
export async function readBody(request: Request): Promise<Record<string, string>> {
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = (await request.json()) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(body).map(([k, v]) => [k, typeof v === "string" ? v : JSON.stringify(v)]),
      );
    }
    const form = new URLSearchParams(await request.text());
    return Object.fromEntries(form.entries());
  } catch {
    return {};
  }
}

/** The public origin, from Vercel's forwarding headers when present. */
export function publicOrigin(request: Request): string {
  const forwardedHost = request.headers.get("x-forwarded-host");
  const proto = request.headers.get("x-forwarded-proto") ?? "https";
  if (forwardedHost) return `${proto.split(",")[0].trim()}://${forwardedHost.split(",")[0].trim()}`;
  return new URL(request.url).origin;
}
