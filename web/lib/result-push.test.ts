/**
 * Win/loss push tests.
 *
 * The failures worth guarding against are the ones that would buzz a phone wrongly: the
 * whole season at once on the first run, a bet you voided, a result you already heard,
 * or a guest's bet on the owner's phone (handled by the route reading HOUSE only).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RESULT_WINDOW_HOURS,
  legLabel,
  money,
  quietHours,
  resultsToAnnounce,
  summarise,
} from "./result-push.ts";
import type { Bet, Score } from "./settle.ts";

const NOW = new Date("2026-09-26T23:30:00Z"); // Saturday evening Central
const KICKOFF = "2026-09-26T19:00:00Z"; // that afternoon

function bet(over: Partial<Bet> = {}): Bet {
  return {
    bet_id: "b1",
    placed_at: "2026-09-24T23:09:00Z",
    league: "ncaaf",
    event_id: "NIU-GSU",
    home_team: "Georgia State Panthers",
    away_team: "Northern Illinois Huskies",
    commence_time: KICKOFF,
    market: "moneyline",
    side: "away",
    line: null,
    price: 425,
    stake: 25,
    book: "BetRivers",
    model_probability: null,
    market_probability: null,
    rule_version_id: null,
    note: null,
    supersedes: null,
    ...over,
  } as Bet;
}

const niuWins = new Map<string, Score>([["NIU-GSU", { home_score: 21, away_score: 24 }]]);
const niuLoses = new Map<string, Score>([["NIU-GSU", { home_score: 31, away_score: 17 }]]);

test("a winning bet is announced with what it paid and the final score", () => {
  const [message] = resultsToAnnounce([bet()], niuWins, NOW, new Set());
  assert.equal(message.outcome, "won");
  assert.equal(message.title, "Won +$106.25"); // $25 at +425
  assert.match(message.body, /Northern Illinois Huskies ML \+425 at BetRivers/);
  assert.match(message.body, /Final: Northern Illinois Huskies 24, Georgia State Panthers 21/);
});

test("a losing bet says what it cost", () => {
  const [message] = resultsToAnnounce([bet()], niuLoses, NOW, new Set());
  assert.equal(message.title, "Lost −$25.00");
});

test("a losing bonus bet says it cost nothing, because it did not", () => {
  const [message] = resultsToAnnounce([bet({ bonus: true } as Partial<Bet>)], niuLoses, NOW, new Set());
  assert.equal(message.title, "Lost — bonus bet, cost nothing");
});

test("a push says the stake came back", () => {
  const spread = bet({ market: "spread", side: "away", line: 3, price: -110 });
  const scores = new Map<string, Score>([["NIU-GSU", { home_score: 24, away_score: 21 }]]);
  const [message] = resultsToAnnounce([spread], scores, NOW, new Set());
  assert.equal(message.outcome, "push");
});

test("a result already announced is never announced again", () => {
  const [first] = resultsToAnnounce([bet()], niuWins, NOW, new Set());
  assert.deepEqual(resultsToAnnounce([bet()], niuWins, NOW, new Set([first.key])), []);
});

test("old results are not announced, so the first run cannot push the whole season", () => {
  const august = bet({ commence_time: "2026-08-30T19:00:00Z" });
  assert.deepEqual(resultsToAnnounce([august], niuWins, NOW, new Set()), []);
  const edge = new Date(Date.parse(KICKOFF) + (RESULT_WINDOW_HOURS + 1) * 3_600_000);
  assert.deepEqual(resultsToAnnounce([bet()], niuWins, edge, new Set()), []);
});

test("a game with no final score yet announces nothing", () => {
  assert.deepEqual(resultsToAnnounce([bet()], new Map(), NOW, new Set()), []);
});

test("a bet with no kickoff time is skipped rather than guessed at", () => {
  assert.deepEqual(resultsToAnnounce([bet({ commence_time: null })], niuWins, NOW, new Set()), []);
});

test("a cashed-out ticket is not announced: you ended it yourself", () => {
  const cashed = bet({ cashout: 60 } as Partial<Bet>);
  assert.deepEqual(resultsToAnnounce([cashed], niuWins, NOW, new Set()), []);
});

test("a voided bet is never announced, and a corrected one only in its corrected form", () => {
  const original = bet({ bet_id: "b1", side: "home" });
  const correction = bet({ bet_id: "b2", supersedes: "b1", side: "away" });
  const messages = resultsToAnnounce([original, correction], niuWins, NOW, new Set());
  assert.equal(messages.length, 1);
  assert.equal(messages[0].key.startsWith("bet:b2:"), true);

  const voided = bet({ bet_id: "b3", supersedes: "b1", voided: true } as Partial<Bet>);
  assert.deepEqual(resultsToAnnounce([original, voided], niuWins, NOW, new Set()), []);
});

test("a parlay is one ticket, and it is lost the moment one leg loses", () => {
  const legs = [
    bet({ bet_id: "l1", parlay_id: "P1", parlay_price: 260 } as Partial<Bet>),
    bet({
      bet_id: "l2",
      event_id: "LATER",
      home_team: "LSU Tigers",
      away_team: "Texas A&M Aggies",
      commence_time: "2026-09-27T00:30:00Z", // not played yet
      parlay_id: "P1",
      parlay_price: 260,
    } as Partial<Bet>),
  ];
  const messages = resultsToAnnounce(legs, niuLoses, NOW, new Set());
  assert.equal(messages.length, 1, "one message for the ticket, not one per leg");
  assert.equal(messages[0].outcome, "lost");
  assert.match(messages[0].title, /^Parlay lost/);
});

test("a parlay with a pushed leg asks for the book's new price instead of guessing it", () => {
  const legs = [
    bet({ bet_id: "l1", market: "spread", line: 3, price: -110, parlay_id: "P2", parlay_price: 260 } as Partial<Bet>),
    bet({ bet_id: "l2", event_id: "OTHER", parlay_id: "P2", parlay_price: 260 } as Partial<Bet>),
  ];
  const scores = new Map<string, Score>([
    ["NIU-GSU", { home_score: 24, away_score: 21 }], // +3 lands on the number
    ["OTHER", { home_score: 10, away_score: 20 }], // away wins
  ]);
  const [message] = resultsToAnnounce(legs, scores, NOW, new Set());
  assert.equal(message.outcome, "fix");
  assert.equal(message.title, "Parlay needs updating");
});

test("overnight results wait for morning rather than waking you", () => {
  assert.equal(quietHours(new Date("2026-09-27T08:00:00Z")), true); // 3 AM Central
  assert.equal(quietHours(new Date("2026-09-27T14:00:00Z")), false); // 9 AM Central
});

test("several results at once become one summary", () => {
  const messages = [
    ...resultsToAnnounce([bet({ bet_id: "a" })], niuWins, NOW, new Set()),
    ...resultsToAnnounce([bet({ bet_id: "b" })], niuLoses, NOW, new Set()),
  ];
  const summary = summarise(messages);
  assert.equal(summary.title, "1 won, 1 lost · +$81.25");
});

test("labels read the way a slip prints them", () => {
  assert.equal(legLabel(bet()), "Northern Illinois Huskies ML");
  assert.equal(legLabel(bet({ market: "spread", side: "home", line: -9.5 })), "Georgia State Panthers -9.5");
  assert.equal(legLabel(bet({ market: "total", side: "over", line: 56.5 })), "Over 56.5");
  assert.equal(money(-25), "−$25.00");
});
