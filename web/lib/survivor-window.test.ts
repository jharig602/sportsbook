import assert from "node:assert/strict";
import { test } from "node:test";

import { windowFor, windowLabel } from "./survivor-window.ts";

/** A moment given in US Central, expressed as UTC. September is CDT, UTC-5. */
const cdt = (iso: string) => new Date(`${iso}-05:00`);
/** November onward is CST, UTC-6. */
const cst = (iso: string) => new Date(`${iso}-06:00`);

test("Saturday evening is a reminder window", () => {
  assert.equal(windowFor(cdt("2026-09-12T20:00:00")), "saturday");
  assert.equal(windowFor(cdt("2026-09-12T23:30:00")), "saturday");
});

test("Sunday morning is a reminder window, ending before the lock", () => {
  assert.equal(windowFor(cdt("2026-09-13T07:00:00")), "sunday");
  assert.equal(windowFor(cdt("2026-09-13T09:45:00")), "sunday");
  assert.equal(windowFor(cdt("2026-09-13T10:00:00")), null, "the deadline itself");
  assert.equal(windowFor(cdt("2026-09-13T11:00:00")), null, "too late to matter");
});

test("nothing fires midweek", () => {
  for (const day of ["2026-09-08", "2026-09-09", "2026-09-10", "2026-09-11"]) {
    assert.equal(windowFor(cdt(`${day}T20:00:00`)), null, day);
  }
});

test("Saturday afternoon is too early: the line has not settled", () => {
  assert.equal(windowFor(cdt("2026-09-12T14:00:00")), null);
});

test("Sunday before dawn is not a reminder", () => {
  assert.equal(windowFor(cdt("2026-09-13T04:00:00")), null);
});

test("the windows survive the switch out of daylight time", () => {
  // The US falls back on 1 November 2026. A fixed offset would move both reminders by
  // an hour, and the Sunday one has only two hours of margin to a hard deadline.
  assert.equal(windowFor(cst("2026-11-14T20:00:00")), "saturday");
  assert.equal(windowFor(cst("2026-11-15T08:00:00")), "sunday");
  assert.equal(windowFor(cst("2026-11-15T10:30:00")), null);
});

test("labels read as the moment, not the code", () => {
  assert.equal(windowLabel("saturday"), "Saturday night");
  assert.equal(windowLabel("sunday"), "Sunday morning");
});

test("a week is locked from 10am Central on its Sunday, judged from the games still left", async () => {
  const { pickLocked, sundayLockFor } = await import("./survivor-window.ts");
  // Week 4: Sunday night and Monday night games left.
  const left = ["2026-10-05T00:20:00Z", "2026-10-06T00:15:00Z"]; // Sun 7:20pm CT, Mon 7:15pm CT
  assert.equal(sundayLockFor(left[0])?.toISOString(), "2026-10-04T15:00:00.000Z");
  assert.equal(sundayLockFor(left[1])?.toISOString(), "2026-10-04T15:00:00.000Z", "Monday points back to Sunday");
  assert.equal(pickLocked(left, new Date("2026-10-04T14:59:00Z")), false);
  assert.equal(pickLocked(left, new Date("2026-10-04T20:43:00Z")), true, "Sunday afternoon: the pick is in");
  // Standard time: 10am CST is 16:00 UTC.
  assert.equal(sundayLockFor("2026-11-08T18:00:00Z")?.toISOString(), "2026-11-08T16:00:00.000Z");
  // A week with only Thursday left has not reached its Sunday lock.
  assert.equal(pickLocked(["2026-10-09T00:15:00Z"], new Date("2026-10-08T12:00:00Z")), false);
});
