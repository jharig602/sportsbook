import assert from "node:assert/strict";
import { test } from "node:test";

import type { BoardEdge } from "./board-shop.ts";
import {
  DEFAULT_MAX_SPREAD,
  isBlowout,
  NO_LIMIT,
  parseMaxSpread,
  withoutBlowouts,
} from "./blowout.ts";

const row = (gameSpread: number | null, over: Partial<BoardEdge> = {}): BoardEdge =>
  ({ eventId: "e", gameSpread, book: "BetMGM", market: "spread", side: "home", ...over }) as BoardEdge;

test("the cut is on the GAME, not on the bet's own line", () => {
  // A moneyline on a 56-point mismatch is exactly as thinly traded as the spread on it.
  // Judging the row by its own line would let every moneyline and total through.
  const moneyline = row(-56, { market: "moneyline", line: null });
  assert.equal(isBlowout(moneyline.gameSpread, 28), true);
  assert.equal(withoutBlowouts([moneyline], 28).kept.length, 0);
});

test("both directions count, since a huge underdog is the same game", () => {
  assert.equal(isBlowout(-56, 28), true);
  assert.equal(isBlowout(56, 28), true);
});

test("ordinary games are untouched", () => {
  const rows = [row(-3), row(7), row(-13.5), row(0)];
  const { kept, removed } = withoutBlowouts(rows, DEFAULT_MAX_SPREAD);
  assert.equal(kept.length, 4);
  assert.equal(removed, 0);
});

test("the filter reports what it removed rather than just shrinking", () => {
  // A list that silently gets shorter is how you conclude the board is thin when it is
  // merely filtered -- the same failure as a matching bug presenting as "books agree".
  const { kept, removed } = withoutBlowouts([row(-3), row(-30.5), row(-56)], 28);
  assert.equal(kept.length, 1);
  assert.equal(removed, 2);
});

test("a game with no spread is kept, not guessed at", () => {
  // Absent is not the same as huge. Dropping it would hide rows for no stated reason.
  assert.equal(isBlowout(null, 28), false);
  assert.equal(withoutBlowouts([row(null)], 28).kept.length, 1);
});

test("the boundary is inclusive, so the cut means what it says", () => {
  assert.equal(isBlowout(-28, 28), true);
  assert.equal(isBlowout(-27.5, 28), false);
});

test("no limit keeps everything, including what the default would hide", () => {
  const rows = [row(-3), row(-56)];
  const { kept, removed } = withoutBlowouts(rows, NO_LIMIT);
  assert.equal(kept.length, 2);
  assert.equal(removed, 0);
});

test("a bad setting falls back to the default rather than disabling the filter", () => {
  for (const bad of [null, undefined, "", "abc", "-5", "0"]) {
    assert.equal(parseMaxSpread(bad), DEFAULT_MAX_SPREAD, JSON.stringify(bad));
  }
  assert.equal(parseMaxSpread("35"), 35);
  assert.equal(parseMaxSpread("999"), 999);
});

test("the legs that prompted this are exactly what it removes", () => {
  // Indiana -56 and Houston -49.5 go; Mississippi State +1 stays. That was the whole
  // complaint: a parlay recommended on two games nobody has priced seriously.
  const indiana = row(-56);
  const houston = row(-49.5);
  const missState = row(1);
  const { kept } = withoutBlowouts([indiana, houston, missState], DEFAULT_MAX_SPREAD);
  assert.deepEqual(kept.map((r) => r.gameSpread), [1]);
});
