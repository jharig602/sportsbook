import assert from "node:assert/strict";
import { test } from "node:test";

import { betHref, parseBetPrefill, searchGames } from "./bet-link.ts";

/** Turn an href back into the params object Next hands a page. */
function paramsOf(href: string): Record<string, string> {
  const query = href.split("?")[1].split("#")[0];
  return Object.fromEntries(new URLSearchParams(query));
}

test("a link round-trips into the same prefill", () => {
  const prefill = {
    eventId: "401856782", market: "spread" as const, side: "away" as const,
    line: 8.5, price: -108, book: "BetMGM", stake: 10,
  };
  assert.deepEqual(parseBetPrefill(paramsOf(betHref(prefill))), prefill);
});

test("the promotion's bonus bet keeps its stake, its book, and that it is a bonus", () => {
  // Each of these being lost silently changes the ledger: the wrong stake or book fails
  // to count as a qualifying day, and a bonus logged as cash books a loss it never cost.
  const href = betHref({
    eventId: "E9", market: "moneyline", side: "home", price: 920, book: "FanDuel", stake: 50, bonus: true,
  });
  const back = parseBetPrefill(paramsOf(href))!;
  assert.equal(back.stake, 50);
  assert.equal(back.book, "FanDuel");
  assert.equal(back.bonus, true);
});

test("a link lands on the form, not the top of the ledger", () => {
  assert.ok(betHref({ eventId: "E1" }).endsWith("#log"));
});

test("a moneyline never carries a line, in either direction", () => {
  assert.ok(!betHref({ eventId: "E1", market: "moneyline", line: 3 }).includes("line="));
  assert.equal(parseBetPrefill({ event: "E1", market: "moneyline", line: "3" })!.line, undefined);
});

test("a side that does not belong to the market is dropped, not kept", () => {
  // "over" on a spread would settle against the wrong question entirely.
  assert.equal(parseBetPrefill({ event: "E1", market: "spread", side: "over" })!.side, undefined);
  assert.equal(parseBetPrefill({ event: "E1", market: "total", side: "home" })!.side, undefined);
  // And a side with no market has nothing to belong to.
  assert.equal(parseBetPrefill({ event: "E1", side: "home" })!.side, undefined);
});

test("one bad field does not throw away the good ones", () => {
  const back = parseBetPrefill({ event: "E1", market: "spread", side: "home", price: "12", stake: "-5" })!;
  assert.equal(back.market, "spread");
  assert.equal(back.side, "home");
  assert.equal(back.price, undefined, "American odds are at least 100 in magnitude");
  assert.equal(back.stake, undefined);
});

test("no event, or a malformed one, is no prefill at all", () => {
  assert.equal(parseBetPrefill({}), null);
  assert.equal(parseBetPrefill({ event: "" }), null);
  assert.equal(parseBetPrefill({ event: "<script>" }), null);
  assert.equal(parseBetPrefill({ event: "x".repeat(65) }), null);
});

test("repeated query params take the first value", () => {
  assert.equal(parseBetPrefill({ event: ["E1", "E2"] })!.eventId, "E1");
});

const board = [
  { homeTeam: "Jacksonville Jaguars", awayTeam: "Cleveland Browns" },
  { homeTeam: "Central Michigan Chippewas", awayTeam: "Colgate Raiders" },
  { homeTeam: "Hawai'i Rainbow Warriors", awayTeam: "Stanford Cardinal" },
];

test("search matches any word order, across both teams", () => {
  assert.deepEqual(searchGames(board, "browns"), [board[0]]);
  assert.deepEqual(searchGames(board, "jax"), [], "abbreviations are not names");
  assert.deepEqual(searchGames(board, "jaguars cleveland"), [board[0]]);
  assert.deepEqual(searchGames(board, "COLGATE"), [board[1]]);
});

test("search ignores punctuation nobody types on a phone", () => {
  assert.deepEqual(searchGames(board, "hawaii"), [board[2]]);
});

test("every word must match, so adding words narrows rather than widens", () => {
  assert.deepEqual(searchGames(board, "cardinal browns"), []);
});

test("an empty query lists everything, in the order given", () => {
  assert.deepEqual(searchGames(board, "   "), board);
});
