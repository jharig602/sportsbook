import assert from "node:assert/strict";
import { test } from "node:test";

import { boardGames, ledgerSections, LIVE_HOURS } from "./ordering.ts";
import type { Bet, GradedRow } from "./settle.ts";
import type { Game } from "./types.ts";

const NOW = new Date("2026-09-26T18:00:00Z");
const hoursFromNow = (h: number) => new Date(NOW.getTime() + h * 3_600_000).toISOString();

function game(id: string, h: number): Game {
  return { eventId: id, league: "ncaaf", commenceTime: hoursFromNow(h) } as Game;
}

test("the board keeps upcoming and live games, soonest first, and drops finished and old ones", () => {
  const games = [
    game("later", 5),
    game("soon", 1),
    game("live", -1),
    game("final", -2),
    game("weeks-old", -24 * 14),
    game("stuck", -(LIVE_HOURS + 1)), // no score recorded, but long over
  ];
  assert.deepEqual(
    boardGames(games, new Set(["final"]), NOW).map((g) => g.eventId),
    ["live", "soon", "later"],
  );
});

function row(id: string, outcome: GradedRow["outcome"], h: number, over: Partial<GradedRow> = {}): GradedRow {
  return { bet_id: id, event_id: id, outcome, commence_time: hoursFromNow(h), ...over } as GradedRow;
}

test("the ledger reads live, then soonest upcoming, then won, lost and the rest", () => {
  const rows = [
    row("up-late", "open", 20),
    row("won-old", "won", -48),
    row("live", "open", -1),
    row("lost", "lost", -3),
    row("up-soon", "open", 2),
    row("won-new", "won", -4),
    row("push", "push", -5),
    row("cashed", "cashed", -6),
  ];
  const s = ledgerSections(rows, new Map(), NOW);
  assert.deepEqual(s.live.map((r) => r.bet_id), ["live"]);
  assert.deepEqual(s.upcoming.map((r) => r.bet_id), ["up-soon", "up-late"]);
  assert.deepEqual(s.won.map((r) => r.bet_id), ["won-new", "won-old"]);
  assert.deepEqual(s.lost.map((r) => r.bet_id), ["lost"]);
  assert.deepEqual(s.other.map((r) => r.bet_id), ["push", "cashed"]);
});

test("a parlay is live once any leg has started, and upcoming ones sort by their next leg", () => {
  const legs = (first: number, second: number): Bet[] => [
    { bet_id: "a", event_id: "a", commence_time: hoursFromNow(first) } as Bet,
    { bet_id: "b", event_id: "b", commence_time: hoursFromNow(second) } as Bet,
  ];
  const started = row("p1", "open", -1, { parlay_id: "P1" });
  const future = row("p2", "open", 3, { parlay_id: "P2" });
  const single = row("s", "open", 1);
  const s = ledgerSections([future, started, single], new Map([["P1", legs(-1, 6)], ["P2", legs(3, 4)]]), NOW);
  assert.deepEqual(s.live.map((r) => r.bet_id), ["p1"]);
  assert.deepEqual(s.upcoming.map((r) => r.bet_id), ["s", "p2"]);
});
