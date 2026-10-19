import assert from "node:assert/strict";
import test from "node:test";

import { duePromoReminders, promoReminderKey, timeLeft } from "./promo-expiry.ts";
import type { Promo } from "./types.ts";

const NOW = new Date("2026-10-19T15:00:00.000Z");
const promo = (id: string, expires: string, status: Promo["status"] = "available"): Promo =>
  ({ promo_id: id, book: "DraftKings", type: "profit_boost", title: "50% boost", expires_at: expires, status }) as Promo;

test("only available tokens expiring within the day, not yet announced, soonest first", () => {
  const promos = [
    promo("later", "2026-10-21T15:00:00.000Z"), // two days out
    promo("soon", "2026-10-19T20:00:00.000Z"),
    promo("sooner", "2026-10-19T17:00:00.000Z"),
    promo("used", "2026-10-19T18:00:00.000Z", "used"),
    promo("gone", "2026-10-19T14:00:00.000Z"), // already expired
    promo("told", "2026-10-19T19:00:00.000Z"),
  ];
  const due = duePromoReminders(promos, NOW, new Set([promoReminderKey({ promo_id: "told" })]));
  assert.deepEqual(due.map((p) => p.promo_id), ["sooner", "soon"]);
});

test("time left reads naturally", () => {
  assert.equal(timeLeft("2026-10-19T15:40:00.000Z", NOW), "in 40 minutes");
  assert.equal(timeLeft("2026-10-19T20:00:00.000Z", NOW), "in 5 hours");
  assert.equal(timeLeft("2026-10-19T16:00:00.000Z", NOW), "in 60 minutes");
});
