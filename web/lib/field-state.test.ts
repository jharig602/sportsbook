/**
 * The field as it stands, after week 1.
 *
 * Two pools, both allowing one loss: 141 entrants of whom 51 are a loss down, and 11 of
 * whom 2 are. Before this the model treated every rival as unbeaten, which is true for
 * exactly one week of the season and planned against a field that no longer existed.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { exitPmf, lastStandingWin, prepareField, shareAgainstExits } from "./last-standing.ts";
import { poolOdds } from "./pool-odds.ts";
import { fieldState, parsePools } from "./pools.ts";
import type { Field } from "./pool-win.ts";

// --- recording the field --------------------------------------------------------

test("you are taken out of your own bucket, not counted as your own rival", () => {
  const big = fieldState({ size: 141, lossesAllowed: 1, field: [90, 51], myLosses: 0 });
  assert.equal(big.rivals, 140);
  assert.deepEqual(big.rivalLosses, [89, 51]);
  assert.equal(big.entrants, 141);
  assert.equal(big.livesLeft, 1);
  assert.equal(big.problem, null);

  const onALoss = fieldState({ size: 141, lossesAllowed: 1, field: [90, 51], myLosses: 1 });
  assert.deepEqual(onALoss.rivalLosses, [90, 50], "a loss down, you come out of that bucket");
  assert.equal(onALoss.livesLeft, 0);
});

test("the small pool after its dropouts", () => {
  const small = fieldState({ size: 11, lossesAllowed: 1, field: [9, 2] });
  assert.equal(small.rivals, 10);
  assert.deepEqual(small.rivalLosses, [8, 2]);
});

test("an unrecorded field is everyone unbeaten, and says it was not recorded", () => {
  const s = fieldState({ size: 13, lossesAllowed: 1 });
  assert.deepEqual(s.rivalLosses, [12, 0]);
  assert.equal(s.recorded, false);
});

test("numbers that cannot all be true are flagged, not quietly fixed", () => {
  // Nobody on one loss, yet that is where you say you are.
  const s = fieldState({ size: 5, lossesAllowed: 1, field: [5, 0], myLosses: 1 });
  assert.ok(s.problem, "the page must be told");
  assert.equal(s.rivals, 5, "the rivals typed are kept exactly");
});

test("entrants past the allowed losses are out and are dropped with a note", () => {
  const s = fieldState({ size: 20, lossesAllowed: 0, field: [15, 5] });
  assert.equal(s.rivals, 14);
  assert.ok(s.problem);
});

test("an entry already out is out", () => {
  const s = fieldState({ size: 20, lossesAllowed: 1, field: [15, 5], myLosses: 2 });
  assert.equal(s.livesLeft, -1);
  assert.equal(s.rivals, 20, "nobody was removed on your behalf");
});

test("a stored field makes the size its total, so the two cannot disagree", () => {
  const [p] = parsePools(JSON.stringify([{ used: [], size: 137, lossesAllowed: 1, field: [90, 51] }]));
  assert.equal(p.size, 141);
  assert.deepEqual(p.field, [90, 51]);
});

test("a field of all zeros is no field, and a missing myLosses is not stored as 0", () => {
  const [p] = parsePools(JSON.stringify([{ used: [], size: 13, lossesAllowed: 1, field: [0, 0], myLosses: 0 }]));
  assert.equal(p.field, undefined);
  assert.equal(p.myLosses, undefined);
  assert.equal(p.size, 13);
});

// --- what it does to the numbers ------------------------------------------------

const CROWD = [0.78, 0.8, 0.83, 0.75, 0.77, 0.86, 0.74, 0.81, 0.85, 0.72, 0.82, 0.71, 0.76, 0.7, 0.8, 0.79, 0.74];
const MINE = CROWD.map((p, i) => (i % 3 === 0 ? p - 0.04 : p));
const SHARED = CROWD.map((_, i) => i % 3 !== 0);
const FIELD: Field = { probabilities: CROWD, crowding: 0.276 };
const W = CROWD.length;

test("rivals on their last life are easier to outlast than unbeaten ones", () => {
  const line = { mine: MINE, shared: SHARED };
  const unbeaten = lastStandingWin(line, prepareField(FIELD, W, 1, 3000, [10, 0]), 11);
  const lastLife = lastStandingWin(line, prepareField(FIELD, W, 1, 3000, [0, 10]), 11);
  assert.ok(lastLife > unbeaten * 1.5, `${lastLife} should clearly beat ${unbeaten}`);
});

test("your own loss costs you, and being out is worth nothing", () => {
  const line = { mine: MINE, shared: SHARED };
  const prepared = prepareField(FIELD, W, 1, 3000, [8, 2]);
  const fresh = lastStandingWin(line, prepared, 11, 0);
  const down = lastStandingWin(line, prepared, 11, 1);
  assert.ok(down < fresh, `${down} should be below ${fresh}`);
  assert.equal(lastStandingWin(line, prepared, 11, 2), 0);
});

test("no recorded field reproduces the original numbers exactly", () => {
  // Existing pools must not move until someone records a field for them.
  const line = { mine: MINE, shared: SHARED };
  const before = lastStandingWin(line, prepareField(FIELD, W, 1, 2000), 13);
  const after = lastStandingWin(line, prepareField(FIELD, W, 1, 2000, [12, 0]), 13);
  assert.equal(after, before);

  const oddsBefore = poolOdds(MINE, 1, 13);
  const oddsAfter = poolOdds(MINE, 1, 13, { rivalLosses: [12, 0], myLosses: 0 });
  assert.deepEqual(oddsAfter, oddsBefore);
});

test("the field-left line thins faster when a third of it is on a last life", () => {
  const unbeaten = poolOdds(MINE, 1, 141);
  const recorded = poolOdds(MINE, 1, 141, { rivalLosses: [89, 51], myLosses: 0 });
  assert.ok(recorded.fieldAlive[3] < unbeaten.fieldAlive[3] - 10,
    `${recorded.fieldAlive[3]} vs ${unbeaten.fieldAlive[3]}`);
});

// --- measuring the approximation ------------------------------------------------
//
// The model draws every rival independently from the recorded mix, rather than holding
// the split at exactly 89 and 51. That is cheap -- one closed form per week -- and it is
// an approximation, so it is measured here against the exact answer instead of assumed.
//
// Exact: with two groups of rivals, your share of the pot at your exit week t is
//
//     integral_0^1  (A0 + B0 x)^R0 (A1 + B1 x)^R1 dx
//
// (the same 1/(1+K) = integral x^K identity behind shareAgainstExits). That integrand
// is a polynomial of degree R0 + R1, so Gauss-Legendre with ceil((R+1)/2) nodes gives it
// exactly -- no sampling beyond the seasons both versions share.

function gaussLegendre(n: number): { x: number[]; w: number[] } {
  const x: number[] = [];
  const w: number[] = [];
  for (let i = 1; i <= n; i += 1) {
    let z = Math.cos((Math.PI * (i - 0.25)) / (n + 0.5));
    let dp = 0;
    for (let iter = 0; iter < 100; iter += 1) {
      let p0 = 1;
      let p1 = z;
      for (let k = 2; k <= n; k += 1) {
        const p2 = ((2 * k - 1) * z * p1 - (k - 1) * p0) / k;
        p0 = p1;
        p1 = p2;
      }
      dp = (n * (z * p1 - p0)) / (z * z - 1);
      const dz = p1 / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-15) break;
    }
    // Mapped from [-1, 1] onto [0, 1].
    x.push((1 - z) / 2);
    w.push(1 / ((1 - z * z) * dp * dp));
  }
  return { x, w };
}

function exactTwoGroups(seasons: number, r0: number, r1: number, myLosses = 0): number {
  const lossesAllowed = 1;
  const g0 = prepareField(FIELD, W, lossesAllowed, seasons, [1, 0]);
  const g1 = prepareField(FIELD, W, lossesAllowed, seasons, [0, 1]);
  const span = W + 1;
  const { x, w } = gaussLegendre(Math.ceil((r0 + r1 + 1) / 2));
  const lose = new Float64Array(W);
  const pmf = new Float64Array(span);
  const dp = new Float64Array(lossesAllowed + 3);
  let total = 0;
  for (let s = 0; s < seasons; s += 1) {
    for (let i = 0; i < W; i += 1) {
      lose[i] = SHARED[i] ? g0.crowdLost[s * W + i] : 1 - MINE[i];
    }
    exitPmf(lose, lossesAllowed - myLosses, pmf, dp);
    for (let t = 0; t < span; t += 1) {
      if (pmf[t] <= 1e-15) continue;
      const a0 = g0.rivalBefore[s * span + t];
      const b0 = g0.rivalAt[s * span + t];
      const a1 = g1.rivalBefore[s * span + t];
      const b1 = g1.rivalAt[s * span + t];
      let share = 0;
      for (let k = 0; k < x.length; k += 1) {
        share += w[k] * Math.pow(a0 + b0 * x[k], r0) * Math.pow(a1 + b1 * x[k], r1);
      }
      total += pmf[t] * share;
    }
  }
  return total / seasons;
}

test("the quadrature is exact where there is a closed form to check it against", () => {
  // One group only: it must reproduce shareAgainstExits to rounding.
  const { x, w } = gaussLegendre(Math.ceil((140 + 1) / 2));
  for (const [a, b] of [[0.3, 0.2], [0.9, 0.05], [0.05, 0.9], [0.99, 0.009]]) {
    let q = 0;
    for (let k = 0; k < x.length; k += 1) q += w[k] * Math.pow(a + b * x[k], 140);
    const closed = shareAgainstExits(a, b, 140);
    assert.ok(Math.abs(q - closed) <= 1e-12 + 1e-9 * closed, `${a},${b}: ${q} vs ${closed}`);
  }
});

test("the mixed field stays close to the exact two-group answer, for both real pools", () => {
  const seasons = 1500;
  const line = { mine: MINE, shared: SHARED };
  const cases = [
    { name: "141-entry pool", r0: 89, r1: 51 },
    { name: "11-entry pool", r0: 8, r1: 2 },
  ];
  for (const { name, r0, r1 } of cases) {
    const mixed = lastStandingWin(line, prepareField(FIELD, W, 1, seasons, [r0, r1]), r0 + r1 + 1);
    const exact = exactTwoGroups(seasons, r0, r1);
    const gap = mixed / exact - 1;
    // Measured when written, identically at 1,500 and 12,000 seasons (so this is the
    // approximation, not sampling noise): +0.24% on the 141-entry pool (1 in 183 against
    // an exact 1 in 184) and +1.66% on the 11-entry one (1 in 13.2 against 13.4). The
    // small pool's gap is larger as expected -- with ten rivals, how many of them the
    // draw puts on a last life varies more. Both are far inside what the win
    // probabilities feeding them can claim. The bound leaves room and fails loudly if
    // the approximation ever stops holding.
    assert.ok(Math.abs(gap) < 0.05, `${name}: mixed ${mixed} vs exact ${exact} (${(gap * 100).toFixed(2)}%)`);
  }
});

// --- what "still alive" counts ---------------------------------------------------

test("the size is who is left, not who started", () => {
  // The real case that prompted this: 141 entered, 17 out, 40 unbeaten and 84 on one
  // loss. 124 is the right number to plan against and the label said "Entrants", which
  // made a correct figure look like lost people.
  const [pool] = parsePools(
    JSON.stringify([{ used: [], size: 141, lossesAllowed: 1, field: [40, 84], entered: 141 }]),
  );
  assert.equal(pool.size, 124, "size follows the field, which counts only the living");
  assert.equal(pool.entered, 141);

  const state = fieldState(pool);
  assert.equal(state.entrants, 124);
  assert.equal(state.rivals, 123, "you are one of the 124");
  assert.deepEqual(state.rivalLosses, [39, 84], "you come out of your own bucket");
});

test("how many started is recorded but never planned against", () => {
  // Someone eliminated cannot take the pool and cannot take it from you, so counting
  // them would plan against a field that is not there.
  const withEntered = parsePools(
    JSON.stringify([{ used: [], size: 141, lossesAllowed: 1, field: [40, 84], entered: 141 }]),
  )[0];
  const without = parsePools(
    JSON.stringify([{ used: [], size: 141, lossesAllowed: 1, field: [40, 84] }]),
  )[0];
  assert.deepEqual(fieldState(withEntered), fieldState(without));
});

test("a missing or nonsense start is simply not recorded", () => {
  const [pool] = parsePools(
    JSON.stringify([{ used: [], size: 10, lossesAllowed: 0, entered: 0 }]),
  );
  assert.equal(pool.entered, undefined);
  const [negative] = parsePools(
    JSON.stringify([{ used: [], size: 10, lossesAllowed: 0, entered: -5 }]),
  );
  assert.equal(negative.entered, undefined);
});

test("a pool's own crowding survives the app re-saving the whole list", () => {
  // The app writes every pool back whenever anything is tapped. If the parser dropped
  // this, marking a team used would silently erase the measurement.
  const [pool] = parsePools(
    JSON.stringify([{ used: [], size: 124, lossesAllowed: 1, field: [42, 82], crowd: { top: 105, picks: 282 } }]),
  );
  assert.deepEqual(pool.crowd, { top: 105, picks: 282 });
  const [again] = parsePools(JSON.stringify([pool]));
  assert.deepEqual(again.crowd, { top: 105, picks: 282 });
});

test("an impossible crowd measurement is dropped, not stored", () => {
  const [pool] = parsePools(
    JSON.stringify([{ used: [], size: 10, lossesAllowed: 0, crowd: { top: 30, picks: 22 } }]),
  );
  assert.equal(pool.crowd, undefined);
});

test("rivals' histories survive a re-save, and junk in them is dropped row by row", () => {
  const [pool] = parsePools(JSON.stringify([{
    used: [], size: 120, lossesAllowed: 1, field: [41, 79],
    rivals: { week: 3, groups: [
      { used: ["San Francisco 49ers", "", 7], pick: "Kansas City Chiefs", n: 12 },
      { used: ["Jacksonville Jaguars"], n: 0 },
      { used: "not a list", n: 3 },
      { used: [], pick: "", n: 2 },
    ] },
  }]));
  assert.deepEqual(pool.rivals, { week: 3, groups: [
    { used: ["San Francisco 49ers"], pick: "Kansas City Chiefs", n: 12 },
    { used: [], n: 3 },
    { used: [], n: 2 },
  ] });
  const [again] = parsePools(JSON.stringify([pool]));
  assert.deepEqual(again.rivals, pool.rivals);
  const [stale] = parsePools(JSON.stringify([{ used: [], size: 5, rivals: { week: 99, groups: [{ used: [], n: 1 }] } }]));
  assert.equal(stale.rivals, undefined, "a week that is not a week of the season is not kept");
});
