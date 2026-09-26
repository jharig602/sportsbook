import assert from "node:assert/strict";
import { test } from "node:test";

import { DISPLAY_TIME_ZONE, formatDay, formatKickoff } from "./format.ts";

/**
 * These pin the zone rather than the wording.
 *
 * The bug being guarded is not a formatting preference, it is that these pages are
 * rendered on a server in UTC, so `toLocaleString(undefined, ...)` showed every kickoff
 * hours late. A test that ran in the author's own zone and passed would have said
 * nothing about that, so each case states the Eastern answer outright.
 */

test("a kickoff is shown in Eastern, not in whatever zone rendered the page", () => {
  // 23:00 UTC on Saturday is 7pm Eastern, and was being displayed as 11:00 PM.
  assert.equal(formatKickoff("2026-09-12T23:00:00Z"), "Sat, Sep 12, 7:00 PM");
  // 17:00 UTC on Sunday is the 1pm Eastern slot.
  assert.equal(formatKickoff("2026-09-13T17:00:00Z"), "Sun, Sep 13, 1:00 PM");
});

test("a late game is dated by the Eastern day, not the UTC one", () => {
  // 01:00 UTC Sunday is Saturday 9pm Eastern. Under the UTC rule this game moved to
  // the next day -- a heading it does not belong under, on a board sorted by day.
  assert.equal(formatKickoff("2026-09-13T01:00:00Z"), "Sat, Sep 12, 9:00 PM");
  assert.equal(formatDay("2026-09-13T01:00:00Z"), "Saturday, Sep 12");
});

test("the whole Saturday night slate groups under Saturday", () => {
  const saturdayNight = [
    "2026-09-12T23:00:00Z", // 7pm ET
    "2026-09-13T02:30:00Z", // 10:30pm ET
    "2026-09-13T03:30:00Z", // 11:30pm ET
  ].map(formatDay);
  assert.deepEqual(saturdayNight, ["Saturday, Sep 12", "Saturday, Sep 12", "Saturday, Sep 12"]);
});

test("the switch out of daylight time is followed, not approximated", () => {
  // Eastern is UTC-4 in September and UTC-5 from 1 November 2026. A fixed offset would
  // put one of these an hour out, and the survivor deadline has no hour to spare.
  assert.equal(formatKickoff("2026-10-25T17:00:00Z"), "Sun, Oct 25, 1:00 PM");
  assert.equal(formatKickoff("2026-11-08T18:00:00Z"), "Sun, Nov 8, 1:00 PM");
});

test("a missing kickoff renders as a dash rather than an invalid date", () => {
  assert.equal(formatKickoff(null), "—");
  assert.equal(formatDay(null), "—");
});

test("the display zone is Eastern and is shared by both formatters", () => {
  // Stated explicitly so a change to it is a deliberate edit to a test, not a silent
  // drift in what every time on every page means.
  assert.equal(DISPLAY_TIME_ZONE, "America/New_York");
});
