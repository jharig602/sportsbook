import { test } from "node:test";
import assert from "node:assert/strict";

import { parseParlay, parseSingle } from "./bet-input.ts";

let n = 0;
const id = () => `id${++n}`;
const NOW = new Date("2026-10-25T15:00:00Z");
const single = {
  event_id: "g1", league: "nfl", home_team: "Detroit Lions", away_team: "Green Bay Packers",
  commence_time: "2026-10-25T20:25:00Z", market: "spread", side: "home", line: -2.5, price: -110, stake: 25, book: "FanDuel",
};

test("a good single parses into a bet with the line on the side taken", () => {
  const { problems, bet, corrects } = parseSingle(single, id, NOW);
  assert.deepEqual(problems, []);
  assert.equal(corrects, null);
  assert.equal(bet?.line, -2.5);
  assert.equal(bet?.placed_at, NOW.toISOString());
  assert.equal(bet?.bonus, false);
});

test("a single is refused with every reason at once", () => {
  const { problems, bet } = parseSingle({ ...single, line: null, price: 50, stake: 0 }, id, NOW);
  assert.equal(bet, null);
  assert.ok(problems.includes("A spread or total needs a line."));
  assert.ok(problems.some((p) => p.startsWith("Price must be")));
  assert.ok(problems.includes("Stake must be more than zero."));
  assert.ok(parseSingle({ ...single, market: "total", side: "home" }, id, NOW).problems.includes("A total is bet over, under, odd or even."));
  assert.ok(parseSingle({ ...single, placed_at: "2026-10-26T15:00:00Z" }, id, NOW).problems.includes("placed_at is in the future."));
});

test("a missing probability stays missing instead of becoming 0%", () => {
  const { bet } = parseSingle({ ...single, model_probability: null, market_probability: "" }, id, NOW);
  assert.equal(bet?.model_probability, null);
  assert.equal(bet?.market_probability, null);
  assert.equal(parseSingle({ ...single, market_probability: 0.53 }, id, NOW).bet?.market_probability, 0.53);
});

test("a prop needs player, stat, over/under and its number", () => {
  const prop = { ...single, market: "prop", side: "over", line: 274.5, prop_player: "Jared Goff", prop_stat: "pass_yds" };
  assert.deepEqual(parseSingle(prop, id, NOW).problems, []);
  const bad = parseSingle({ ...prop, prop_stat: "sacks", side: "home" }, id, NOW).problems;
  assert.ok(bad.includes("Prop: pick the stat."));
  assert.ok(bad.includes("Prop: a prop is over or under."));
});

test("a cash-out is a correction carrying the cash received", () => {
  const { bet, corrects } = parseSingle({ ...single, supersedes: "b0", cashout: 30 }, id, NOW);
  assert.equal(corrects, "b0");
  assert.equal(bet?.cashout, 30);
  assert.ok(parseSingle({ ...single, cashout: -1 }, id, NOW).problems[0].startsWith("A cash-out must be"));
});

test("a parlay shares one id and price; a contradictory ticket is refused", () => {
  const legs = [
    { event_id: "g1", league: "nfl", market: "moneyline", side: "home" },
    { event_id: "g1", league: "nfl", market: "prop", side: "over", line: 0.5, prop_player: "Jahmyr Gibbs", prop_stat: "anytime_td" },
    { event_id: "g2", league: "nfl", market: "total", side: "over", line: 44.5, price: -110 },
  ];
  const { problems, rows } = parseParlay({ legs, stake: 25, parlay_price: 195, book: "BetRivers" }, id, NOW);
  assert.deepEqual(problems, []);
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.parlay_id)).size, 1);
  assert.ok(rows.every((r) => r.parlay_price === 195 && r.stake === 25));
  assert.equal(rows[0].price, null);
  assert.equal(rows[2].price, -110);
  const both = parseParlay({ legs: [legs[0], { ...legs[0], side: "away" }], stake: 5, parlay_price: 300 }, id, NOW);
  assert.equal(both.rows.length, 0);
  assert.ok(both.problems.length > 0);
});
