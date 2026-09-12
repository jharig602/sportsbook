import assert from "node:assert/strict";
import { test } from "node:test";

import {
  HOUSE,
  newOwnerId,
  newTransferCode,
  normalizeTransferCode,
  ownerIdFor,
  transferExpired,
  TRANSFER_LENGTH,
  TRANSFER_TTL_MS,
  validOwnerId,
} from "./owner.ts";

test("a minted identifier is 128 random bits, and they are actually different", () => {
  const seen = new Set(Array.from({ length: 200 }, () => newOwnerId()));
  assert.equal(seen.size, 200, "a collision here would merge two people's ledgers");
  for (const id of seen) assert.match(id, /^[0-9a-f]{32}$/);
});

test("the owner's ledger is not addressable by cookie", () => {
  // The whole asymmetry. A visitor who simply sets dissent_owner=owner must not land
  // in the ledger the passcode exists to protect.
  assert.equal(validOwnerId(HOUSE), false);
  assert.equal(ownerIdFor("viewer", HOUSE), null);
  assert.equal(ownerIdFor("viewer", "OWNER"), null);
});

test("a malformed cookie yields no ledger rather than a new one", () => {
  for (const bad of [undefined, "", "xyz", "A".repeat(32), "a".repeat(31), "a".repeat(33)]) {
    assert.equal(validOwnerId(bad as string | undefined), false, String(bad));
    assert.equal(ownerIdFor("viewer", bad as string | undefined), null);
  }
});

test("role wins over cookie, in both directions", () => {
  const id = newOwnerId();
  // Signing in with the real passcode shows MY season, not the one the cookie names.
  assert.equal(ownerIdFor("owner", id), HOUSE);
  assert.equal(ownerIdFor("owner", undefined), HOUSE);
  // And nobody signed in reaches any ledger at all.
  assert.equal(ownerIdFor(null, id), null);
});

test("a good cookie is used as-is", () => {
  const id = newOwnerId();
  assert.equal(ownerIdFor("viewer", id), id);
});

test("transfer codes avoid every confusable character", () => {
  // Both members of each pair are excluded, not one: no 0 and no O, no 1/I/L, no 5/S.
  // A code is read off one screen and typed into another, and "it says the code is
  // wrong" with no way to tell which character was misread is the failure to design out.
  for (let i = 0; i < 300; i += 1) {
    const code = newTransferCode();
    assert.equal(code.length, TRANSFER_LENGTH);
    assert.ok(!/[0O1IL5S]/.test(code), `${code} contains a lookalike`);
    assert.match(code, /^[A-Z2-9]+$/);
  }
});

test("codes are not predictable enough to be worth guessing", () => {
  const seen = new Set(Array.from({ length: 500 }, () => newTransferCode()));
  assert.equal(seen.size, 500);
});

test("what people type is repaired; what they mistype is refused", () => {
  const code = newTransferCode();
  assert.equal(normalizeTransferCode(code), code);
  assert.equal(normalizeTransferCode(code.toLowerCase()), code);
  assert.equal(
    normalizeTransferCode(`${code.slice(0, 4)}-${code.slice(4)}`),
    code,
    "people break a code into chunks",
  );
  assert.equal(normalizeTransferCode(`  ${code}  `), code);

  // Wrong length, and characters that were never issued.
  assert.equal(normalizeTransferCode(""), null);
  assert.equal(normalizeTransferCode(code.slice(1)), null);
  assert.equal(normalizeTransferCode(`${code}X`), null);
  assert.equal(normalizeTransferCode("OOOOOOOO"), null, "O is not in the alphabet");
  assert.equal(normalizeTransferCode("00000000"), null, "nor is 0");
  assert.equal(normalizeTransferCode("11111111"), null);
});

test("a code expires, and anything unreadable counts as expired", () => {
  const now = Date.now();
  const fresh = new Date(now - 60_000).toISOString();
  const stale = new Date(now - TRANSFER_TTL_MS - 1000).toISOString();
  assert.equal(transferExpired(fresh, now), false);
  assert.equal(transferExpired(stale, now), true);
  // Exactly on the boundary is still good; the comparison is strictly greater.
  assert.equal(transferExpired(new Date(now - TRANSFER_TTL_MS).toISOString(), now), false);
  // A timestamp that cannot be read must not become a code that never expires.
  assert.equal(transferExpired("not a date", now), true);
});

test("a Date and its ISO string are treated the same", () => {
  const now = Date.now();
  const when = new Date(now - 60_000);
  assert.equal(transferExpired(when, now), transferExpired(when.toISOString(), now));
});
