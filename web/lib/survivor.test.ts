import assert from "node:assert/strict";
import { test } from "node:test";

import type { MarginModel } from "./probability.ts";
import {
  assign,
  weekAnchor,
  buildPlan,
  buildWeeks,
  candidatesFor,
  groupIntoWeeks,
  type SeasonGame,
} from "./survivor.ts";

/**
 * A realistic NFL model, not an empty shell.
 *
 * `winProbabilityFromSpread` reads the residual DISTRIBUTION, not just its width — the
 * lumpiness on 3 and 7 is most of why it is worth having. A fixture with an empty pmf
 * silently returns probabilities that do not sum to one across the two sides of a
 * game, which is how this was caught.
 */
function normalPmf(mean: number, sd: number): Record<string, number> {
  const pmf: Record<string, number> = {};
  let total = 0;
  for (let half = -120; half <= 120; half += 1) {
    const x = half / 2;
    const z = (x - mean) / sd;
    const density = Math.exp(-0.5 * z * z);
    pmf[String(half)] = density;
    total += density;
  }
  for (const key of Object.keys(pmf)) pmf[key] /= total;
  return pmf;
}

const NFL: MarginModel = {
  league: "nfl",
  games: 2215,
  mean: -0.19,
  sd: 12.74,
  lo: -60,
  hi: 60,
  pmf: normalPmf(-0.19, 12.74),
};

function game(over: Partial<SeasonGame> = {}): SeasonGame {
  return {
    feedEventId: "e1",
    commenceTime: "2026-09-13T17:00:00Z",
    homeTeam: "Home",
    awayTeam: "Away",
    homeSpread: -3,
    books: 8,
    ...over,
  };
}

/** A week's worth of fixtures `days` after the opener. */
function slate(days: number, pairs: Array<[string, string, number]>): SeasonGame[] {
  const base = new Date("2026-09-13T17:00:00Z").getTime() + days * 86400000;
  return pairs.map(([home, away, spread], i) =>
    game({
      feedEventId: `w${days}-${i}`,
      commenceTime: new Date(base + i * 1000).toISOString(),
      homeTeam: home,
      awayTeam: away,
      homeSpread: spread,
    }),
  );
}

// --- grouping ---------------------------------------------------------------------

test("a real NFL week -- Thursday, Sunday, Monday -- groups as one", () => {
  // Thu 8:20pm ET, Sun 1:00pm ET, Mon 8:15pm ET, then the next Thursday.
  const weeks = groupIntoWeeks([
    game({ feedEventId: "thu", commenceTime: "2026-09-11T00:20:00Z" }),
    game({ feedEventId: "sun", commenceTime: "2026-09-13T17:00:00Z" }),
    game({ feedEventId: "mon", commenceTime: "2026-09-15T00:15:00Z" }),
    game({ feedEventId: "nextThu", commenceTime: "2026-09-18T00:20:00Z" }),
  ]);
  assert.equal(weeks.length, 2);
  assert.deepEqual(weeks[0].map((g) => g.feedEventId), ["thu", "sun", "mon"]);
  assert.deepEqual(weeks[1].map((g) => g.feedEventId), ["nextThu"]);
});

test("a Monday night game stays in its own week, not the next one", () => {
  // 8:15pm ET Monday is already 00:15 UTC Tuesday. A UTC week rule files it a week
  // late, and every pick after it is then attributed to the wrong week.
  assert.equal(weekAnchor("2026-09-15T00:15:00Z"), weekAnchor("2026-09-13T17:00:00Z"));
});

test("the week boundary survives the end of daylight saving", () => {
  // The US switches on 1 November 2026. A fixed -4 or -5 offset moves a boundary by an
  // hour, which is enough to misfile a late Monday game.
  const beforeSwitch = weekAnchor("2026-10-27T00:15:00Z"); // Mon 26 Oct, 8:15pm EDT
  const afterSwitch = weekAnchor("2026-11-10T01:15:00Z");  // Mon 9 Nov, 8:15pm EST
  assert.equal(beforeSwitch, "2026-10-20");
  assert.equal(afterSwitch, "2026-11-03");
});

test("a bye week simply has fewer games, not a missing week", () => {
  const weeks = groupIntoWeeks([
    game({ feedEventId: "a", commenceTime: "2026-09-13T17:00:00Z" }),
    game({ feedEventId: "b", commenceTime: "2026-09-20T17:00:00Z" }),
    game({ feedEventId: "c", commenceTime: "2026-09-27T17:00:00Z" }),
  ]);
  assert.equal(weeks.length, 3);
});

test("grouping does not care what order the fixtures arrive in", () => {
  const forward = groupIntoWeeks([...slate(0, [["A", "B", -3]]), ...slate(9, [["C", "D", -3]])]);
  const reversed = groupIntoWeeks([...slate(9, [["C", "D", -3]]), ...slate(0, [["A", "B", -3]])]);
  assert.deepEqual(forward.map((w) => w.length), reversed.map((w) => w.length));
});

test("an empty schedule is not an error", () => {
  assert.deepEqual(groupIntoWeeks([]), []);
});

// --- candidates -------------------------------------------------------------------

test("both sides of a game are pickable, with complementary probabilities", () => {
  const [best, worst] = candidatesFor([game({ homeSpread: -7 })], NFL);
  assert.equal(best.team, "Home");
  assert.equal(worst.team, "Away");
  assert.ok(Math.abs(best.winProbability + worst.winProbability - 1) < 1e-9);
  assert.ok(best.winProbability > 0.7, "a 7-point favourite should be around 70%");
});

test("an unpriced game yields no pick at all", () => {
  // Not "a pick with unknown odds" -- guessing here would put a team in the plan on no
  // evidence whatsoever.
  assert.deepEqual(candidatesFor([game({ homeSpread: null })], NFL), []);
  assert.deepEqual(candidatesFor([game()], null), []);
});

test("the spread is reported from the picked team's own side", () => {
  const [home, away] = candidatesFor([game({ homeSpread: -7 })], NFL);
  assert.equal(home.spread, -7);
  assert.equal(away.spread, 7);
});

// --- assignment -------------------------------------------------------------------

test("assignment finds the optimum, not the greedy answer", () => {
  // Row 0 slightly prefers column 0, but row 1 can ONLY use column 0. Taking row 0's
  // favourite strands row 1 on a far worse cell.
  const cost = [
    [1, 2, 9],
    [3, 100, 100],
  ];
  assert.deepEqual(assign(cost), [1, 0]);
});

test("assignment never uses a column twice", () => {
  const chosen = assign([
    [1, 5, 5, 5],
    [1, 5, 5, 5],
    [1, 1, 5, 5],
  ]);
  assert.equal(new Set(chosen).size, 3);
});

test("assignment refuses a problem with fewer teams than weeks", () => {
  assert.throws(() => assign([[1, 2], [1, 2], [1, 2]]), /at least as many columns/);
});

// --- planning ---------------------------------------------------------------------

test("the plan saves a strong team for the week that needs it", () => {
  // Week 1: Titan is a huge favourite, and Solid is a decent one.
  // Week 2: Titan is a huge favourite again, and nothing else is playable.
  // Greedy spends Titan in week 1 and is left with a coin flip in week 2.
  const games = [
    ...slate(0, [["Titan", "Weak", -14], ["Solid", "Poor", -7]]),
    ...slate(7, [["Titan", "Weak2", -14], ["Coin", "Flip", 0]]),
  ];
  const plan = buildPlan(buildWeeks(games, NFL));
  assert.equal(plan.weeksPlanned, 2);
  assert.equal(plan.picks[0].pick!.team, "Solid", "week 1 should not spend Titan");
  assert.equal(plan.picks[1].pick!.team, "Titan");
  assert.ok(plan.survival > plan.greedySurvival, "the plan must beat picking greedily");
});

test("no team is used twice across the season", () => {
  const games = [
    ...slate(0, [["A", "B", -10], ["C", "D", -7]]),
    ...slate(7, [["A", "E", -10], ["C", "F", -7]]),
    ...slate(14, [["A", "G", -10], ["C", "H", -7]]),
  ];
  const plan = buildPlan(buildWeeks(games, NFL));
  const used = plan.picks.filter((p) => p.pick).map((p) => p.pick!.team);
  assert.equal(new Set(used).size, used.length);
});

test("the sacrifice is reported, so a surprising pick explains itself", () => {
  const games = [
    ...slate(0, [["Titan", "Weak", -14], ["Solid", "Poor", -7]]),
    ...slate(7, [["Titan", "Weak2", -14], ["Coin", "Flip", 0]]),
  ];
  const plan = buildPlan(buildWeeks(games, NFL));
  assert.equal(plan.picks[0].greedy!.team, "Titan");
  assert.ok(plan.picks[0].sacrifice > 0, "week 1 gave up probability on purpose");
  assert.ok(plan.picks[1].sacrifice === 0);
});

test("survival is the product of the weeks planned", () => {
  const games = [
    ...slate(0, [["A", "B", -7]]),
    ...slate(7, [["C", "D", -7]]),
  ];
  const plan = buildPlan(buildWeeks(games, NFL));
  const product = plan.picks.reduce((acc, p) => acc * p.pick!.winProbability, 1);
  assert.ok(Math.abs(plan.survival - product) < 1e-9);
  assert.ok(plan.survival < plan.picks[0].pick!.winProbability, "more weeks is harder");
});

test("a horizon bounds how far ahead the plan commits", () => {
  const games = [
    ...slate(0, [["A", "B", -7]]),
    ...slate(7, [["C", "D", -7]]),
    ...slate(14, [["E", "F", -7]]),
  ];
  const plan = buildPlan(buildWeeks(games, NFL), 2);
  assert.equal(plan.weeksPlanned, 2);
  assert.equal(plan.unplannedWeeks, 1);
});

test("weeks with nothing priced are dropped rather than planned blind", () => {
  const games = [
    ...slate(0, [["A", "B", -7]]),
    ...slate(7, [["C", "D", -7]]).map((g) => ({ ...g, homeSpread: null })),
    ...slate(14, [["E", "F", -7]]),
  ];
  const plan = buildPlan(buildWeeks(games, NFL));
  assert.equal(plan.weeksPlanned, 2);
  assert.deepEqual(plan.picks.map((p) => p.pick!.team), ["A", "E"]);
});

test("an empty season plans nothing without throwing", () => {
  const plan = buildPlan(buildWeeks([], NFL));
  assert.equal(plan.weeksPlanned, 0);
  assert.deepEqual(plan.picks, []);
});

test("more weeks than teams does not crash the planner", () => {
  // Pathological, but a schedule feed with one game a week would produce it.
  const games = [
    ...slate(0, [["A", "B", -7]]),
    ...slate(7, [["A", "B", -7]]),
    ...slate(14, [["A", "B", -7]]),
  ];
  const plan = buildPlan(buildWeeks(games, NFL));
  assert.equal(plan.weeksPlanned, 3);
});
