/**
 * Passcode rate-limit tests.
 *
 * The cases that matter are the ways an attacker would try to slip past: spreading
 * guesses across addresses, waiting out a window, or hiding the address entirely.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { normaliseSecret, refuseUnlessDispatcher } from "./dispatch-auth.ts";
import {
  GLOBAL_LIMIT,
  PER_SOURCE_LIMIT,
  type Failure,
  hashSource,
  lockoutFor,
  sourceOf,
  waitText,
} from "./unlock-limit.ts";

const NOW = new Date("2026-09-25T18:00:00Z");
const ago = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000);

function failures(source: string, count: number, minutesAgo = 1): Failure[] {
  return Array.from({ length: count }, () => ({ sourceHash: source, at: ago(minutesAgo) }));
}

test("a few wrong guesses do not lock anyone out", () => {
  // You mistype it. That must never cost you your own app.
  const result = lockoutFor(failures("me", 3), "me", NOW);
  assert.equal(result.locked, false);
});

test("ten wrong guesses from one source lock that source out", () => {
  const result = lockoutFor(failures("attacker", PER_SOURCE_LIMIT), "attacker", NOW);
  assert.equal(result.locked, true);
  assert.equal(result.scope, "source");
  assert.ok(result.retryAfterSeconds > 0);
});

test("one source being locked out does not lock out another", () => {
  const result = lockoutFor(failures("attacker", PER_SOURCE_LIMIT), "me", NOW);
  assert.equal(result.locked, false);
});

test("guesses spread across many addresses still hit the global limit", () => {
  // The attack a per-source limit alone cannot see: one guess each from a hundred hosts.
  const spread: Failure[] = Array.from({ length: GLOBAL_LIMIT }, (_, i) => ({
    sourceHash: `host-${i}`,
    at: ago(5),
  }));
  const result = lockoutFor(spread, "host-new", NOW);
  assert.equal(result.locked, true);
  assert.equal(result.scope, "global");
});

test("old failures age out of the window", () => {
  const stale = failures("me", PER_SOURCE_LIMIT, 20); // older than fifteen minutes
  assert.equal(lockoutFor(stale, "me", NOW).locked, false);
});

test("the wait is measured from the oldest failure still counting", () => {
  // Ten failures, the oldest ten minutes ago: five minutes until it ages out.
  const list = [
    ...failures("attacker", 1, 10),
    ...failures("attacker", PER_SOURCE_LIMIT - 1, 1),
  ];
  const result = lockoutFor(list, "attacker", NOW);
  assert.equal(result.retryAfterSeconds, 5 * 60);
});

test("the platform's own address header wins over one a client could send", () => {
  const headers = new Headers({
    "x-forwarded-for": "6.6.6.6",
    "x-vercel-forwarded-for": "1.2.3.4",
  });
  assert.equal(sourceOf(headers), "1.2.3.4");
});

test("a forwarded list is read from its first entry", () => {
  assert.equal(sourceOf(new Headers({ "x-forwarded-for": "9.9.9.9, 10.0.0.1" })), "9.9.9.9");
});

test("a request with no address shares one bucket, which locks faster, not slower", () => {
  assert.equal(sourceOf(new Headers()), "unknown");
});

test("addresses are stored only as a hash", async () => {
  const hashed = await hashSource("1.2.3.4");
  assert.match(hashed, /^[0-9a-f]{64}$/);
  assert.ok(!hashed.includes("1.2.3.4"));
  assert.equal(hashed, await hashSource("1.2.3.4"), "the same address hashes the same way");
});

test("the wait is said in words", () => {
  assert.equal(waitText(30), "a minute");
  assert.equal(waitText(5 * 60), "5 minutes");
});

// --- the cron endpoints' shared secret check -------------------------------------


function call(authorization?: string): Request {
  return new Request("https://example.test/api/dispatch-daily", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

test("the collector's secret is let through", async () => {
  process.env.ALERT_DISPATCH_SECRET = "correct-horse-battery";
  assert.equal(await refuseUnlessDispatcher(call("Bearer correct-horse-battery")), null);
});

test("a wrong or missing secret is refused", async () => {
  process.env.ALERT_DISPATCH_SECRET = "correct-horse-battery";
  assert.equal((await refuseUnlessDispatcher(call("Bearer wrong")))?.status, 401);
  assert.equal((await refuseUnlessDispatcher(call()))?.status, 401);
  // A secret that is a prefix of the real one must not pass: the old `!==` would have
  // refused it too, but a hand-rolled early-exit compare is exactly where that breaks.
  assert.equal((await refuseUnlessDispatcher(call("Bearer correct-horse")))?.status, 401);
});

test("with no secret configured, everything is refused rather than everything allowed", async () => {
  delete process.env.ALERT_DISPATCH_SECRET;
  assert.equal((await refuseUnlessDispatcher(call("Bearer anything")))?.status, 503);
  assert.equal((await refuseUnlessDispatcher(call()))?.status, 503);
});

test("the ways a secret gets mangled when pasted are forgiven", () => {
  assert.equal(normaliseSecret("  abc123\n"), "abc123");
  assert.equal(normaliseSecret('"abc123"'), "abc123");
  assert.equal(normaliseSecret("ALERT_DISPATCH_SECRET=abc123"), "abc123");
  assert.equal(normaliseSecret(""), null);
});
