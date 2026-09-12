import assert from "node:assert/strict";
import { test } from "node:test";

import { BREAK_EVEN, judge, projectDate, roiAt, verdictLine } from "./verdict.ts";

test("break-even is where the return is exactly zero", () => {
  assert.ok(Math.abs(roiAt(BREAK_EVEN)) < 1e-12);
  assert.ok(roiAt(0.5) < 0, "a coin flip must lose money");
});

test("the live numbers are undecided, which is the point", () => {
  // 62 of 101 is 61.4% and looks strong. The interval still contains break-even, so
  // the honest answer is "not yet" rather than a percentage presented as a finding.
  const j = judge(62, 101);
  assert.equal(j.state, "undecided");
  assert.ok(j.lo < BREAK_EVEN && j.hi > BREAK_EVEN, `${j.lo}-${j.hi}`);
  assert.ok(j.moreNeeded! > 0);
});

test("the same rate on a big sample does clear", () => {
  // Nothing about 61.4% changes except how much of it there is.
  const j = judge(614, 1000);
  assert.equal(j.state, "clears");
  assert.ok(j.lo > BREAK_EVEN);
  assert.equal(j.moreNeeded, 0);
});

test("a clearly losing rate is called failed, not left open forever", () => {
  // A page that only ever says "undecided" cannot deliver bad news, which was the
  // whole purpose of the Track Record.
  const j = judge(380, 1000); // 38% -- the line-value figure
  assert.equal(j.state, "fails");
  assert.ok(j.hi < BREAK_EVEN);
  assert.ok(j.roi! < 0);
});

test("a rate sitting exactly on break-even can never be separated", () => {
  // No sample size distinguishes break-even from break-even. Null rather than a very
  // large number, which would read as "keep going and it will resolve".
  const j = judge(Math.round(1000 * BREAK_EVEN), 1000);
  assert.ok(j.needed === null || j.needed > 100000);
});

test("the closer to break-even, the more games it takes", () => {
  // And this is the finding when it happens: an edge too small to prove inside a
  // season is an edge too small to act on.
  const near = judge(530, 1000); // 53.0%
  const far = judge(650, 1000); // 65.0%
  assert.ok(near.needed! > far.needed!, `${near.needed} vs ${far.needed}`);
});

test("no data gives no verdict rather than a default one", () => {
  const j = judge(0, 0);
  assert.equal(j.state, "no-data");
  assert.equal(j.rate, null);
});

// --- projecting a date ----------------------------------------------------------------

test("a date is projected from the rate games are actually settling", () => {
  const from = new Date("2026-09-12T12:00:00Z");
  const when = projectDate(400, 200, from)!; // two weeks' worth
  assert.ok(when > from);
  assert.ok((when.getTime() - from.getTime()) / 86400000 <= 15);
});

test("nothing arriving gives no date rather than one computed from zero", () => {
  assert.equal(projectDate(400, 0), null);
  assert.equal(projectDate(400, -5), null);
});

test("a verdict more than a season away is reported as no date at all", () => {
  // "March 2028" is not a useful answer; "not this season" is.
  assert.equal(projectDate(100000, 50), null);
});

test("nothing more needed means no date", () => {
  assert.equal(projectDate(0, 200), null);
  assert.equal(projectDate(null, 200), null);
});

test("each state reads as a sentence, not a statistic", () => {
  assert.match(verdictLine(judge(62, 101), "Cover"), /undecided/);
  assert.match(verdictLine(judge(614, 1000), "Cover"), /clears the vig/);
  assert.match(verdictLine(judge(380, 1000), "Line value"), /does not clear/);
  assert.match(verdictLine(judge(0, 0), "Cover"), /No Cover settled yet/);
});
