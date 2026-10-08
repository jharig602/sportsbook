import assert from "node:assert/strict";
import { test } from "node:test";

import { followRate, followRecord, predictPick } from "./rival-habits.ts";

const national = new Map([
  [1, { "Jacksonville Jaguars": 0.35, "Los Angeles Chargers": 0.3, "Philadelphia Eagles": 0.1 }],
  [2, { "San Francisco 49ers": 0.4, "Tampa Bay Buccaneers": 0.3, "Philadelphia Eagles": 0.05 }],
  [3, { "Kansas City Chiefs": 0.45, "Seattle Seahawks": 0.2, "San Francisco 49ers": 0.15 }],
]);

test("a rival who took the national favourite every week is a follower", () => {
  const r = followRecord(["Jacksonville Jaguars", "San Francisco 49ers", "Kansas City Chiefs"], national);
  assert.equal(r.followed, 3);
  assert.equal(r.scored, 3);
});

test("the favourite they had already spent does not count against them", () => {
  // Spent SF in week 2, so in week 3 their most popular available was KC... they took Seattle.
  const r = followRecord(["Philadelphia Eagles", "San Francisco 49ers", "Seattle Seahawks"], national);
  assert.equal(r.followed, 1);
  assert.equal(r.scored, 3);
  // Picking in proportion to the shares, over what they had left each week, would have hit
  // the favourite .35/.75 + .40/.70 + .45/.65 = 0.47 + 0.57 + 0.69 of those weeks.
  assert.ok(Math.abs(r.expected - (0.35 / 0.75 + 0.4 / 0.7 + 0.45 / 0.65)) < 1e-9, `expected ${r.expected}`);
});

test("the rate is shrunk toward the pool, so one week does not decide it", () => {
  assert.equal(followRate({ followed: 1, scored: 1 }, 0.4), (1 + 0.8) / 3);
  assert.equal(followRate({ followed: 0, scored: 0 }, 0.4), 0.4, "no evidence: the pool's habit");
});

const c = (team: string, p: number) => ({ team, winProbability: p }) as never;
const week5 = [c("Dallas Cowboys", 0.86), c("Cincinnati Bengals", 0.75), c("Houston Texans", 0.72), c("Denver Broncos", 0.7)];
const shares5 = { "Dallas Cowboys": 0.5, "Houston Texans": 0.2, "Cincinnati Bengals": 0.1 };

test("a follower is predicted on the national favourite they have, an independent on the next", () => {
  assert.equal((predictPick(week5, new Set(), shares5, 0.8) as any).team, "Dallas Cowboys");
  assert.equal((predictPick(week5, new Set(), shares5, 0.2) as any).team, "Houston Texans");
  // Already spent Dallas: a follower moves to the most popular team still left.
  assert.equal((predictPick(week5, new Set(["Dallas Cowboys"]), shares5, 0.8) as any).team, "Houston Texans");
});

test("with no national shares this week it falls back to their best team left", () => {
  assert.equal((predictPick(week5, new Set(), undefined, 0.2) as any).team, "Dallas Cowboys");
});

test("a rival with an ordinary habit gets the national split; a follower more, an independent less", async () => {
  const { pickChances, followTilt } = await import("./rival-habits.ts");
  // Dallas .5 of the .8 on teams available: 62.5% at a tilt of 1.
  assert.ok(Math.abs(pickChances(week5, new Set(), shares5, 1).get("Dallas Cowboys")! - 0.625) < 1e-9);
  assert.ok(pickChances(week5, new Set(), shares5, 2).get("Dallas Cowboys")! > 0.75);
  assert.ok(pickChances(week5, new Set(), shares5, 0.5).get("Dallas Cowboys")! < 0.5);
  // A rival who followed exactly as often as chance would have is untilted.
  const pool = { followed: 4, expected: 4, scored: 10 };
  assert.ok(Math.abs(followTilt({ followed: 2, expected: 2, scored: 5 }, pool) - 1) < 1e-9);
  assert.ok(followTilt({ followed: 5, expected: 2, scored: 5 }, pool) > 1, "followed more than chance");
  assert.ok(followTilt({ followed: 0, expected: 2, scored: 5 }, pool) < 1, "less than chance");
});

test("predicted picks spread across the pool in line with the expected counts", async () => {
  const { allocatePicks, pickChances } = await import("./rival-habits.ts");
  // Ten rivals with an ordinary habit: expected Dallas 6.25, Houston 2.5, Cincinnati 1.25.
  const groups = Array.from({ length: 10 }, () => ({ n: 1, chances: pickChances(week5, new Set(), shares5, 1) }));
  const picks = allocatePicks(groups);
  const count = (t: string) => picks.filter((p) => p === t).length;
  assert.ok(count("Dallas Cowboys") >= 5 && count("Dallas Cowboys") <= 7, `Dallas ${count("Dallas Cowboys")}`);
  assert.ok(count("Houston Texans") >= 2 && count("Houston Texans") <= 3, `Houston ${count("Houston Texans")}`);
  assert.ok(count("Cincinnati Bengals") >= 1 && count("Cincinnati Bengals") <= 2, `Cincinnati ${count("Cincinnati Bengals")}`);
  assert.equal(picks.filter(Boolean).length, 10, "everyone gets a team");
});

test("a team a rival has spent is never predicted for them", async () => {
  const { allocatePicks, pickChances } = await import("./rival-habits.ts");
  const groups = [{ n: 5, chances: pickChances(week5, new Set(["Dallas Cowboys"]), shares5, 3) }];
  assert.notEqual(allocatePicks(groups)[0], "Dallas Cowboys");
});
