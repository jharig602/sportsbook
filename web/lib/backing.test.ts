import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardEdge } from "./board-shop.ts";
import { planBacking, spreadOfOptions } from "./backing.ts";

const row = (over: Partial<BoardEdge> = {}): BoardEdge =>
  ({
    book: "BetMGM", market: "spread", side: "home", line: -3, price: -110,
    expectedRoi: -0.045, stale: false, eventId: "e1", league: "nfl",
    homeTeam: "Detroit Lions", awayTeam: "Chicago Bears", gameSpread: -3,
    ...over,
  }) as BoardEdge;

test("only sides that actually back the team are offered", () => {
  const rows = [
    row({ side: "home" }),                              // Lions -3
    row({ side: "away" }),                              // Bears +3, not the Lions
    row({ market: "total", side: "over", line: 47 }),   // not a way to back anyone
  ];
  const plan = planBacking(rows, "Detroit Lions");
  assert.equal(plan.options.length, 1);
  assert.equal(plan.options[0].row.side, "home");
});

test("a total is never offered as a way to back a team", () => {
  // Including it would answer a different question than the one asked.
  const plan = planBacking([row({ market: "total", side: "over", line: 47 })], "Detroit Lions");
  assert.equal(plan.options.length, 0);
  assert.equal(plan.best, null);
});

test("options are ranked by what they cost, not by how likely they are", () => {
  const rows = [
    row({ market: "moneyline", price: -190, expectedRoi: -0.07 }),
    row({ market: "spread", price: -110, expectedRoi: -0.02 }),
  ];
  const plan = planBacking(rows, "Detroit Lions");
  assert.equal(plan.best!.row.market, "spread");
  assert.ok(plan.best!.expectedRoi > plan.options[1].expectedRoi);
});

test("a book you can actually reach beats a better price you cannot", () => {
  // The best number on the board is routinely at an offshore book. It is not an option.
  const rows = [
    row({ book: "LowVig.ag", expectedRoi: 0.06 }),
    row({ book: "BetMGM", expectedRoi: -0.01 }),
  ];
  const plan = planBacking(rows, "Detroit Lions", { myBooks: ["BetMGM", "FanDuel"] });
  assert.equal(plan.best!.row.book, "BetMGM");
  // The unreachable one is still listed, so you can see what you are missing.
  assert.equal(plan.options.length, 2);
});

test("with no books of your own, the best on the board stands in", () => {
  const plan = planBacking([row({ book: "LowVig.ag", expectedRoi: 0.06 })], "Detroit Lions");
  assert.equal(plan.best!.row.book, "LowVig.ag");
});

test("every option losing money is reported, not hidden", () => {
  // The usual case, and the honest one: you are betting anyway, so the answer is which
  // loss is smallest rather than whether to bet.
  const plan = planBacking(
    [row({ expectedRoi: -0.02 }), row({ market: "moneyline", expectedRoi: -0.08 })],
    "Detroit Lions",
  );
  assert.equal(plan.allNegative, true);
  assert.ok(plan.best!.expectedRoi < 0);
});

test("a stale quote is not an option", () => {
  const plan = planBacking([row({ stale: true, expectedRoi: 0.2 })], "Detroit Lions");
  assert.equal(plan.options.length, 0);
});

test("the blowout filter applies here too when asked for", () => {
  const plan = planBacking([row({ gameSpread: -56 })], "Detroit Lions", { maxSpread: 28 });
  assert.equal(plan.options.length, 0);
  // And without a limit, nothing is hidden.
  assert.equal(planBacking([row({ gameSpread: -56 })], "Detroit Lions").options.length, 1);
});

test("a team not playing this week has no options rather than an empty best", () => {
  const plan = planBacking([row()], "Green Bay Packers");
  assert.equal(plan.options.length, 0);
  assert.equal(plan.best, null);
  assert.equal(plan.allNegative, false, "no options is not the same as all losing");
});

test("the spread between best and worst is what the choice is worth", () => {
  // The number that makes this worth having: cents per dollar, on a decision already made.
  const plan = planBacking(
    [
      row({ book: "BetMGM", expectedRoi: -0.02 }),
      row({ book: "BetMGM", market: "moneyline", expectedRoi: -0.08 }),
    ],
    "Detroit Lions",
    { myBooks: ["BetMGM"] },
  );
  assert.ok(Math.abs(spreadOfOptions(plan)! - 0.06) < 1e-9);
});

test("one option means there is no choice to price", () => {
  assert.equal(spreadOfOptions(planBacking([row()], "Detroit Lions")), null);
  assert.equal(spreadOfOptions(planBacking([], "Detroit Lions")), null);
});
