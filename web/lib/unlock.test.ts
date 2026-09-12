import assert from "node:assert/strict";
import { test } from "node:test";

import { digest, isOpenPath, roleFor, sameDigest, viewerAllowed } from "./unlock.ts";

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

// --- the read-only viewer -------------------------------------------------------------

test("a viewer sees the market, never your money", () => {
  for (const p of ["/", "/shop", "/record", "/movers", "/edges", "/about", "/game/401856782"]) {
    assert.equal(viewerAllowed(p), true, p);
  }
  for (const p of ["/bets", "/survivor"]) {
    assert.equal(viewerAllowed(p), false, `${p} must stay private`);
  }
});

test("survivor is closed to viewers as strategy, not privacy", () => {
  // The objective is P(last entrant standing), and its value comes from NOT holding
  // the same ticket as the field. Showing a rival the pick converts a differentiated
  // entry into a shared one for free.
  assert.equal(viewerAllowed("/survivor"), false);
  assert.equal(viewerAllowed("/survivor?pool=1"), false, "a query string is not a way in");
});

test("a viewer can never write, on any route", () => {
  for (const p of [
    "/api/bets", "/api/book-lines", "/api/pools", "/api/settings",
    "/api/favourites", "/api/push/test", "/api/push/subscribe", "/api/unlock",
  ]) {
    assert.equal(viewerAllowed(p), false, p);
  }
});

test("a prefix is not a way past the page list", () => {
  // "/betsomething" must not ride in on "/bets" being absent, and "/shopping" must not
  // ride in on "/shop" being present.
  assert.equal(viewerAllowed("/shopping"), false);
  assert.equal(viewerAllowed("/recordings"), false);
});

test("the cookie decides the role, and a wrong one decides nothing", () => {
  const owner = "a".repeat(64);
  const viewer = "b".repeat(64);
  assert.equal(roleFor(owner, owner, viewer), "owner");
  assert.equal(roleFor(viewer, owner, viewer), "viewer");
  assert.equal(roleFor("c".repeat(64), owner, viewer), null);
  assert.equal(roleFor(undefined, owner, viewer), null);
});

test("with no viewer passcode set, only the owner cookie means anything", () => {
  const owner = "a".repeat(64);
  assert.equal(roleFor(owner, owner, null), "owner");
  assert.equal(roleFor("b".repeat(64), owner, null), null);
});

test("the owner cookie wins even if both digests somehow matched", () => {
  const same = "a".repeat(64);
  assert.equal(roleFor(same, same, same), "owner", "never downgrade the owner");
});
