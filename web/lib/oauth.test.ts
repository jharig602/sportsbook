import { test } from "node:test";
import assert from "node:assert/strict";

import {
  authServerMetadata,
  callbackUrl,
  hashSecret,
  isMetadataClientId,
  loopbackAllowed,
  newSecret,
  parseAuthorize,
  pkceMatches,
  redirectAllowed,
} from "./oauth.ts";

const MCP = "https://dissent.example/api/mcp";

async function challengeFor(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  let binary = "";
  for (const b of digest) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

test("only Claude's callbacks receive codes; loopback only off production", () => {
  assert.equal(redirectAllowed("https://claude.ai/api/mcp/auth_callback", false), true);
  assert.equal(redirectAllowed("https://claude.com/api/mcp/auth_callback", false), true);
  assert.equal(redirectAllowed("https://claude.ai/api/mcp/auth_callback/evil", false), false);
  assert.equal(redirectAllowed("https://evil.example/api/mcp/auth_callback", false), false);
  assert.equal(redirectAllowed("http://localhost:6274/oauth/callback", false), false);
  assert.equal(redirectAllowed("http://localhost:6274/oauth/callback", true), true);
  assert.equal(redirectAllowed("http://localhost.evil.example/cb", true), false);
  assert.equal(redirectAllowed("https://localhost/cb", true), false);
  assert.equal(loopbackAllowed({ VERCEL_ENV: "production" }), false);
  assert.equal(loopbackAllowed({ NODE_ENV: "production" }), false);
  assert.equal(loopbackAllowed({ NODE_ENV: "development" }), true);
});

test("PKCE S256: the right verifier matches, anything else does not", async () => {
  const verifier = "a".repeat(20) + "-._~" + "Z9".repeat(10);
  const challenge = await challengeFor(verifier);
  assert.equal(await pkceMatches(verifier, challenge), true);
  assert.equal(await pkceMatches(verifier + "x", challenge), false);
  assert.equal(await pkceMatches("short", await challengeFor("short")), false);
  // A plain challenge (the verifier itself) is not accepted as S256.
  assert.equal(await pkceMatches(verifier, verifier), false);
});

test("secrets are random, prefixed, and stored as a digest", async () => {
  const a = newSecret("dsa");
  const b = newSecret("dsa");
  assert.match(a, /^dsa_[A-Za-z0-9_-]{43}$/);
  assert.notEqual(a, b);
  const hash = await hashSecret(a);
  assert.match(hash, /^[0-9a-f]{64}$/);
  assert.ok(!hash.includes(a.slice(4)));
});

test("an authorization request is refused unless it is code + PKCE S256 to an allowed callback", async () => {
  const good = {
    client_id: "dcl_x",
    redirect_uri: "https://claude.ai/api/mcp/auth_callback",
    response_type: "code",
    code_challenge: await challengeFor("v".repeat(43)),
    code_challenge_method: "S256",
    state: "s1",
    resource: MCP,
  };
  const ok = parseAuthorize(good, MCP, false);
  assert.equal(ok.ok, true);
  if (ok.ok) {
    assert.equal(ok.request.state, "s1");
    assert.equal(ok.request.scope, "dissent:read");
  }
  for (const [key, value] of [
    ["redirect_uri", "https://evil.example/cb"],
    ["response_type", "token"],
    ["code_challenge_method", "plain"],
    ["code_challenge", undefined],
    ["resource", "https://other.example/api/mcp"],
    ["scope", "dissent:write"],
    ["client_id", undefined],
  ] as const) {
    const bad = parseAuthorize({ ...good, [key]: value }, MCP, false);
    assert.equal(bad.ok, false, `${key}=${value} must be refused`);
  }
  // A trailing slash on the resource is the same server.
  assert.equal(parseAuthorize({ ...good, resource: `${MCP}/` }, MCP, false).ok, true);
});

test("the callback carries the code, the state and the issuer", () => {
  const url = new URL(callbackUrl("https://claude.ai/api/mcp/auth_callback", { code: "dsc_1" }, "st", "https://d.example"));
  assert.equal(url.searchParams.get("code"), "dsc_1");
  assert.equal(url.searchParams.get("state"), "st");
  assert.equal(url.searchParams.get("iss"), "https://d.example");
  const denied = new URL(callbackUrl("https://claude.ai/api/mcp/auth_callback", { error: "access_denied" }, null, "https://d.example"));
  assert.equal(denied.searchParams.get("error"), "access_denied");
  assert.equal(denied.searchParams.get("code"), null);
});

test("client metadata documents are only fetched from Claude's hosts", () => {
  assert.equal(isMetadataClientId("https://claude.ai/oauth/mcp-oauth-client-metadata"), true);
  assert.equal(isMetadataClientId("https://claude.ai/"), false);
  assert.equal(isMetadataClientId("https://evil.example/meta.json"), false);
  assert.equal(isMetadataClientId("http://claude.ai/meta"), false);
  assert.equal(isMetadataClientId("dcl_abc"), false);
});

test("the server metadata advertises PKCE S256, public clients, DCR and CIMD", () => {
  const m = authServerMetadata("https://d.example");
  assert.equal(m.issuer, "https://d.example");
  assert.deepEqual(m.code_challenge_methods_supported, ["S256"]);
  assert.deepEqual(m.token_endpoint_auth_methods_supported, ["none"]);
  assert.equal(m.registration_endpoint, "https://d.example/api/oauth/register");
  assert.equal(m.client_id_metadata_document_supported, true);
});

test("logging is granted only when ticked, and old tokens read as read-only", async () => {
  const { grantedScope, scopesOf } = await import("./oauth.ts");
  assert.equal(grantedScope(true), "dissent:read dissent:log");
  assert.equal(grantedScope(false), "dissent:read");
  assert.deepEqual(scopesOf(null), ["dissent:read"]);
  assert.deepEqual(scopesOf("dissent:read dissent:log"), ["dissent:read", "dissent:log"]);
  assert.deepEqual(scopesOf("dissent:admin"), ["dissent:read"]);
});
