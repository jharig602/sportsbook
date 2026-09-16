import assert from "node:assert/strict";
import { test } from "node:test";

import { buildRoiBreakdown, collapseByOutcome, roiCell } from "./shop-record.ts";
import type { ShopGrade } from "./types.ts";

let n = 0;
function grade(over: Partial<ShopGrade> = {}): ShopGrade {
  n += 1;
  return {
    grade_id: `g${n}`, pick_id: `p${n}`, graded_at: "2026-09-15T00:00:00Z", rule_version_id: "r",
    league: "nfl", market: "spread", side: "home", line: -3, price: -110,
    fair_probability: 0.55, expected_roi: 0.05, result_covered: true, result_push: false,
    replayed: false, event_id: `E${n}`, book: "FanDuel",
    ...over,
  };
}

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

// --- one result per outcome ------------------------------------------------------

test("two books on the same number are one result", () => {
  const rows = collapseByOutcome([
    grade({ event_id: "G", book: "FanDuel", price: -110 }),
    grade({ event_id: "G", book: "BetMGM", price: -105 }),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].copies, 2);
  assert.deepEqual(rows[0].books.sort(), ["BetMGM", "FanDuel"]);
  // The two payouts are averaged: 100/110 and 100/105.
  assert.ok(close(rows[0].profit, (100 / 110 + 100 / 105) / 2));
});

test("a different line, side or market is a different result", () => {
  const rows = collapseByOutcome([
    grade({ event_id: "G", line: -3 }),
    grade({ event_id: "G", line: -3.5 }),
    grade({ event_id: "G", side: "away", line: 3 }),
    grade({ event_id: "G", market: "moneyline", line: null }),
  ]);
  assert.equal(rows.length, 4);
});

test("results that disagree are never averaged together", () => {
  // Cannot happen for one game and number -- which is exactly why it must stay visible.
  const rows = collapseByOutcome([
    grade({ event_id: "G", result_covered: true }),
    grade({ event_id: "G", result_covered: false }),
  ]);
  assert.equal(rows.length, 2);
});

test("a pick with no game id is kept on its own, not guessed into a group", () => {
  const rows = collapseByOutcome([grade({ event_id: null }), grade({ event_id: null })]);
  assert.equal(rows.length, 2);
});

test("a pick with no usable price is left out rather than priced at nothing", () => {
  assert.equal(collapseByOutcome([grade({ price: null })]).length, 0);
  assert.equal(collapseByOutcome([grade({ price: 50 })]).length, 0);
});

// --- returns --------------------------------------------------------------------

test("return is profit per dollar at the prices actually taken", () => {
  const rows = collapseByOutcome([
    grade({ market: "moneyline", line: null, price: 300, result_covered: true }),
    grade({ market: "moneyline", line: null, price: 300, result_covered: false }),
    grade({ market: "moneyline", line: null, price: 300, result_covered: false }),
  ]);
  const cell = roiCell(rows, "moneyline", "nfl");
  assert.equal(cell.games, 3);
  assert.equal(cell.wins, 1);
  assert.ok(close(cell.profit, 3 - 2));
  assert.ok(close(cell.roi!, 1 / 3));
});

test("a push is a bet that returned its stake: in the count, out of the win rate", () => {
  const rows = collapseByOutcome([
    grade({ result_covered: true, price: 100 }),
    grade({ result_covered: null, result_push: true, price: 100 }),
  ]);
  const cell = roiCell(rows, "spread", "nfl");
  assert.equal(cell.games, 2);
  assert.equal(cell.decided, 1);
  assert.equal(cell.winRate, 1);
  assert.ok(close(cell.roi!, 0.5));
});

test("an underdog cell winning a third of the time is not a failure", () => {
  // Under the old grid, 34% against 52.4% reads as a disaster. At +300 it is a profit.
  const rows = collapseByOutcome([
    ...Array.from({ length: 34 }, () => grade({ market: "moneyline", line: null, price: 300, result_covered: true })),
    ...Array.from({ length: 66 }, () => grade({ market: "moneyline", line: null, price: 300, result_covered: false })),
  ]);
  const cell = roiCell(rows, "moneyline", "nfl");
  assert.ok(cell.roi! > 0);
  assert.notEqual(cell.state, "fails");
});

test("a favourite cell winning 60% can still be losing", () => {
  const rows = collapseByOutcome([
    ...Array.from({ length: 60 }, () => grade({ market: "moneyline", line: null, price: -200, result_covered: true })),
    ...Array.from({ length: 40 }, () => grade({ market: "moneyline", line: null, price: -200, result_covered: false })),
  ]);
  const cell = roiCell(rows, "moneyline", "nfl");
  assert.ok(cell.winRate! > 0.524);
  assert.ok(cell.roi! < 0);
});

test("luck's spread under fair pricing is the sum of the payouts", () => {
  const rows = collapseByOutcome([
    grade({ price: 300, result_covered: false }),
    grade({ price: 100, result_covered: true }),
    grade({ price: -200, result_covered: true }),
  ]);
  const cell = roiCell(rows, "spread", "nfl");
  assert.ok(close(cell.nullSd, Math.sqrt(3 + 1 + 0.5)));
});

test("the verdict calls a real edge, a real leak, and nothing in between", () => {
  const many = (won: number, lost: number, price = -110) =>
    collapseByOutcome([
      ...Array.from({ length: won }, () => grade({ price, result_covered: true })),
      ...Array.from({ length: lost }, () => grade({ price, result_covered: false })),
    ]);
  assert.equal(roiCell(many(160, 40), "spread", "nfl").state, "clears");
  assert.equal(roiCell(many(40, 160), "spread", "nfl").state, "fails");
  assert.equal(roiCell(many(11, 10), "spread", "nfl").state, "undecided");
  assert.equal(roiCell([], "spread", "nfl").state, "no-data");
});

test("expected return is the average of what the picks predicted", () => {
  const rows = collapseByOutcome([grade({ expected_roi: 0.02 }), grade({ expected_roi: 0.06 })]);
  assert.ok(close(roiCell(rows, "spread", "nfl").expectedRoi!, 0.04));
});

// --- reading six cells at once ----------------------------------------------------

test("the best of six reports how often luck alone would match it", () => {
  const rows = collapseByOutcome([
    ...Array.from({ length: 6 }, () => grade({ league: "nfl", market: "total", line: 45, side: "over", result_covered: true })),
    ...Array.from({ length: 2 }, () => grade({ league: "nfl", market: "total", line: 45, side: "over", result_covered: false })),
    ...Array.from({ length: 10 }, () => grade({ league: "nfl", result_covered: true })),
    ...Array.from({ length: 21 }, () => grade({ league: "nfl", result_covered: false })),
  ]);
  const breakdown = buildRoiBreakdown(rows);
  assert.equal(breakdown.best!.market, "total");
  assert.equal(breakdown.compared, 2);
  assert.ok(breakdown.familyP! > 0 && breakdown.familyP! < 1);
  assert.equal(breakdown.cells.length, 6);
});

test("the header counts picks and the results they collapse to", () => {
  const rows = collapseByOutcome([
    grade({ event_id: "G", book: "A" }),
    grade({ event_id: "G", book: "B" }),
    grade({ event_id: "H" }),
  ]);
  const breakdown = buildRoiBreakdown(rows);
  assert.equal(breakdown.picks, 3);
  assert.equal(breakdown.results, 2);
});

test("nothing graded is nothing to say", () => {
  const breakdown = buildRoiBreakdown([]);
  assert.equal(breakdown.best, null);
  assert.equal(breakdown.familyP, null);
});
