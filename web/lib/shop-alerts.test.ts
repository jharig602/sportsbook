import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardEdge } from "./board-shop.ts";
import {
  MIN_ALERT_ROI,
  RENOTIFY_IMPROVEMENT,
  offerKey,
  selectAlerts,
  shopNotification,
} from "./shop-alerts.ts";

function edge(over: Partial<BoardEdge> = {}): BoardEdge {
  return {
    book: "BetMGM",
    market: "spread",
    side: "home",
    line: 1,
    price: -110,
    consensusLine: -1,
    consensusProbability: 0.5,
    advantagePoints: 2,
    fairProbability: 0.552,
    breakEven: 0.524,
    expectedRoi: 0.053,
    booksCompared: 8,
    thinConsensus: false,
    stale: false,
    note: "",
    eventId: "401",
    league: "ncaaf",
    homeTeam: "Minnesota Golden Gophers",
    awayTeam: "Mississippi State Bulldogs",
    commenceTime: "2026-09-12T23:30:00Z",
    homeTeamId: "135",
    awayTeamId: "344",
    ...over,
  } as BoardEdge;
}

const MINE = ["BetMGM", "FanDuel", "BetRivers"];

test("a strong row at one of your books alerts", () => {
  const picked = selectAlerts([edge()], MINE, []);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].previousRoi, null);
});

test("a row at a book you cannot reach never alerts", () => {
  // Alerting on a price you cannot get is worse than silence: it teaches you to
  // ignore the channel, and then the one that matters goes unread too.
  assert.deepEqual(selectAlerts([edge({ book: "Bovada" })], MINE, []), []);
});

test("nothing is sent until books have been chosen", () => {
  assert.deepEqual(selectAlerts([edge()], [], []), []);
});

test("a row that merely clears the vig is not worth an interruption", () => {
  // +0.4% is arithmetically positive and inside the error of the consensus it is
  // measured against. The page still shows it.
  assert.deepEqual(selectAlerts([edge({ expectedRoi: 0.004 })], MINE, []), []);
  assert.equal(selectAlerts([edge({ expectedRoi: MIN_ALERT_ROI })], MINE, []).length, 1);
});

test("a negative row never alerts", () => {
  assert.deepEqual(selectAlerts([edge({ expectedRoi: -0.045 })], MINE, []), []);
  assert.deepEqual(selectAlerts([edge({ expectedRoi: null })], MINE, []), []);
});

test("a thin reference never earns an interruption", () => {
  // Scanning a whole board for the largest number selects precisely these.
  assert.deepEqual(selectAlerts([edge({ thinConsensus: true })], MINE, []), []);
});

test("a stale quote never alerts", () => {
  assert.deepEqual(selectAlerts([edge({ stale: true })], MINE, []), []);
});

test("the same offer does not buzz twice", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 0.053 }];
  assert.deepEqual(selectAlerts([edge()], MINE, sent), []);
});

test("a wiggle in price is not a new opportunity", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 0.053 }];
  assert.deepEqual(selectAlerts([edge({ expectedRoi: 0.058, price: -108 })], MINE, sent), []);
});

test("a materially better version of the same offer does buzz again", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 0.053 }];
  const better = edge({ expectedRoi: 0.053 + RENOTIFY_IMPROVEMENT });
  const picked = selectAlerts([better], MINE, sent);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].previousRoi, 0.053);
});

test("the same game at a different book is a different offer", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 0.053 }];
  assert.equal(selectAlerts([edge({ book: "FanDuel" })], MINE, sent).length, 1);
});

test("the other side of the same game is a different offer", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 0.053 }];
  assert.equal(selectAlerts([edge({ side: "away" })], MINE, sent).length, 1);
});

test("the price is deliberately not part of the offer's identity", () => {
  assert.equal(offerKey(edge()), offerKey(edge({ price: -105, line: 2 })));
});

test("alerts come back best first", () => {
  const picked = selectAlerts(
    [
      edge({ book: "FanDuel", expectedRoi: 0.031 }),
      edge({ book: "BetMGM", expectedRoi: 0.066 }),
      edge({ book: "BetRivers", expectedRoi: 0.045 }),
    ],
    MINE,
    [],
  );
  assert.deepEqual(picked.map((p) => p.row.book), ["BetMGM", "BetRivers", "FanDuel"]);
});

test("the notification says what to bet, where, and at what number", () => {
  const [decision] = selectAlerts([edge()], MINE, []);
  const push = shopNotification(decision);
  assert.match(push.title, /\+5\.3% BetMGM/);
  assert.match(push.body, /Minnesota Golden Gophers/);
  assert.match(push.body, /\+1 -110/);
  assert.match(push.body, /\+2\.0 pts vs 8 books/);
  assert.equal(push.url, "/game/401");
  assert.equal(push.renotify, false);
});

test("a repeat notification replaces the earlier card rather than stacking", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 0.04 }];
  const [decision] = selectAlerts([edge()], MINE, sent);
  const push = shopNotification(decision);
  assert.equal(push.tag, `shop-401|BetMGM|spread|home`);
  assert.equal(push.renotify, true, "a better offer should re-alert on the same card");
});

test("a total reads as over/under rather than a signed number", () => {
  const [decision] = selectAlerts(
    [edge({ market: "total", side: "under", line: 55, advantagePoints: 1 })],
    MINE,
    [],
  );
  assert.match(shopNotification(decision).body, /u55/);
});

test("a moneyline carries no line", () => {
  const [decision] = selectAlerts(
    [edge({ market: "moneyline", line: null, price: 275, advantagePoints: null })],
    MINE,
    [],
  );
  const push = shopNotification(decision);
  assert.match(push.body, /\+275/);
  assert.ok(!push.body.includes("null"));
});
