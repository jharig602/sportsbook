import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePools, poolLabel, type StoredPool } from "./pools.ts";

const pool = (over: Partial<StoredPool> = {}): StoredPool => ({
  used: [],
  size: 13,
  lossesAllowed: 1,
  ...over,
});

test("an unnamed pool is labelled by its size", () => {
  // The size is what distinguishes one pool from another and what drives the picks,
  // so it is what the label should say. "Pool A" carried no information.
  const pools = [pool({ size: 13 }), pool({ size: 137 })];
  assert.equal(poolLabel(pools[0], 0, pools), "Pool 13");
  assert.equal(poolLabel(pools[1], 1, pools), "Pool 137");
});

test("the label follows the size, so it cannot go stale", () => {
  // An entrant drops out, you change 13 to 12, and the tab says 12 without being told.
  const pools = [pool({ size: 12 })];
  assert.equal(poolLabel(pools[0], 0, pools), "Pool 12");
});

test("a name you typed wins over the derived one", () => {
  const pools = [pool({ name: "Work pool" })];
  assert.equal(poolLabel(pools[0], 0, pools), "Work pool");
});

test("two pools of the same size are told apart", () => {
  // Picking the wrong tab is the confusion this naming replaces, so identical labels
  // would be worse than the letters were.
  const pools = [pool({ size: 13 }), pool({ size: 13 }), pool({ size: 137 })];
  assert.equal(poolLabel(pools[0], 0, pools), "Pool 13 (1)");
  assert.equal(poolLabel(pools[1], 1, pools), "Pool 13 (2)");
  assert.equal(poolLabel(pools[2], 2, pools), "Pool 137");
});

test("a blank name is treated as no name", () => {
  for (const name of ["", "   "]) {
    const pools = [pool({ name, size: 25 })];
    assert.equal(poolLabel(pools[0], 0, pools), "Pool 25", JSON.stringify(name));
  }
});

// --- what comes back from a browser --------------------------------------------------

test("a pool with no name at all still parses", () => {
  // It used to be dropped: the filter required a string name, so an unnamed entry
  // vanished silently rather than being labelled by its size.
  const parsed = parsePools(JSON.stringify([{ used: [], size: 25, lossesAllowed: 1 }]));
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].size, 25);
  assert.equal(poolLabel(parsed[0], 0, parsed), "Pool 25");
});

test("an empty name is not stored, so the label stays derived", () => {
  const parsed = parsePools(JSON.stringify([{ name: "  ", used: [], size: 30, lossesAllowed: 0 }]));
  assert.equal(parsed[0].name, undefined);
  assert.equal(poolLabel(parsed[0], 0, parsed), "Pool 30");
});

test("any number of pools round-trips, one through eight", () => {
  // Next season might be one pool or three. Neither should need a code change.
  for (const count of [1, 3, 8]) {
    const raw = JSON.stringify(
      Array.from({ length: count }, (_, i) => ({ used: [], size: 10 + i, lossesAllowed: 0 })),
    );
    assert.equal(parsePools(raw).length, count, `count ${count}`);
  }
  // And a hostile payload cannot grow it without bound.
  const many = JSON.stringify(Array.from({ length: 50 }, () => ({ used: [], size: 5, lossesAllowed: 0 })));
  assert.equal(parsePools(many).length, 8);
});

test("sizes and loss allowances are clamped to something playable", () => {
  const parsed = parsePools(
    JSON.stringify([{ used: [], size: -4, lossesAllowed: 99 }, { used: [], size: 1e9, lossesAllowed: -3 }]),
  );
  assert.ok(parsed[0].size >= 1);
  assert.ok(parsed[0].lossesAllowed <= 5);
  assert.ok(parsed[1].size <= 100000);
  assert.ok(parsed[1].lossesAllowed >= 0);
});
