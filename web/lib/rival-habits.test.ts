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
  assert.deepEqual(r, { followed: 3, scored: 3 });
});

test("the favourite they had already spent does not count against them", () => {
  // Spent SF in week 2, so in week 3 their most popular available was KC... they took Seattle.
  const r = followRecord(["Philadelphia Eagles", "San Francisco 49ers", "Seattle Seahawks"], national);
  assert.deepEqual(r, { followed: 1, scored: 3 });
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
