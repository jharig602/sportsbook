import assert from "node:assert/strict";
import { test } from "node:test";

import { centralDate, promoDue } from "./promo-window.ts";

/** A UTC instant, written plainly so each case says which real moment it is. */
const at = (iso: string) => new Date(iso);

test("a reminder is due through the whole working day, not in a two-hour slot", () => {
  // The bug this replaces: the old gate was Central 08-09, and over five days of real
  // scheduled runs not one landed inside it. Breadth is the entire fix.
  assert.equal(promoDue(at("2026-09-12T13:00:00Z")), "2026-09-12"); // 08:00 CDT
  assert.equal(promoDue(at("2026-09-12T17:30:00Z")), "2026-09-12"); // 12:30 CDT
  assert.equal(promoDue(at("2026-09-13T01:00:00Z")), "2026-09-12"); // 20:00 CDT, same day
});

test("nothing is due overnight or before the morning", () => {
  assert.equal(promoDue(at("2026-09-12T11:00:00Z")), null); // 06:00 CDT, too early
  assert.equal(promoDue(at("2026-09-13T03:00:00Z")), null); // 22:00 CDT, too late
  assert.equal(promoDue(at("2026-09-13T06:00:00Z")), null); // 01:00 CDT
});

test("the day is counted in Central, not UTC", () => {
  // 8pm Central is already tomorrow in UTC. Counting "once a day" in UTC would let a
  // second reminder go out the same evening, and skip a real one the next morning.
  assert.equal(centralDate(at("2026-09-13T01:00:00Z")), "2026-09-12");
  assert.equal(centralDate(at("2026-09-13T04:59:00Z")), "2026-09-12");
  assert.equal(centralDate(at("2026-09-13T05:01:00Z")), "2026-09-13");
});

test("the due date matches the day it is counted under", () => {
  // These two must never disagree, or a reminder is recorded against a date other than
  // the one it was sent for and the next day's is suppressed.
  for (const iso of [
    "2026-09-12T13:00:00Z",
    "2026-09-12T20:00:00Z",
    "2026-09-13T00:59:00Z",
  ]) {
    const due = promoDue(at(iso));
    assert.equal(due, centralDate(at(iso)), iso);
  }
});

test("the switch out of daylight time does not move the window", () => {
  // Central is UTC-5 in September and UTC-6 from 1 November 2026.
  assert.equal(promoDue(at("2026-11-16T14:00:00Z")), "2026-11-16"); // 08:00 CST
  assert.equal(promoDue(at("2026-11-16T13:00:00Z")), null); // 07:00 CST, still early
});

test("midnight does not read as an hour past the end of the day", () => {
  // Some runtimes format midnight as "24". Folded to 0, it is simply out of window.
  assert.equal(promoDue(at("2026-09-13T05:00:00Z")), null); // 00:00 CDT
  assert.equal(centralDate(at("2026-09-13T05:00:00Z")), "2026-09-13");
});
