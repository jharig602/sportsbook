import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardEdge } from "./board-shop.ts";
import {
  MIN_ALERT_EDGE_POINTS,
  RENOTIFY_IMPROVEMENT,
  offerKey,
  selectAlerts,
  shopNotification,
  notificationRecord,
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
    edgePoints: 2.8,
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
  assert.equal(picked[0].previousEdge, null);
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
  assert.deepEqual(selectAlerts([edge({ edgePoints: 0.4, expectedRoi: 0.004 })], MINE, []), []);
  assert.equal(
    selectAlerts([edge({ edgePoints: MIN_ALERT_EDGE_POINTS })], MINE, []).length,
    1,
  );
});

test("THE BUG: a longshot with a huge return but a tiny real edge is refused", () => {
  // Every alert the first version sent looked like this. A +390 dog needs only 0.4
  // points of probability to show +2% return, so a flat EV bar fires on it constantly
  // -- 76% of the time in a simulated market with no edge in it at all. Measured where
  // the noise lives, it is nothing.
  const longshot = edge({
    market: "moneyline", line: null, price: 390, advantagePoints: null,
    edgePoints: 0.5, expectedRoi: 0.043,
  });
  assert.deepEqual(selectAlerts([longshot], MINE, []), []);
});

test("a longshot with a genuinely large edge still alerts", () => {
  // The rule must not simply silence moneylines; it must price them on the same scale
  // as everything else.
  const real = edge({
    market: "moneyline", line: null, price: 390, advantagePoints: null,
    edgePoints: 3.2, expectedRoi: 0.16,
  });
  assert.equal(selectAlerts([real], MINE, []).length, 1);
});

test("a big spread edge outranks a flashier longshot return", () => {
  // Ranking by EV would put every longshot above every spread, whatever the threshold.
  const picked = selectAlerts(
    [
      edge({ book: "FanDuel", market: "moneyline", line: null, price: 390,
             edgePoints: 1.8, expectedRoi: 0.09 }),
      edge({ book: "BetMGM", edgePoints: 3.2, expectedRoi: 0.06 }),
    ],
    MINE,
    [],
  );
  assert.deepEqual(picked.map((d) => d.row.book), ["BetMGM", "FanDuel"]);
});

test("an edge the vig still eats never alerts", () => {
  // Both conditions must hold: real on the probability scale AND worth staking.
  assert.deepEqual(selectAlerts([edge({ expectedRoi: -0.045 })], MINE, []), []);
  assert.deepEqual(selectAlerts([edge({ expectedRoi: null })], MINE, []), []);
  assert.deepEqual(selectAlerts([edge({ edgePoints: null })], MINE, []), []);
});

test("a thin reference never earns an interruption", () => {
  // Scanning a whole board for the largest number selects precisely these.
  assert.deepEqual(selectAlerts([edge({ thinConsensus: true })], MINE, []), []);
});

test("a stale quote never alerts", () => {
  assert.deepEqual(selectAlerts([edge({ stale: true })], MINE, []), []);
});

test("the same offer does not buzz twice", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 2.8 }];
  assert.deepEqual(selectAlerts([edge()], MINE, sent), []);
});

test("a wiggle in price is not a new opportunity", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 2.8 }];
  assert.deepEqual(selectAlerts([edge({ edgePoints: 3.1, price: -108 })], MINE, sent), []);
});

test("a materially better version of the same offer does buzz again", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 2.8 }];
  const better = edge({ edgePoints: 2.8 + RENOTIFY_IMPROVEMENT });
  const picked = selectAlerts([better], MINE, sent);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].previousEdge, 2.8);
});

test("the same game at a different book is a different offer", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 2.8 }];
  assert.equal(selectAlerts([edge({ book: "FanDuel" })], MINE, sent).length, 1);
});

test("the other side of the same game is a different offer", () => {
  const sent = [{ offer_key: offerKey(edge()), last_roi: 2.8 }];
  assert.equal(selectAlerts([edge({ side: "away" })], MINE, sent).length, 1);
});

test("the price is deliberately not part of the offer's identity", () => {
  assert.equal(offerKey(edge()), offerKey(edge({ price: -105, line: 2 })));
});

test("alerts come back best first", () => {
  const picked = selectAlerts(
    [
      edge({ book: "FanDuel", edgePoints: 1.7 }),
      edge({ book: "BetMGM", edgePoints: 4.1 }),
      edge({ book: "BetRivers", edgePoints: 2.6 }),
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
  const sent = [{ offer_key: offerKey(edge()), last_roi: 1.2 }];
  const [decision] = selectAlerts([edge()], MINE, sent);
  const push = shopNotification(decision);
  assert.equal(push.tag, `shop-401|BetMGM|spread|home`);
  assert.equal(push.renotify, true, "a better offer should re-alert on the same card");
});

test("a total reads as over/under rather than a signed number", () => {
  const [decision] = selectAlerts(
    [edge({ market: "total", side: "under", line: 55, advantagePoints: 1, edgePoints: 2.6 })],
    MINE,
    [],
  );
  assert.match(shopNotification(decision).body, /u55/);
});

test("a moneyline carries no line", () => {
  const [decision] = selectAlerts(
    [edge({ market: "moneyline", line: null, price: 275, advantagePoints: null, edgePoints: 2.2 })],
    MINE,
    [],
  );
  const push = shopNotification(decision);
  assert.match(push.body, /\+275/);
  assert.ok(!push.body.includes("null"));
});

// --- what gets stored must be what gets compared ---------------------------------

test("an alert, once recorded, is not sent again on the next run", () => {
  // The bug this pins: the dispatcher stored the expected RETURN (~0.04) while the
  // repeat check compared the EDGE in points (~1.6), so every alert re-sent every run.
  // Feeding the recorded value straight back in is the only honest test of that.
  const row = edge({ edgePoints: 2.1 });
  const [first] = selectAlerts([row], MINE, []);
  assert.ok(first, "the first run should alert");
  const stored = notificationRecord(first);
  const again = selectAlerts([row], MINE, [
    { offer_key: stored.offer_key, last_roi: stored.edge },
  ]);
  assert.deepEqual(again, [], "the same offer must not buzz twice");
});

test("a recorded alert still re-sends when the edge genuinely improves", () => {
  const row = edge({ edgePoints: 2.1 });
  const [first] = selectAlerts([row], MINE, []);
  const stored = notificationRecord(first);
  const better = edge({ edgePoints: 2.1 + RENOTIFY_IMPROVEMENT });
  const again = selectAlerts([better], MINE, [
    { offer_key: stored.offer_key, last_roi: stored.edge },
  ]);
  assert.equal(again.length, 1);
});

test("what is recorded is the edge in points, not the return", () => {
  const row = edge({ edgePoints: 2.1, expectedRoi: 0.04 });
  const [first] = selectAlerts([row], MINE, []);
  assert.equal(notificationRecord(first).edge, 2.1);
});
