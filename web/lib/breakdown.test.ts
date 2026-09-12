import assert from "node:assert/strict";
import { test } from "node:test";

import { buildBreakdown, filterGrades, MARKETS, LEAGUES } from "./breakdown.ts";
import type { Grade, League, Market } from "./types";

let n = 0;
function grade(market: Market, league: League, covered: boolean | null, push = false): Grade {
  n += 1;
  return {
    grade_id: `g${n}`, alert_id: `a${n}`, graded_at: "2026-09-12T00:00:00.000Z",
    rule_version_id: "r1", market, predicted_side: "home", move_strength: 60,
    line_value_points: null, line_value_won: null,
    result_covered: covered, result_push: push, kind: "steam", league,
  };
}

function many(market: Market, league: League, wins: number, losses: number): Grade[] {
  return [
    ...Array.from({ length: wins }, () => grade(market, league, true)),
    ...Array.from({ length: losses }, () => grade(market, league, false)),
  ];
}

test("every market/league combination gets a cell, even the empty ones", () => {
  const { cells } = buildBreakdown([]);
  assert.equal(cells.length, MARKETS.length * LEAGUES.length);
  // An empty cell must still appear. Hiding it reads as "there are no moneyline
  // alerts", which is a different claim from "none have settled".
  for (const c of cells) {
    assert.equal(c.decided, 0);
    assert.equal(c.rate, null);
    assert.equal(c.alone.state, "no-data");
  }
});

test("pushes leave the denominator but are still counted", () => {
  const grades = [
    grade("spread", "nfl", true),
    grade("spread", "nfl", false),
    grade("spread", "nfl", null, true),
  ];
  const spreadNfl = buildBreakdown(grades).cells.find(
    (c) => c.market === "spread" && c.league === "nfl",
  )!;
  assert.equal(spreadNfl.decided, 2, "the push is not a decided game");
  assert.equal(spreadNfl.pushes, 1);
  assert.equal(spreadNfl.rate, 0.5);
});

test("a filter cuts on both axes independently", () => {
  const grades = [...many("spread", "nfl", 3, 0), ...many("total", "ncaaf", 2, 0)];
  assert.equal(filterGrades(grades, "all", "all").length, 5);
  assert.equal(filterGrades(grades, "spread", "all").length, 3);
  assert.equal(filterGrades(grades, "all", "ncaaf").length, 2);
  assert.equal(filterGrades(grades, "spread", "ncaaf").length, 0);
});

test("the same cell is judged more strictly as one of six than on its own", () => {
  // A rate that clears break-even on its own terms but not after paying for six looks.
  const grades = many("spread", "nfl", 40, 20);
  const c = buildBreakdown(grades).cells.find((x) => x.market === "spread" && x.league === "nfl")!;
  assert.ok(c.adjusted.lo < c.alone.lo, "the adjusted interval must be wider");
  assert.ok(c.adjusted.hi > c.alone.hi);
  assert.equal(c.alone.state, "clears");
});

test("the best of six is reported with how often six would produce it by luck", () => {
  // Six cells of seventeen, all at a true coin flip, one of which ran hot.
  const grades = [
    ...many("spread", "nfl", 12, 5),
    ...many("spread", "ncaaf", 9, 8),
    ...many("total", "nfl", 8, 9),
    ...many("total", "ncaaf", 9, 8),
    ...many("moneyline", "nfl", 8, 9),
    ...many("moneyline", "ncaaf", 7, 10),
  ];
  const { selection } = buildBreakdown(grades);
  assert.equal(selection.compared, 6);
  assert.equal(selection.best!.market, "spread");
  assert.equal(selection.best!.league, "nfl");
  assert.ok(Math.abs(selection.best!.rate! - 12 / 17) < 1e-9);
  // On its own that cell is a one-in-eight fluke; across six looks it is commonplace,
  // and this is the number that should stop you betting it.
  assert.ok(selection.familyP! > 0.4, `familyP=${selection.familyP}`);
  assert.ok(selection.familyP! > selection.best!.p!, "selection can only make it likelier");
});

test("a lone cell carries no selection penalty", () => {
  const { selection } = buildBreakdown(many("spread", "nfl", 12, 5));
  assert.equal(selection.compared, 1);
  // With one cell compared, the family probability IS that cell's own p-value.
  assert.ok(Math.abs(selection.familyP! - selection.best!.p!) < 1e-9);
});

test("cells too thin to compare stay in the table and out of the maths", () => {
  const grades = [...many("spread", "nfl", 30, 20), ...many("moneyline", "nfl", 2, 0)];
  const { cells, selection } = buildBreakdown(grades);
  const thin = cells.find((c) => c.market === "moneyline" && c.league === "nfl")!;
  assert.equal(thin.decided, 2);
  assert.equal(thin.rate, 1, "it still shows its 100%");
  assert.equal(selection.compared, 1, "but it is not a candidate");
  assert.equal(selection.best!.market, "spread", "and cannot be the best");
});

test("no data anywhere yields no best and no probability", () => {
  const { selection } = buildBreakdown([grade("spread", "nfl", null, true)]);
  assert.equal(selection.best, null);
  assert.equal(selection.familyP, null, "not zero -- there is nothing to say");
});
