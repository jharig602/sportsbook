import assert from "node:assert/strict";
import { test } from "node:test";

import { digest, isOpenPath, sameDigest } from "./unlock.ts";

test("the cookie holds a digest, never the passcode", () => {
  return digest("hunter2").then((d) => {
    assert.match(d, /^[0-9a-f]{64}$/);
    assert.ok(!d.includes("hunter2"));
  });
});

test("different passcodes give different digests", async () => {
  assert.notEqual(await digest("a"), await digest("b"));
  // And the same one is stable, or every request would log you out.
  assert.equal(await digest("same"), await digest("same"));
});

test("comparison rejects wrong, short, and missing values", () => {
  const real = "a".repeat(64);
  assert.equal(sameDigest(real, real), true);
  assert.equal(sameDigest("b".repeat(64), real), false);
  assert.equal(sameDigest("a".repeat(63), real), false, "length mismatch must not pass");
  assert.equal(sameDigest(undefined, real), false);
  assert.equal(sameDigest("", real), false);
});

test("the dispatchers stay reachable without a cookie", () => {
  // GitHub Actions has no cookie and never will; those routes carry a bearer secret.
  for (const p of ["/api/dispatch-promo", "/api/dispatch-survivor", "/api/dispatch-shop", "/api/dispatch-alerts"]) {
    assert.equal(isOpenPath(p), true, p);
  }
});

test("the unlock route and the PWA shell stay reachable", () => {
  // Requiring the cookie to fetch the page that sets the cookie would lock you out,
  // and a service worker that cannot fetch its own manifest breaks the installed app.
  for (const p of ["/unlock", "/api/unlock", "/manifest.webmanifest", "/sw.js", "/icon.svg", "/offline.html"]) {
    assert.equal(isOpenPath(p), true, p);
  }
});

test("every write endpoint is behind the gate", () => {
  // The list this exists for. /api/book-lines feeds the consensus every edge is
  // measured against, and it accepted writes from anyone who knew the path.
  for (const p of [
    "/api/bets",
    "/api/book-lines",
    "/api/pools",
    "/api/settings",
    "/api/favourites",
    "/api/push/test",
    "/api/push/subscribe",
  ]) {
    assert.equal(isOpenPath(p), false, `${p} must NOT be open`);
  }
});

test("the public VAPID key stays public, but nothing near it does", () => {
  assert.equal(isOpenPath("/api/push/key"), true);
  assert.equal(isOpenPath("/api/push/keys"), false, "no prefix matching on that one");
});

test("pages are gated too, so the ledger is not world-readable", () => {
  for (const p of ["/", "/bets", "/shop", "/survivor", "/record"]) {
    assert.equal(isOpenPath(p), false, p);
  }
});
