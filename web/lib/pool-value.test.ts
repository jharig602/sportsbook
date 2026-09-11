import assert from "node:assert/strict";
import { test } from "node:test";

import { contrarianCall, poolValues, type Popularity } from "./pool-value.ts";
import type { Candidate } from "./survivor.ts";

function c(team: string, winProbability: number): Candidate {
  return {
    team, opponent: "Someone", home: true, winProbability,
    spread: -7, commenceTime: "2026-09-13T17:00:00Z", eventId: "e1",
  };
}

/** The real week-1 board, from survivorgrid. */
const WEEK1 = [c("LAC", 0.80), c("JAX", 0.772), c("DET", 0.727), c("PHI", 0.683)];
const POP: Popularity = { LAC: 0.276, JAX: 0.234, DET: 0.133, PHI: 0.033 };

test("with no popularity data the ranking is just win probability", () => {
  // The right degenerate behaviour: knowing nothing about the field is no reason to
  // prefer an unpopular team.
  const ranked = poolValues(WEEK1, {}, 137);
  assert.deepEqual(ranked.map((r) => r.candidate.team), ["LAC", "JAX", "DET", "PHI"]);
  assert.ok(ranked.every((r) => r.share === null));
});

test("a popular pick drags its own backers through with you", () => {
  const ranked = poolValues(WEEK1, POP, 137);
  const lac = ranked.find((r) => r.candidate.team === "LAC")!;
  const phi = ranked.find((r) => r.candidate.team === "PHI")!;
  assert.ok(lac.coSurvivors > phi.coSurvivors,
    "27.6% of the field advances with the Chargers; 3.3% with the Eagles");
});

test("THE REAL ANSWER: week 1 chalk wins at every pool size", () => {
  // I had argued a 137-entrant pool should differentiate. With the actual numbers it
  // should not, and not marginally: contrarian trims the field 6% and your survival
  // 15%. Kept as a test so the claim cannot quietly drift back.
  for (const size of [13, 50, 137, 1000, 100000]) {
    const ranked = poolValues(WEEK1, POP, size);
    assert.equal(ranked[0].candidate.team, "LAC", `chalk lost at pool size ${size}`);
  }
});

test("differentiating wins when the chalk is genuinely crowded", () => {
  // The case the data does not show this week but will later: one team on most of the
  // field's tickets, and a near-as-good alternative nobody took.
  const crowded = [c("Chalk", 0.78), c("Quiet", 0.74)];
  const heavy: Popularity = { Chalk: 0.75, Quiet: 0.02 };
  const ranked = poolValues(crowded, heavy, 137);
  assert.equal(ranked[0].candidate.team, "Quiet",
    "4 points of survival is cheap against 75% of the field");
});

test("the contrarian call reports agreement, and what it would cost", () => {
  const agree = contrarianCall(poolValues(WEEK1, POP, 137));
  assert.equal(agree.disagree, false);
  assert.equal(agree.best!.candidate.team, "LAC");
  assert.equal(agree.survivalGivenUp, 0);

  const crowded = contrarianCall(
    poolValues([c("Chalk", 0.78), c("Quiet", 0.74)], { Chalk: 0.75, Quiet: 0.02 }, 137),
  );
  assert.equal(crowded.disagree, true);
  assert.equal(crowded.safest!.candidate.team, "Chalk");
  assert.ok(Math.abs(crowded.survivalGivenUp - 0.04) < 1e-9);
});

test("pool size scales the value but does not reorder it here", () => {
  const small = poolValues(WEEK1, POP, 13);
  const big = poolValues(WEEK1, POP, 137);
  assert.deepEqual(small.map((r) => r.candidate.team), big.map((r) => r.candidate.team));
  assert.ok(small[0].value > big[0].value, "the same pick wins a small pool more often");
});

test("a solo pool has no rivals to survive alongside", () => {
  const ranked = poolValues(WEEK1, POP, 1);
  assert.equal(ranked[0].coSurvivors, 0);
  assert.equal(ranked[0].value, 0.80);
});

test("a team absent from the popularity table is treated as unpicked, not unknown", () => {
  // Absent from a table that covers the league means nobody took it -- which is
  // information, and favourable.
  const ranked = poolValues([...WEEK1, c("Nobody", 0.70)], POP, 137);
  const nobody = ranked.find((r) => r.candidate.team === "Nobody")!;
  assert.equal(nobody.share, 0);
});

test("an empty week is not an error", () => {
  assert.deepEqual(poolValues([], POP, 137), []);
  assert.equal(contrarianCall([]).disagree, false);
});
