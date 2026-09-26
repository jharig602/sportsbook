/**
 * Kickoff push tests.
 *
 * The failures worth guarding against are a buzz that is wrong: one per bet instead of
 * one per game, a dead parlay's leg, a game already over, a kickoff announced an hour
 * late, a 1 AM buzz -- and a watcher that sleeps through the next kickoff because `next`
 * was wrong.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  KICKOFF_HORIZON_HOURS,
  KICKOFF_LATE_MINUTES,
  kickoffsToAnnounce,
} from "./kickoff-push.ts";
import type { Bet, Score } from "./settle.ts";

const KICKOFF = "2026-09-26T16:45:00Z"; // 11:45 AM Central, 12:45 PM Eastern
const at = (minutesFromKickoff: number) => new Date(Date.parse(KICKOFF) + minutesFromKickoff * 60_000);

function bet(over: Partial<Bet> = {}): Bet {
  return {
    bet_id: "b1",
    placed_at: "2026-09-26T13:10:00Z",
    league: "ncaaf",
    event_id: "USA-UK",
    home_team: "Kentucky Wildcats",
    away_team: "South Alabama Jaguars",
    commence_time: KICKOFF,
    market: "total",
    side: "under",
    line: 54.5,
    price: -110,
    stake: 10,
    book: "FanDuel",
    model_probability: null,
    market_probability: null,
    rule_version_id: null,
    note: null,
    supersedes: null,
    ...over,
  } as Bet;
}

const none = new Map<string, Score>();

test("a game you have a bet on is announced as it kicks off", () => {
  const { messages } = kickoffsToAnnounce([bet()], none, at(0), new Set());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].title, "Kicking off: South Alabama Jaguars @ Kentucky Wildcats");
  assert.equal(messages[0].body, "Your bet: Under 54.5 -110 at FanDuel");
});

test("several bets on one game are one push that lists them all", () => {
  const { messages } = kickoffsToAnnounce(
    [bet(), bet({ bet_id: "b2", market: "spread", side: "home", line: -17.5, price: -105, book: "BetMGM" })],
    none, at(0), new Set(),
  );
  assert.equal(messages.length, 1);
  assert.match(messages[0].body, /^Your 2 bets: Under 54\.5 -110 at FanDuel · Kentucky Wildcats -17\.5 -105 at BetMGM$/);
});

test("a push is never sent twice for the same game", () => {
  assert.deepEqual(kickoffsToAnnounce([bet()], none, at(1), new Set(["kick:USA-UK"])).messages, []);
});

test("a late call says how long ago it started, and a much later one sends nothing", () => {
  assert.equal(kickoffsToAnnounce([bet()], none, at(9), new Set()).messages[0].title,
    "Started 9 min ago: South Alabama Jaguars @ Kentucky Wildcats");
  assert.deepEqual(kickoffsToAnnounce([bet()], none, at(KICKOFF_LATE_MINUTES + 1), new Set()).messages, []);
});

test("before kickoff it sends nothing and says when to come back", () => {
  const plan = kickoffsToAnnounce([bet()], none, at(-60), new Set());
  assert.deepEqual(plan.messages, []);
  // An hour out, minus the two-minute lead.
  assert.equal(plan.next, 58 * 60);
});

test("the next kickoff is the soonest one still to announce", () => {
  const later = bet({ bet_id: "b3", event_id: "LATER", commence_time: at(120).toISOString() });
  const plan = kickoffsToAnnounce([bet(), later], none, at(0), new Set());
  assert.equal(plan.messages.length, 1);
  assert.equal(plan.next, 118 * 60, "the game kicking off now is sent, not waited for");
});

test("a kickoff beyond the horizon is left for a later watcher", () => {
  const far = at(-(KICKOFF_HORIZON_HOURS * 60 + 10));
  assert.equal(kickoffsToAnnounce([bet()], none, far, new Set()).next, null);
});

test("a game already over, a voided bet and a cashed-out one are not announced", () => {
  const over = new Map<string, Score>([["USA-UK", { home_score: 31, away_score: 17 }]]);
  assert.deepEqual(kickoffsToAnnounce([bet()], over, at(0), new Set()).messages, []);
  const voided = [bet(), bet({ bet_id: "v", supersedes: "b1", voided: true } as Partial<Bet>)];
  assert.deepEqual(kickoffsToAnnounce(voided, none, at(0), new Set()).messages, []);
  assert.deepEqual(kickoffsToAnnounce([bet({ cashout: 12 } as Partial<Bet>)], none, at(0), new Set()).messages, []);
});

test("a parlay leg's game is announced, until the parlay is already lost", () => {
  const legs = [
    bet({ bet_id: "l1", event_id: "EARLY", commence_time: at(-240).toISOString(), market: "moneyline", side: "home", price: -150, parlay_id: "P", parlay_price: 260 } as Partial<Bet>),
    bet({ bet_id: "l2", parlay_id: "P", parlay_price: 260 } as Partial<Bet>),
  ];
  const live = kickoffsToAnnounce(legs, none, at(0), new Set());
  assert.equal(live.messages.length, 1);
  assert.equal(live.messages[0].body, "Your bet: Under 54.5 (parlay leg)");

  const firstLegLost = new Map<string, Score>([["EARLY", { home_score: 10, away_score: 24 }]]);
  assert.deepEqual(kickoffsToAnnounce(legs, firstLegLost, at(0), new Set()).messages, []);
});

test("overnight kickoffs are skipped, not saved for the morning", () => {
  const late = bet({ commence_time: "2026-09-27T06:00:00Z" }); // 1 AM Central
  assert.deepEqual(kickoffsToAnnounce([late], none, new Date("2026-09-27T06:00:30Z"), new Set()).messages, []);
});
