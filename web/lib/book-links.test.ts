import assert from "node:assert/strict";
import { test } from "node:test";

import { bookLink, knownBook } from "./book-links.ts";

test("the books you actually hold accounts at all resolve", () => {
  for (const book of ["FanDuel", "BetMGM", "BetRivers"]) {
    assert.ok(bookLink(book), `${book} should have a link`);
    assert.ok(knownBook(book));
  }
});

test("the feed's spelling variations still match", () => {
  // "BetMGM", "betmgm" and "BetMGM Sportsbook" have all appeared in the feed.
  const target = bookLink("BetMGM");
  for (const spelling of ["betmgm", "BetMGM Sportsbook", "Bet MGM", "BETMGM"]) {
    assert.equal(bookLink(spelling), target, spelling);
  }
});

test("a longer book name is not swallowed by a shorter one", () => {
  // "BetOnline.ag" contains no shorter key, but the matcher is substring-based in both
  // directions, so the ordering has to be deliberate rather than incidental.
  assert.notEqual(bookLink("BetOnline.ag"), bookLink("BetUS"));
  assert.notEqual(bookLink("BetRivers"), bookLink("BetUS"));
});

test("an unknown book gets no link rather than a guessed one", () => {
  // A link that silently fails is worse than none: you find out while standing in front
  // of the bet you meant to place.
  assert.equal(bookLink("Some New Book"), null);
  assert.equal(bookLink(""), null);
  assert.equal(bookLink(null), null);
  assert.equal(bookLink(undefined), null);
  assert.equal(knownBook("Some New Book"), false);
});

test("every link is a plain https URL", () => {
  // Universal Links and App Links only hand off from https. A custom scheme would be
  // the thing that looks like it works and does not.
  for (const book of ["FanDuel", "BetMGM", "BetRivers", "DraftKings", "Caesars"]) {
    const url = bookLink(book)!;
    assert.ok(url.startsWith("https://"), `${book}: ${url}`);
  }
});
