/**
 * Favourite-team push timing.
 *
 * The scheduler delivers runs at arbitrary minutes, so the cases that matter are the ones
 * where a run lands at an awkward moment: after kickoff, too early, twice, or for a game
 * the team is not in.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAVOURITE_WINDOW_HOURS,
  describeCost,
  dueFavouriteGames,
  favouriteKey,
} from "./favourite-push.ts";
import type { Game } from "./types.ts";

const NOW = new Date("2026-09-26T15:00:00Z"); // Saturday morning Central

function game(over: Partial<Game> = {}): Game {
  return {
    eventId: "G1",
    league: "nfl",
    commenceTime: "2026-09-27T17:00:00Z", // Sunday 1 PM Eastern, 26 hours away
    homeTeam: "Detroit Lions",
    awayTeam: "New York Jets",
    homeTeamId: null,
    awayTeamId: null,
    lastObserved: "2026-09-26T14:00:00Z",
    spread: {},
    total: {},
    moneyline: {},
    ...over,
  };
}

test("your team's game inside the window is due", () => {
  const due = dueFavouriteGames([game()], ["Detroit Lions"], NOW, new Set());
  assert.equal(due.length, 1);
  assert.equal(due[0].team, "Detroit Lions");
  assert.equal(due[0].opponent, "New York Jets");
  assert.equal(due[0].home, true);
});

test("an away game names the side correctly", () => {
  const due = dueFavouriteGames(
    [game({ homeTeam: "Green Bay Packers", awayTeam: "Detroit Lions" })],
    ["Detroit Lions"],
    NOW,
    new Set(),
  );
  assert.equal(due[0].home, false);
  assert.equal(due[0].opponent, "Green Bay Packers");
});

test("a game already under way is never announced", () => {
  // A message about which price to take is worthless once the prices have gone.
  const started = game({ commenceTime: "2026-09-26T14:00:00Z" });
  assert.deepEqual(dueFavouriteGames([started], ["Detroit Lions"], NOW, new Set()), []);
});

test("a game too far off waits, because its lines are still moving", () => {
  const nextWeek = game({ commenceTime: "2026-10-04T17:00:00Z" });
  assert.deepEqual(dueFavouriteGames([nextWeek], ["Detroit Lions"], NOW, new Set()), []);
});

test("the window edge is inclusive of the full window and nothing beyond", () => {
  const at = (hours: number) =>
    game({ commenceTime: new Date(NOW.getTime() + hours * 3_600_000).toISOString() });
  assert.equal(
    dueFavouriteGames([at(FAVOURITE_WINDOW_HOURS)], ["Detroit Lions"], NOW, new Set()).length,
    1,
  );
  assert.equal(
    dueFavouriteGames([at(FAVOURITE_WINDOW_HOURS + 0.1)], ["Detroit Lions"], NOW, new Set()).length,
    0,
  );
});

test("a game announced once is never announced again", () => {
  // Every collector run offers; only the first inside the window may send.
  const sent = new Set([favouriteKey("G1", "Detroit Lions")]);
  assert.deepEqual(dueFavouriteGames([game()], ["Detroit Lions"], NOW, sent), []);
});

test("games your team is not in are ignored", () => {
  const other = game({ homeTeam: "Buffalo Bills", awayTeam: "Miami Dolphins" });
  assert.deepEqual(dueFavouriteGames([other], ["Detroit Lions"], NOW, new Set()), []);
});

test("no teams chosen means nothing is ever due", () => {
  assert.deepEqual(dueFavouriteGames([game()], [], NOW, new Set()), []);
});

test("names match without caring about case or stray spaces", () => {
  assert.equal(dueFavouriteGames([game()], [" detroit lions "], NOW, new Set()).length, 1);
});

test("the cost is said in cents, the unit the choice is made in", () => {
  assert.equal(describeCost(-0.023), "costs about 2¢ per $1 in vig");
  assert.equal(describeCost(-0.004), "costs about 0.4¢ per $1 in vig");
  assert.equal(describeCost(0.012), "+1.2% expected");
});
