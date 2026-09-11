import assert from "node:assert/strict";
import { test } from "node:test";

import { DISPLAY_TIME_ZONE, formatDay, formatKickoff } from "./format.ts";

/**
 * These pin the zone rather than the wording.
 *
 * The bug being guarded is not a formatting preference, it is that these pages are
 * rendered on a server in UTC, so `toLocaleString(undefined, ...)` showed every kickoff
 * five hours late. A test that ran in the author's own zone and passed would have said
 * nothing about that, so each case states the Central answer outright.
 */

test("a kickoff is shown in Central, not in whatever zone rendered the page", () => {
  // 23:00 UTC on Saturday is 6pm Central, and was being displayed as 11:00 PM.
  assert.equal(formatKickoff("2026-09-12T23:00:00Z"), "Sat, Sep 12, 6:00 PM");
  // 17:00 UTC on Sunday is the noon Central slot, displayed as 5:00 PM.
  assert.equal(formatKickoff("2026-09-13T17:00:00Z"), "Sun, Sep 13, 12:00 PM");
});

test("a late game is dated by the Central day, not the UTC one", () => {
  // 01:00 UTC Sunday is Saturday 8pm Central. Under the old rule this game moved to
  // the next day -- a heading it does not belong under, on a board sorted by day.
  assert.equal(formatKickoff("2026-09-13T01:00:00Z"), "Sat, Sep 12, 8:00 PM");
  assert.equal(formatDay("2026-09-13T01:00:00Z"), "Saturday, Sep 12");
});

test("the whole Saturday night slate groups under Saturday", () => {
  const saturdayNight = [
    "2026-09-12T23:00:00Z", // 6pm CT
    "2026-09-13T02:30:00Z", // 9:30pm CT
    "2026-09-13T04:00:00Z", // 11pm CT
  ].map(formatDay);
  assert.deepEqual(saturdayNight, ["Saturday, Sep 12", "Saturday, Sep 12", "Saturday, Sep 12"]);
});

test("the switch out of daylight time is followed, not approximated", () => {
  // Central is UTC-5 in September and UTC-6 from 1 November 2026. A fixed offset would
  // put one of these an hour out, and the survivor deadline has no hour to spare.
  assert.equal(formatKickoff("2026-10-25T17:00:00Z"), "Sun, Oct 25, 12:00 PM");
  assert.equal(formatKickoff("2026-11-08T18:00:00Z"), "Sun, Nov 8, 12:00 PM");
});

test("a missing kickoff renders as a dash rather than an invalid date", () => {
  assert.equal(formatKickoff(null), "—");
  assert.equal(formatDay(null), "—");
});

test("the display zone is Central and is shared by both formatters", () => {
  // Stated explicitly so a change to it is a deliberate edit to a test, not a silent
  // drift in what every time on every page means.
  assert.equal(DISPLAY_TIME_ZONE, "America/Chicago");
});
