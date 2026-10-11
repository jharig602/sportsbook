import assert from "node:assert/strict";
import { test } from "node:test";

import { afterTaxEv, breakEvenAfterTax, parseTax, yearTax } from "./tax.ts";
import type { GradedRow } from "./settle.ts";

const near = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;
const none = { rate: 0.26, losses: "none" as const };
const itemize = { rate: 0.26, losses: "itemize" as const };

test("at -110 with no loss deduction a plain bet needs about 60% after tax", () => {
  const be = breakEvenAfterTax(-110, none)!;
  assert.ok(be > 0.59 && be < 0.61, `break-even ${be}`);
  assert.ok(near(breakEvenAfterTax(-110, { rate: 0, losses: "none" })!, 110 / 210), "no tax: the usual 52.4%");
  assert.ok(breakEvenAfterTax(-110, itemize)! < be, "itemizing losses lowers the bar");
});

test("a 50% boost on a -110 over survives tax; the same bet unboosted does not", () => {
  assert.ok(afterTaxEv(0.516, -110, none, { boost: 0.5 }) > 0);
  assert.ok(afterTaxEv(0.516, -110, none) < -0.1);
});

test("a losing bonus bet costs nothing, so its value after tax is its taxed winnings", () => {
  assert.ok(near(afterTaxEv(0.25, 300, none, { bonus: true }), 0.25 * 3 * 0.74));
});

test("the year's tax: winnings taxed in full, losses off only when itemizing (90%, capped)", () => {
  const rows = [
    { commence_time: "2026-10-04T17:00:00Z", outcome: "won", profit: 100, stake: 25 },
    { commence_time: "2026-10-04T17:00:00Z", outcome: "lost", profit: -60, stake: 60 },
    { commence_time: "2026-10-04T17:00:00Z", outcome: "cashed", profit: 20, stake: 10 },
    { commence_time: "2025-12-01T17:00:00Z", outcome: "won", profit: 999, stake: 1 },
    { commence_time: "2026-10-11T17:00:00Z", outcome: "open", profit: 0, stake: 10 },
  ] as unknown as GradedRow[];
  const plain = yearTax(rows, { rate: 0.24, losses: "none" }, 2026);
  assert.equal(plain.winnings, 120);
  assert.equal(plain.losses, 60);
  assert.ok(near(plain.tax, 0.24 * 120));
  assert.ok(near(plain.afterTax, 60 - 28.8), "net +$60, less $28.80 of tax");
  const item = yearTax(rows, { rate: 0.24, losses: "itemize" }, 2026);
  assert.ok(near(item.tax, 0.24 * (120 - 54)));
});

test("settings are clamped and default sensibly", () => {
  assert.deepEqual(parseTax({ rate: 0.3, losses: "itemize" }), { rate: 0.3, losses: "itemize" });
  assert.deepEqual(parseTax({ rate: 9 }), { rate: 0.24, losses: "none" });
  assert.deepEqual(parseTax(null), { rate: 0.24, losses: "none" });
});
