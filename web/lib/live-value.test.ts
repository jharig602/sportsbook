import assert from "node:assert/strict";
import { test } from "node:test";

import type { ScoreModel } from "./joint-score.ts";
import { parseScoreboard } from "./live-scores.ts";
import { fractionLeft, liveChance, type LiveGame } from "./live-value.ts";
import { normalCdf } from "./probability.ts";
import type { Bet } from "./settle.ts";

const MODEL: ScoreModel = {
  league: "nfl", games: 2000, totalMean: 0, totalSd: 13.5, marginMean: 0, marginSd: 13.5, correlation: 0,
};
const PRE = { homeSpread: -6.5, total: 44.5 };

function live(over: Partial<LiveGame> = {}): LiveGame {
  return {
    eventId: "g", state: "in", period: 1, clockSeconds: 900, homeScore: 0, awayScore: 0,
    detail: "15:00 - 1st", homeAbbr: "DET", awayAbbr: "NYJ", ...over,
  };
}
function bet(over: Partial<Bet> = {}): Bet {
  return { event_id: "g", market: "spread", side: "home", line: -6.5, price: 109, stake: 25 , ...over } as Bet;
}
// normalCdf is an approximation good to ~1e-7, so exactness is asked to 1e-6.
const near = (a: number, b: number, tol = 1e-6) => Math.abs(a - b) < tol;

test("the clock: kickoff is all of it, halftime half, Q3 8:12 a little over a third", () => {
  assert.equal(fractionLeft(live()), 1);
  assert.equal(fractionLeft(live({ period: 2, clockSeconds: 0 })), 0.5);
  assert.ok(near(fractionLeft(live({ period: 3, clockSeconds: 492 })), (900 + 492) / 3600));
  assert.equal(fractionLeft(live({ state: "post" })), 0);
});

test("at kickoff it is exactly the pregame number", () => {
  // Home -6.5 at 0-0 with the whole game left: expected margin 6.5, so covering is a coin flip.
  assert.ok(near(liveChance(bet(), live(), PRE, MODEL)!, 0.5));
  // Moneyline: P(margin > 0.5) with mean 6.5, sd 13.5.
  assert.ok(near(liveChance(bet({ market: "moneyline", line: null }), live(), PRE, MODEL)!, 1 - normalCdf((0.5 - 6.5) / 13.5)));
});

test("a two-score lead late makes the favourite's cover close to certain, and the dog's hopeless", () => {
  const late = live({ period: 4, clockSeconds: 120, homeScore: 24, awayScore: 10 });
  assert.ok(liveChance(bet(), late, PRE, MODEL)! > 0.95);
  assert.ok(liveChance(bet({ side: "away", line: 6.5 }), late, PRE, MODEL)! < 0.05);
});

test("the two sides of one spread add to one", () => {
  const g = live({ period: 3, clockSeconds: 300, homeScore: 17, awayScore: 13 });
  const home = liveChance(bet(), g, PRE, MODEL)!;
  const away = liveChance(bet({ side: "away", line: 6.5 }), g, PRE, MODEL)!;
  assert.ok(near(home + away, 1));
});

test("a total already racing toward the line favours the over", () => {
  const fast = live({ period: 2, clockSeconds: 0, homeScore: 21, awayScore: 17 }); // 38 at half
  const over = liveChance(bet({ market: "total", side: "over", line: 44.5 }), fast, PRE, MODEL)!;
  assert.ok(over > 0.85, `got ${over}`);
});

test("what it cannot price it refuses: team totals, no line, no model, not started", () => {
  assert.equal(liveChance(bet({ market: "total", side: "over", line: 24.5, team: "home" }), live(), PRE, MODEL), null);
  assert.equal(liveChance(bet(), live(), { homeSpread: null, total: null }, MODEL), null);
  assert.equal(liveChance(bet(), live(), PRE, null), null);
  assert.equal(liveChance(bet(), live({ state: "pre" }), PRE, MODEL), null);
});

test("the scoreboard parser reads ESPN's shape and skips what it cannot read", () => {
  const games = parseScoreboard({
    events: [
      {
        id: "401",
        competitions: [{
          status: { period: 3, clock: 492, type: { state: "in", shortDetail: "8:12 - 3rd" } },
          competitors: [
            { homeAway: "home", score: "17", team: { abbreviation: "DET" } },
            { homeAway: "away", score: "10", team: { abbreviation: "NYJ" } },
          ],
        }],
      },
      { id: "402", competitions: [{ status: { type: { state: "in" } }, competitors: [] }] },
      { id: "403", competitions: [{ status: { type: { state: "weird" } } }] },
    ],
  });
  assert.equal(games.length, 1);
  assert.deepEqual(
    { ...games[0] },
    { eventId: "401", state: "in", period: 3, clockSeconds: 492, homeScore: 17, awayScore: 10,
      detail: "8:12 - 3rd", homeAbbr: "DET", awayAbbr: "NYJ" },
  );
  assert.deepEqual(parseScoreboard(null), []);
});
