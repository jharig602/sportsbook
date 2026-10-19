import assert from "node:assert/strict";
import test from "node:test";

import {
  costToAmerican,
  effectiveAsk,
  KALSHI_CONFIG,
  kalshiFair,
  kalshiFlagsVisible,
  referenceRows,
  shadowProfit,
  visibleFlags,
  type KalshiGame,
  type KalshiSnapshot,
} from "./kalshi.ts";
import { quotesForGame } from "./book-lines.ts";
import { shopSide } from "./shop.ts";

const snap = (side: "home" | "away", bid: number, ask: number, size = 5000): KalshiSnapshot => ({
  eventId: "401",
  league: "nfl",
  side,
  marketTicker: `KXNFLGAME-26OCT18ARILAR-${side === "home" ? "LAR" : "ARI"}`,
  observedAt: "2026-10-18T15:00:00.000Z",
  yesBid: bid,
  yesAsk: ask,
  bidSize: size,
  askSize: size,
  lastPrice: ask,
  thin: false,
});
const RAMS: KalshiGame = { home: snap("home", 0.85, 0.86), away: snap("away", 0.14, 0.15) };

test("Michigan is blocked, so flags 2 and 3 stay hidden there", () => {
  assert.deepEqual(KALSHI_CONFIG.blockedStates, ["MI"]);
  assert.equal(kalshiFlagsVisible("MI"), false);
  assert.equal(kalshiFlagsVisible("mi"), false, "case does not matter");
  assert.equal(kalshiFlagsVisible("OH"), true);
});

test("an unknown state is treated as blocked", () => {
  assert.equal(kalshiFlagsVisible(null), false);
  assert.equal(kalshiFlagsVisible(""), false);
});

test("removing Michigan from the blocked list turns flags 2 and 3 on, with no code change", () => {
  const reopened = { ...KALSHI_CONFIG, blockedStates: [] };
  assert.equal(kalshiFlagsVisible("MI", reopened), true);
  const flags = [{ kind: "stale_book" as const }, { kind: "kalshi_value" as const }, { kind: "arb" as const }];
  assert.deepEqual(visibleFlags(flags, "MI").map((f) => f.kind), ["stale_book"], "blocked: stale-book only");
  assert.deepEqual(visibleFlags(flags, "MI", reopened).map((f) => f.kind), ["stale_book", "kalshi_value", "arb"]);
});

test("the fee-adjusted ask and its American price match the plan's example", () => {
  const cost = effectiveAsk(0.56)!;
  assert.ok(Math.abs(cost - (0.56 + 0.07 * 0.56 * 0.44)) < 1e-12);
  assert.equal(costToAmerican(cost), -137);
  assert.equal(costToAmerican(0.4), 150);
  assert.equal(costToAmerican(0.5), -100, "a fair coin never lands in the -99..99 gap");
  assert.equal(effectiveAsk(0), null);
});

test("fair chance averages the mirrored midpoints", () => {
  assert.ok(Math.abs(kalshiFair(RAMS)! - (0.855 + 0.855) / 2) < 1e-12);
});

test("a deep, tight market becomes reference rows; a thin one does not", () => {
  const rows = referenceRows(RAMS);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.reference === true && r.book === "Kalshi" && r.market === "moneyline"));
  const wide = { home: snap("home", 0.8, 0.84), away: snap("away", 0.16, 0.2) };
  assert.deepEqual(referenceRows(wide), []);
  const shallow = { home: snap("home", 0.85, 0.86, 50), away: snap("away", 0.14, 0.15, 50) };
  assert.deepEqual(referenceRows(shallow), []);
});

test("Kalshi counts in other books' consensus but is never a row to bet", () => {
  const now = new Date("2026-10-18T16:00:00.000Z");
  const stored = [
    { quote_id: "a", observed_at: "2026-10-18T15:00:00.000Z", league: "nfl", event_id: "401", book: "FanDuel", market: "moneyline" as const, side: "home" as const, line: null, price: -500, source: "oddsapi", note: null },
    { quote_id: "b", observed_at: "2026-10-18T15:00:00.000Z", league: "nfl", event_id: "401", book: "FanDuel", market: "moneyline" as const, side: "away" as const, line: null, price: 380, source: "oddsapi", note: null },
    ...referenceRows(RAMS),
  ];
  const quotes = quotesForGame(undefined, stored, "DraftKings", now).filter((q) => q.market === "moneyline" && q.side === "home");
  const rows = shopSide(quotes, null);
  assert.deepEqual(rows.map((r) => r.book), ["FanDuel"], "no Kalshi row");
  assert.equal(rows[0].booksCompared, 1, "but FanDuel is compared against Kalshi");
});

test("shadow profit: value pays $1 minus cost on a win, an arb is locked in", () => {
  assert.ok(Math.abs(shadowProfit({ kind: "kalshi_value", kalshiCost: 0.55, edgePoints: 3 }, true)! - 0.45) < 1e-12);
  assert.ok(Math.abs(shadowProfit({ kind: "kalshi_value", kalshiCost: 0.55, edgePoints: 3 }, false)! + 0.55) < 1e-12);
  assert.equal(shadowProfit({ kind: "kalshi_value", kalshiCost: 0.55, edgePoints: 3 }, null), null);
  assert.equal(shadowProfit({ kind: "arb", kalshiCost: 0.5, edgePoints: 4.8 }, false), 0.048);
});

test("Kalshi at bet time and at kickoff come from the snapshot history", async () => {
  const { fairAt } = await import("./kalshi.ts");
  const early = [{ ...snap("home", 0.6, 0.61), observedAt: "2026-10-17T12:00:00.000Z" }, { ...snap("away", 0.39, 0.4), observedAt: "2026-10-17T12:00:00.000Z" }];
  const late = [{ ...snap("home", 0.7, 0.71), observedAt: "2026-10-18T16:00:00.000Z" }, { ...snap("away", 0.29, 0.3), observedAt: "2026-10-18T16:00:00.000Z" }];
  const all = [...early, ...late];
  assert.ok(Math.abs(fairAt(all, "home", "2026-10-17T20:00:00.000Z")! - 0.605) < 1e-9, "bet time sees the early price");
  assert.ok(Math.abs(fairAt(all, "away", "2026-10-18T20:05:00.000Z")! - 0.295) < 1e-9, "kickoff sees the close");
  assert.equal(fairAt(all, "home", "2026-10-16T00:00:00.000Z"), null, "nothing before the first snapshot");
});
