import assert from "node:assert/strict";
import { test } from "node:test";

import { entryFor, parseUsed } from "./check-entry.ts";

const pool = {
  used: ["Detroit Lions", "Philadelphia Eagles", "Seattle Seahawks", "Minnesota Vikings"],
  size: 108, lossesAllowed: 1, field: [31, 77], myLosses: 1,
  rivals: { week: 5, groups: [
    { used: ["Baltimore Ravens", "Kansas City Chiefs", "Philadelphia Eagles", "San Francisco 49ers"], n: 2 },
    { used: ["Jacksonville Jaguars"], n: 5 },
  ] },
};

test("checking a rival swaps them out of the field and puts you in as their rival", () => {
  const theirs = ["Philadelphia Eagles", "San Francisco 49ers", "Kansas City Chiefs", "Baltimore Ravens"];
  const e = entryFor(pool as never, theirs, 0);
  assert.deepEqual(e.used, theirs);
  assert.equal(e.myLosses, 0, "their losses decide their bucket");
  const groups = e.rivals!.groups;
  assert.equal(groups.find((g) => g.used.includes("Kansas City Chiefs"))!.n, 1, "one of the two with that history was them");
  assert.ok(groups.some((g) => g.n === 1 && g.used.includes("Detroit Lions")), "you are now one of their rivals");
  assert.equal(groups.reduce((a, g) => a + g.n, 0), 7, "the head count is unchanged");
  assert.equal(e.field, pool.field, "the field is everyone alive either way");
});

test("the URL list is trimmed, de-duplicated and capped", () => {
  assert.deepEqual(parseUsed(" Baltimore Ravens, ,Baltimore Ravens,Kansas City Chiefs "), ["Baltimore Ravens", "Kansas City Chiefs"]);
  assert.deepEqual(parseUsed(undefined), []);
});
