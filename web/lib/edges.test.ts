/**
 * Edge-ranking tests.
 *
 * The whole point of this list is that it says how much to trust itself. The tests
 * that matter are the ones checking a small edge is marked as inside the noise, and
 * that the noise band actually widens as the sample shrinks.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildEdges, standardErrorPoints } from "./edges.ts";
import type { MarginModel } from "./probability.ts";
import type { Game } from "./types.ts";

function model(games = 291): MarginModel {
  const pmf: Record<string, number> = {};
  for (let h = -40; h <= 40; h += 1) pmf[String(h)] = 1 / 81;
  return { league: "nfl", games, mean: 0, sd: 12.3, lo: -20, hi: 20, pmf };
}

function game(overrides: Partial<Game> = {}): Game {
  return {
    eventId: "E1",
    league: "nfl",
    commenceTime: "2026-09-13T21:00:00.000Z",
    homeTeam: "Houston Texans",
    awayTeam: "Buffalo Bills",
    homeTeamId: "34",
    awayTeamId: "2",
    lastObserved: "2026-09-07T12:00:00.000Z",
    spread: { home: { line: -1.5, price: 102 }, away: { line: 1.5, price: -122 } },
    total: {},
    moneyline: { home: { line: null, price: -110 }, away: { line: null, price: -110 } },
    ...overrides,
  };
}

test("standard error widens as the sample shrinks", () => {
  const big = standardErrorPoints(0.53, 1000);
  const small = standardErrorPoints(0.53, 100);
  assert.ok(small > big);
});

test("standard error at the real NFL sample is about three points", () => {
  const error = standardErrorPoints(0.53, 291);
  assert.ok(error > 2.5 && error < 3.5, `expected ~2.9, got ${error}`);
});

test("no model for the league means no edge", () => {
  assert.deepEqual(buildEdges([game()], {}), []);
});

test("a game without a two-sided moneyline is skipped", () => {
  const g = game({ moneyline: { home: { line: null, price: -110 } } });
  assert.deepEqual(buildEdges([g], { nfl: model() }), []);
});

test("a game without a spread is skipped", () => {
  assert.deepEqual(buildEdges([game({ spread: {} })], { nfl: model() }), []);
});

test("the juiced spread is priced, not read literally", () => {
  const [edge] = buildEdges([game()], { nfl: model() });
  assert.ok(edge, "should produce an edge row");
  // Posted -1.5 at +102/-122 is really about -0.7.
  assert.ok(
    edge.effectiveSpread > edge.postedSpread,
    `effective ${edge.effectiveSpread} should lay fewer points than posted ${edge.postedSpread}`,
  );
});

test("a small edge is marked as inside the noise", () => {
  const [edge] = buildEdges([game()], { nfl: model() });
  assert.ok(edge.edgePoints < edge.standardErrorPoints);
  assert.equal(edge.outsideNoise, false);
});

test("a large edge clears the noise band", () => {
  // A heavy favourite priced as a coin flip is a real disagreement.
  const g = game({
    spread: { home: { line: -10, price: -110 }, away: { line: 10, price: -110 } },
  });
  const [edge] = buildEdges([g], { nfl: model() });
  assert.ok(edge.edgePoints > edge.standardErrorPoints);
  assert.equal(edge.outsideNoise, true);
});

test("rows are sorted biggest edge first", () => {
  const flat = game({ eventId: "flat" });
  const wide = game({
    eventId: "wide",
    spread: { home: { line: -10, price: -110 }, away: { line: 10, price: -110 } },
  });
  const edges = buildEdges([flat, wide], { nfl: model() });
  assert.equal(edges[0].eventId, "wide");
  assert.ok(edges[0].edgePoints >= edges[1].edgePoints);
});

test("the reported side is the one the model prefers", () => {
  const g = game({
    spread: { home: { line: -10, price: -110 }, away: { line: 10, price: -110 } },
  });
  const [edge] = buildEdges([g], { nfl: model() });
  assert.equal(edge.side, "home", "a 10-point favourite priced even favours the home side");
  assert.equal(edge.team, "Houston Texans");
});

test("a thinner model widens every noise band", () => {
  const [wide] = buildEdges([game()], { nfl: model(50) });
  const [narrow] = buildEdges([game()], { nfl: model(5000) });
  assert.ok(wide.standardErrorPoints > narrow.standardErrorPoints);
});

test("the model does not systematically favour the home side", () => {
  // The failure this guards against: a non-zero residual mean tilts every game the
  // same way, so a ranked list becomes one hypothesis about home teams repeated N
  // times rather than N findings.
  const biased = { ...model(), mean: 1.4 };
  const spreads = [-14, -10, -7, -3, -1, 0, 1, 3, 7, 10, 14];
  const games = spreads.map((line, i) =>
    game({
      eventId: `g${i}`,
      spread: { home: { line, price: -110 }, away: { line: -line, price: -110 } },
      moneyline: { home: { line: null, price: -110 }, away: { line: null, price: -110 } },
    }),
  );
  const edges = buildEdges(games, { nfl: biased });
  const homeSides = edges.filter((e) => e.side === "home").length;
  assert.ok(
    homeSides < edges.length,
    `every edge favoured the home side (${homeSides}/${edges.length})`,
  );
});

test("expected return prices the vig, not just the edge", () => {
  // A coin flip at -110 must be a losing bet even though the "edge" is zero.
  const g = game({
    spread: { home: { line: 0, price: -110 }, away: { line: 0, price: -110 } },
    moneyline: { home: { line: null, price: -110 }, away: { line: null, price: -110 } },
  });
  const [edge] = buildEdges([g], { nfl: model() });
  assert.ok(edge.expectedRoi < 0, `a -110 coin flip must lose money, got ${edge.expectedRoi}`);
  assert.ok(Math.abs(edge.breakEven - 0.5238) < 0.001, "break-even at -110 is 52.4%");
});

test("break-even follows the price", () => {
  const at130 = buildEdges(
    [game({ moneyline: { home: { line: null, price: 130 }, away: { line: null, price: -160 } } })],
    { nfl: model() },
  )[0];
  assert.ok(Math.abs(at130.breakEven - 0.4348) < 0.001, "break-even at +130 is 43.5%");
});

test("expected return uses the shrunk probability, not the raw one", () => {
  // Two identical games: shrinkage is estimated across the board, so a lone row with a
  // big raw edge should still price close to break-even once shrunk.
  const g = game({
    spread: { home: { line: -10, price: -110 }, away: { line: 10, price: -110 } },
    moneyline: { home: { line: null, price: -110 }, away: { line: null, price: -110 } },
  });
  const [edge] = buildEdges([g, { ...g, eventId: "E2" }], { nfl: model() });
  assert.ok(
    edge.expectedRoi < edge.edgePoints / 100,
    "raw edge must not flow straight through to expected return",
  );
});
