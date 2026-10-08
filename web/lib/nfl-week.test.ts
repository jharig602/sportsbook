import assert from "node:assert/strict";
import { test } from "node:test";

import { nflWeek } from "./season-db.ts";

const OPENER = "2026-09-11T00:20:00Z"; // Thu Sep 10, 8:20 PM Eastern

test("weeks run Tuesday to Monday, the same as the collector's", () => {
  assert.equal(nflWeek(OPENER, new Date("2026-09-08T13:00:00Z")), 1);
  assert.equal(nflWeek(OPENER, new Date("2026-09-14T23:00:00Z")), 1);
  assert.equal(nflWeek(OPENER, new Date("2026-10-06T15:00:00Z")), 5, "Tuesday of week 5, not week 4");
  assert.equal(nflWeek(OPENER, new Date("2026-10-08T18:00:00Z")), 5, "Thursday before kickoff");
  assert.equal(nflWeek(OPENER, new Date("2026-10-12T23:00:00Z")), 5, "Monday night");
  assert.equal(nflWeek(OPENER, new Date("2026-10-13T13:00:00Z")), 6);
});
