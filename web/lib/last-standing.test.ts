import assert from "node:assert/strict";
import { test } from "node:test";

import { lastStandingWin, prepareField, shareAgainstExits } from "./last-standing.ts";
import { poolWin, type Field } from "./pool-win.ts";
import { survival } from "./pool-odds.ts";

/**
 * This is the one module in the project that samples, so the tests lean on identities
 * that must hold EXACTLY regardless of the sampling, plus a couple of directional
 * claims with room for the noise. Anything asserted to three decimals here would be
 * asserting the seed.
 */

test("the tie split matches a brute-force binomial sum", () => {
  const brute = (before: number, level: number, rivals: number) => {
    let total = 0;
    let coefficient = 1;
    for (let k = 0; k <= rivals; k += 1) {
      total += (coefficient * level ** k * before ** (rivals - k)) / (k + 1);
      coefficient = (coefficient * (rivals - k)) / (k + 1);
    }
    return total;
  };
  for (const rivals of [0, 1, 4, 12, 60]) {
    for (const [before, level] of [[0.5, 0.2], [0.9, 0.05], [0.1, 0.7], [0.0, 1.0]]) {
      assert.ok(
        Math.abs(shareAgainstExits(before, level, rivals) - brute(before, level, rivals)) < 1e-9,
        `rivals=${rivals} before=${before} level=${level}`,
      );
    }
  }
});

test("nobody can finish level when nobody can finish level", () => {
  // level = 0 collapses to "every rival is already out", which is before^rivals.
  assert.ok(Math.abs(shareAgainstExits(0.8, 0, 3) - 0.8 ** 3) < 1e-12);
});

// --- identities that hold whatever the sampling does ---------------------------------

test("alone in the pool, you are always the last one standing", () => {
  const field: Field = { probabilities: [0.7, 0.8, 0.6], crowding: 0.4 };
  const prepared = prepareField(field, 3, 1);
  const win = lastStandingWin({ mine: [0.5, 0.5, 0.5], shared: [false, false, false] }, prepared, 1);
  assert.equal(win, 1, "with no rivals there is nobody to outlast");
});

test("when nobody can be eliminated, the pot splits evenly", () => {
  // Everyone reaches the end together, so an N-entry pool pays 1/N. Exact, because no
  // sampled outcome can vary: every season is identical.
  const prepared = prepareField({ probabilities: [1, 1, 1], crowding: 0 }, 3, 0);
  const line = { mine: [1, 1, 1], shared: [false, false, false] };
  for (const n of [2, 5, 20, 137]) {
    assert.ok(
      Math.abs(lastStandingWin(line, prepared, n) - 1 / n) < 1e-12,
      `pool of ${n}`,
    );
  }
});

test("the same inputs give bit-identical answers", () => {
  // The seed is fixed so two candidates are compared over the same seasons. If this
  // ever drifts, a ranking could change between renders with nothing else changing.
  const field: Field = { probabilities: [0.75, 0.8, 0.7], crowding: 0.3 };
  const prepared = prepareField(field, 3, 1);
  const line = { mine: [0.72, 0.8, 0.68], shared: [false, true, false] };
  assert.equal(lastStandingWin(line, prepared, 13), lastStandingWin(line, prepared, 13));
});

test("a line of the wrong length scores nothing rather than reading past its end", () => {
  const prepared = prepareField({ probabilities: [0.8, 0.8], crowding: 0.2 }, 2, 0);
  assert.equal(lastStandingWin({ mine: [0.8], shared: [true] }, prepared, 13), 0);
});

// --- the claim the rebuild was for ---------------------------------------------------

/**
 * A full eighteen-week season, which is the only length at which this matters.
 *
 * Over eight weeks a two-life entry survives comfortably and the pool rarely empties,
 * so the two objectives nearly agree -- which is a true fact about short seasons and a
 * useless test of the rebuild. Across a real season survival falls to about 7% and the
 * pool wipes out entirely around 44% of the time, and those are the seasons the old
 * objective scored as zero for everybody.
 */
function season() {
  const mine = [
    0.765, 0.789, 0.835, 0.739, 0.764, 0.874, 0.745, 0.813, 0.874,
    0.714, 0.835, 0.714, 0.764, 0.692, 0.813, 0.789, 0.745, 0.813,
  ];
  const shared = [
    false, false, true, false, true, true, true, true, true,
    false, true, true, true, false, false, true, true, true,
  ];
  const crowd = mine.map((p, i) => (shared[i] ? p : Math.min(0.999, p + 0.03)));
  const field: Field = { probabilities: crowd, crowding: 0.276 };
  return { mine, shared, field, prepared: prepareField(field, 18, 1) };
}

test("outlasting the field beats reaching the end, in a pool that often wipes out", () => {
  // A small pool with two lives busts entirely about 44% of the time. Those seasons
  // scored zero for everybody under the survival objective; under the real rule they
  // each have a winner. So last-standing must come out strictly higher.
  const { mine, shared, field, prepared } = season();
  const last = lastStandingWin({ mine, shared }, prepared, 13);
  const reach = poolWin({ mine, shared, field, lossesAllowed: 1, poolSize: 13 });
  // Measured at about 1.65x on the live plan; 1.3 is well clear of the sampling noise
  // and still fails loudly if the wipeout seasons ever stop being counted.
  assert.ok(last > reach * 1.3, `last-standing ${last} should clearly beat reach-the-end ${reach}`);
});

test("a big pool barely notices the difference, because somebody always survives", () => {
  // With 137 entrants the two objectives ask the same question, so the rebuild must NOT
  // move that number. If it does, something is being double-counted.
  const { mine, shared, field, prepared } = season();
  const last = lastStandingWin({ mine, shared }, prepared, 137);
  const reach = poolWin({ mine, shared, field, lossesAllowed: 1, poolSize: 137 });
  assert.ok(Math.abs(last / reach - 1) < 0.1, `${last} vs ${reach} should be within 10%`);
});

test("a bigger pool is still harder to win", () => {
  const field: Field = { probabilities: [0.8, 0.78, 0.82], crowding: 0.3 };
  const prepared = prepareField(field, 3, 0);
  const line = { mine: [0.76, 0.78, 0.8], shared: [false, true, false] };
  const small = lastStandingWin(line, prepared, 13);
  const large = lastStandingWin(line, prepared, 137);
  assert.ok(small > large, `${small} should exceed ${large}`);
});

test("surviving longer is worth more than surviving less, all else equal", () => {
  // The property the whole rebuild rests on: under the old objective these two were
  // identical, because both fail to reach the end equally often.
  const field: Field = { probabilities: [0.8, 0.8], crowding: 0 };
  const prepared = prepareField(field, 2, 0);
  const early = { mine: [0.6, 0.9], shared: [false, false] }; // likely out in week 1
  const late = { mine: [0.9, 0.6], shared: [false, false] }; // same product, out later
  assert.ok(
    Math.abs(survival(early.mine, 0) - survival(late.mine, 0)) < 1e-12,
    "the fixture must hold survival equal, or it proves nothing",
  );
  assert.ok(
    lastStandingWin(late, prepared, 13) > lastStandingWin(early, prepared, 13),
    "lasting into week 2 must beat going out in week 1",
  );
});
