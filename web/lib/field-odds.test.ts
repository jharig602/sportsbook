import assert from "node:assert/strict";
import { test } from "node:test";

import { fieldOdds } from "./field-odds.ts";
import { buildPoolWinPlans } from "./pool-win.ts";
import type { Week } from "./survivor.ts";

const TEAMS = Array.from({ length: 24 }, (_, i) => `Team ${String.fromCharCode(65 + i)}`);
function season(): Week[] {
  return Array.from({ length: 8 }, (_, w) => ({
    week: 5 + w,
    startsAt: "2026-10-11T17:00:00Z",
    candidates: TEAMS.map((team, i) => ({
      team, opponent: `opp ${i}`, home: true, commenceTime: "2026-10-11T17:00:00Z",
      winProbability: 0.4 + (((i * 5 + w * 7) % 24) / 24) * 0.5, spread: -3, eventId: `${team}-${w}`,
    })).sort((a, b) => b.winProbability - a.winProbability),
  })) as never;
}

const pool = {
  used: ["Team A", "Team B"], size: 8, lossesAllowed: 1, field: [2, 6], myLosses: 1,
  rivals: { week: 5, groups: [
    { used: ["Team C"], n: 1, losses: 0 },
    { used: ["Team D"], n: 1, losses: 0 },
    { used: ["Team E", "Team F"], n: 3, losses: 1 },
    { used: ["Team G"], n: 2, losses: 1 },
  ] },
};

function run(p = pool) {
  const [mine] = buildPoolWinPlans(season(), [p as never], { crowding: 0.4 });
  return fieldOdds(season(), p as never, {
    crowding: 0.4, crowdingMeasured: true,
    you: {
      teams: mine.plan.picks.map((x) => x.pick?.team ?? null),
      mine: mine.plan.picks.map((x) => x.pick?.winProbability ?? 1),
      poolWin: mine.poolWin, survival: mine.plan.survival,
    },
  });
}

test("everyone's chances come close to summing to one, and the page can show it", () => {
  const { rows, total } = run();
  assert.equal(rows.reduce((s, r) => s + r.n, 0), 8, "every entrant appears once");
  assert.ok(total > 0.8 && total < 1.2, `sum ${total}`);
});

test("an unbeaten rival's chance beats one on their last life with the same kind of history", () => {
  const { rows } = run();
  const unbeaten = rows.filter((r) => !r.you && r.losses === 0);
  const lastLife = rows.filter((r) => !r.you && r.losses === 1);
  assert.ok(Math.min(...unbeaten.map((r) => r.win)) > Math.max(...lastLife.map((r) => r.win)) * 0.9);
});

test("a known pick this week replaces the assumed one", () => {
  const withPick = { ...pool, rivals: { ...pool.rivals, groups: pool.rivals.groups.map((g, i) => (i === 0 ? { ...g, pick: "Team X" } : g)) } };
  const row = run(withPick).rows.find((r) => r.used[0] === "Team C")!;
  assert.equal(row.teams[0], "Team X");
  assert.equal(row.pick, "Team X");
});
