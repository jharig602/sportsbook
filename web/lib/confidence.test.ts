import assert from "node:assert/strict";
import test from "node:test";

import { rankConfidence, weekWindow, type ConfidenceGame } from "./confidence.ts";

const g = (id: string, homeChance: number, t = "2026-10-11T17:00:00Z"): ConfidenceGame => ({
  eventId: id, commenceTime: t, home: `H${id}`, away: `A${id}`, homeChance, source: "market", books: 3,
});

test("surest pick gets 16, likelier side is picked, expected points add up", () => {
  const { picks, expected, possible } = rankConfidence([g("1", 0.55), g("2", 0.2), g("3", 0.9)]);
  assert.deepEqual(picks.map((p) => [p.team, p.points]), [["H3", 16], ["A2", 15], ["H1", 14]]);
  assert.ok(Math.abs(expected - (0.9 * 16 + 0.8 * 15 + 0.55 * 14)) < 1e-9);
  assert.equal(possible, 45);
});

test("no swap of two ranks beats the order (rearrangement)", () => {
  const games = [g("1", 0.62), g("2", 0.31), g("3", 0.77), g("4", 0.5)];
  const { picks, expected } = rankConfidence(games);
  for (let i = 0; i < picks.length; i++)
    for (let j = i + 1; j < picks.length; j++) {
      const pts = picks.map((p) => p.points);
      [pts[i], pts[j]] = [pts[j], pts[i]];
      const swapped = picks.reduce((s, p, k) => s + p.chance * pts[k], 0);
      assert.ok(swapped <= expected + 1e-9);
    }
});

test("more games than 16 starts the points at the game count", () => {
  const many = Array.from({ length: 17 }, (_, i) => g(String(i), 0.5 + i / 40));
  assert.equal(rankConfidence(many).picks[0].points, 17);
});

test("the week runs Tuesday 12:00 UTC to Tuesday", () => {
  const sunday = weekWindow(new Date("2026-10-11T16:00:00Z"));
  assert.equal(new Date(sunday.start).toISOString(), "2026-10-06T12:00:00.000Z");
  const tuesdayMorning = weekWindow(new Date("2026-10-13T08:00:00Z"));
  assert.equal(new Date(tuesdayMorning.start).toISOString(), "2026-10-06T12:00:00.000Z");
  const tuesdayNoon = weekWindow(new Date("2026-10-13T13:00:00Z"));
  assert.equal(new Date(tuesdayNoon.start).toISOString(), "2026-10-13T12:00:00.000Z");
});

test("taking the underdog costs points x (fav - dog)", () => {
  const { picks } = rankConfidence([g("1", 0.55), g("2", 0.9)]);
  assert.ok(Math.abs(picks[1].flipCost - 15 * 0.1) < 1e-9, "55/45 at 15 points costs 1.5");
  assert.ok(Math.abs(picks[0].flipCost - 16 * 0.8) < 1e-9);
});

test("weekly win: one underdog beats copying a chalky field, but not on the lock", async () => {
  const { weeklyWin } = await import("./confidence.ts");
  const games = Array.from({ length: 14 }, (_, i) => g(String(i), 0.52 + i * 0.03, "2030-01-01T17:00:00Z"));
  const { picks } = rankConfidence(games);
  const res = weeklyWin(picks, { rivals: 9, sims: 6000, now: 0 });
  assert.ok(res.plain > 0.01 && res.plain < 0.4, `plain ${res.plain}`);
  const lock = res.flips.find((f) => f.pick.chance > 0.9)!;
  assert.ok(res.flips[0].win > res.plain, "one underdog beats copying a chalky field");
  assert.ok(lock.win < res.flips[0].win, "but not the 91% lock at 16 points");
  assert.equal(res.players, 10);
});

test("tiebreaker: the line, nudged toward the juice, plus the lean, rounded", async () => {
  const { tiebreakerTotal } = await import("./confidence.ts");
  const q = (price: number, opp: number, line = 46.5) =>
    ({ book: "X", market: "total", side: "over", line, price, oppositePrice: opp, stale: false }) as never;
  const flat = tiebreakerTotal([q(-110, -110)], { totalMean: 0, totalSd: 13 })!;
  assert.equal(flat.fair, 46.5);
  const juiced = tiebreakerTotal([q(-125, 105)], { totalMean: 0.6, totalSd: 13 })!;
  assert.ok(juiced.fair > 46.5, "over juiced: fair total above the number");
  assert.equal(juiced.guess, Math.round(juiced.fair + 0.6));
});
