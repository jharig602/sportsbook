import { test } from "node:test";
import assert from "node:assert/strict";

import { logBet, recordCashOut, resolveGame, WriteInputError, type WriteDeps } from "./mcp-write.ts";
import type { Bet } from "./settle.ts";
import type { Game, Promo, PromoUse } from "./types.ts";

const NOW = new Date("2026-10-25T18:00:00Z");
const game = (id: string, away: string, home: string, at: string): Game => ({
  eventId: id,
  league: "nfl",
  commenceTime: at,
  homeTeam: home,
  awayTeam: away,
  homeTeamId: null,
  awayTeamId: null,
  lastObserved: "2026-10-25T17:58:00Z",
  spread: { home: { line: -2.5, price: -110 }, away: { line: 2.5, price: -110 } },
  total: { over: { line: 47.5, price: -110 }, under: { line: 47.5, price: -110 } },
  moneyline: { home: { line: null, price: -140 }, away: { line: null, price: 120 } },
});
const GAMES = [
  game("g1", "Green Bay Packers", "Detroit Lions", "2026-10-25T20:25:00Z"),
  game("g2", "Chicago Bears", "Minnesota Vikings", "2026-10-26T00:20:00Z"),
  game("old", "Green Bay Packers", "Detroit Lions", "2026-09-10T00:20:00Z"),
];
const PROMO: Promo = {
  promo_id: "p1", book: "FanDuel", type: "profit_boost", title: "30% profit boost", claimed_at: null,
  expires_at: "2026-10-27T00:00:00Z", cap_refund: null, max_stake: 25, boost_pct: 30, bonus_face: null,
  boosted_price: null, base_price: null, deposit_bonus: null, rollover_multiple: null, min_odds_american: -200,
  min_legs: null, eligible_markets: [], eligible_from: null, eligible_to: null, excluded: [], stackable: false,
  status: "available", created_at: "2026-10-20T00:00:00Z",
};

function deps(bets: Bet[] = [], extra: Partial<WriteDeps> = {}) {
  const saved: Bet[][] = [];
  const uses: PromoUse[] = [];
  const results: Array<[string, string]> = [];
  let n = 0;
  const d: WriteDeps = {
    games: GAMES,
    lines: new Map(),
    models: {},
    bets,
    promos: [PROMO, { ...PROMO, promo_id: "b1", type: "bonus_bet", title: "$10 bonus bet", bonus_face: 10, max_stake: null, min_odds_american: null }],
    finals: new Set(),
    saveBet: async (bet) => { saved.push([bet]); },
    saveParlay: async (rows) => { saved.push(rows); },
    recordUse: async (use) => { uses.push(use); },
    recordLegResult: async (id, r) => { results.push([id, r]); },
    newId: () => `id${++n}`,
    ...extra,
  };
  return { d, saved, uses, results };
}

const ML = { book: "FanDuel", stake: 25, price: -140, legs: [{ game: "Lions", market: "moneyline" as const, pick: "Detroit Lions" }] };

test("games are found by team, only near today, and never guessed", () => {
  assert.equal(resolveGame(GAMES, "Lions", NOW).eventId, "g1");
  assert.equal(resolveGame(GAMES, "detroit lions", NOW).eventId, "g1");
  assert.equal(resolveGame(GAMES, "old", NOW).eventId, "old"); // an exact game_id always works
  assert.throws(() => resolveGame(GAMES, "Steelers", NOW), WriteInputError);
  const twice = [...GAMES, game("g3", "Detroit Lions", "Chicago Bears", "2026-11-01T17:00:00Z")];
  assert.throws(() => resolveGame(twice, "Lions", NOW), /fits 2 games/);
});

test("log_bet previews first, saves nothing, and confirms only the previewed bet", async () => {
  const { d, saved } = deps();
  const preview = await logBet(ML, NOW, d);
  assert.match(preview.summary, /^PREVIEW, nothing saved\. FanDuel: \$25\.00 on Detroit Lions ML -140/);
  assert.equal(saved.length, 0);
  const id = preview.data.preview_id as string;

  await assert.rejects(logBet({ ...ML, confirm: true }, NOW, d), /doesn't match a preview/);
  await assert.rejects(logBet({ ...ML, stake: 30, confirm: true, preview_id: id }, NOW, d), /doesn't match a preview/);
  assert.equal(saved.length, 0);

  const done = await logBet({ ...ML, confirm: true, preview_id: id }, NOW, d);
  assert.match(done.summary, /^Logged\./);
  assert.equal(saved.length, 1);
  const bet = saved[0][0];
  assert.equal(bet.event_id, "g1");
  assert.equal(bet.side, "home");
  assert.equal(bet.market, "moneyline");
  assert.equal(bet.line, null);
  assert.equal(bet.price, -140);
  assert.equal(bet.home_team, "Detroit Lions");
  assert.equal(bet.bonus, false);
});

test("a spread on the away team keeps its own line; a team total names whose points", async () => {
  const { d, saved } = deps();
  const input = { book: "BetMGM", stake: 10, price: -110, legs: [{ game: "Packers", market: "spread" as const, pick: "Packers", line: 2.5 }] };
  const p = await logBet(input, NOW, d);
  await logBet({ ...input, confirm: true, preview_id: p.data.preview_id as string }, NOW, d);
  assert.equal(saved[0][0].side, "away");
  assert.equal(saved[0][0].line, 2.5);
  const tt = { book: "BetMGM", stake: 10, price: -115, legs: [{ game: "Lions", market: "total" as const, pick: "over", line: 24.5, team_total: "Lions" }] };
  const q = await logBet(tt, NOW, d);
  await logBet({ ...tt, confirm: true, preview_id: q.data.preview_id as string }, NOW, d);
  assert.equal(saved[1][0].team, "home");
  await assert.rejects(logBet({ ...ML, legs: [{ game: "Lions", market: "moneyline", pick: "Bears" }] }, NOW, d), /say which team/);
});

test("a same-game parlay with a prop logs every leg under one ticket", async () => {
  const { d, saved } = deps();
  const sgp = {
    book: "BetRivers",
    stake: 25,
    price: 195,
    legs: [
      { game: "Lions", market: "prop" as const, player: "Jared Goff", stat: "pass_yds", line: 274.5 },
      { game: "Lions", market: "moneyline" as const, pick: "Lions" },
      { game: "Lions", market: "prop" as const, player: "Jahmyr Gibbs", stat: "anytime_td" },
    ],
  };
  const p = await logBet(sgp, NOW, d);
  assert.match(p.summary, /3-leg parlay at \+195: Jared Goff 275\+ pass yds .*Detroit Lions ML.*Jahmyr Gibbs anytime TD/);
  await logBet({ ...sgp, confirm: true, preview_id: p.data.preview_id as string }, NOW, d);
  const rows = saved[0];
  assert.equal(rows.length, 3);
  assert.equal(new Set(rows.map((r) => r.parlay_id)).size, 1);
  assert.equal(rows[2].line, 0.5);
  assert.equal(rows[2].side, "over");
  assert.ok(rows.every((r) => r.parlay_price === 195 && r.book === "BetRivers"));
});

test("the same bet twice inside ten minutes is refused", async () => {
  const existing: Bet = {
    bet_id: "x1", placed_at: "2026-10-25T17:55:00Z", league: "nfl", event_id: "g1", home_team: "Detroit Lions",
    away_team: "Green Bay Packers", commence_time: "2026-10-25T20:25:00Z", market: "moneyline", side: "home", line: null,
    price: -140, stake: 25, book: "FanDuel", model_probability: null, market_probability: null, rule_version_id: null,
    note: null, supersedes: null,
  };
  const { d } = deps([existing]);
  await assert.rejects(logBet(ML, NOW, d), /logged in the last 10 minutes/);
  const later = deps([{ ...existing, placed_at: "2026-10-25T17:00:00Z" }]);
  assert.match((await logBet(ML, NOW, later.d)).summary, /^PREVIEW/);
});

test("a promo is checked against the bet and marked used when it is saved", async () => {
  const { d, uses, saved } = deps();
  const boosted = { ...ML, price: -108, promo_id: "p1" };
  const p = await logBet(boosted, NOW, d);
  assert.match(p.summary, /"30% profit boost" will be marked used/);
  await logBet({ ...boosted, confirm: true, preview_id: p.data.preview_id as string }, NOW, d);
  assert.equal(uses.length, 1);
  assert.equal(uses[0].promo_id, "p1");
  assert.equal(uses[0].bet_id, saved[0][0].bet_id);
  assert.equal(uses[0].odds_american, -108);
  await assert.rejects(logBet({ ...boosted, book: "BetMGM" }, NOW, d), /is a FanDuel promo/);
  const over = await logBet({ ...boosted, stake: 50 }, NOW, d);
  assert.match(over.summary, /over the token's \$25 maximum/);
  // A bonus-bet token always logs as a bonus bet.
  const free = { ...ML, stake: 10, price: 150, legs: [{ game: "Lions", market: "moneyline" as const, pick: "Packers" }], promo_id: "b1" };
  const fp = await logBet(free, NOW, d);
  assert.match(fp.summary, /\$10\.00 bonus bet/);
  await logBet({ ...free, confirm: true, preview_id: fp.data.preview_id as string }, NOW, d);
  assert.equal(saved[1][0].bonus, true);
});

function leg(id: string, extra: Partial<Bet> = {}): Bet {
  return {
    bet_id: id, placed_at: "2026-10-25T16:00:00Z", league: "nfl", event_id: "g1", home_team: "Detroit Lions",
    away_team: "Green Bay Packers", commence_time: "2026-10-25T20:25:00Z", market: "moneyline", side: "home", line: null,
    price: -140, stake: 25, book: "FanDuel", model_probability: null, market_probability: null, rule_version_id: null,
    note: null, supersedes: null, ...extra,
  };
}

test("a cash-out supersedes the ticket with the cash received, after a preview", async () => {
  const { d, saved } = deps([leg("t1")], { holdValue: async () => ({ chance: 0.6, value: 25.71 }) });
  const p = await recordCashOut({ ticket_id: "t1", amount: 30 }, NOW, d);
  assert.match(p.summary, /^PREVIEW.*for \$30\.00: \+\$5\.00\. Holding is worth about \$25\.71/);
  assert.equal(saved.length, 0);
  await recordCashOut({ ticket_id: "t1", amount: 30, confirm: true, preview_id: p.data.preview_id as string }, NOW, d);
  assert.equal(saved[0].length, 1);
  assert.equal(saved[0][0].supersedes, "t1");
  assert.equal(saved[0][0].cashout, 30);
  assert.notEqual(saved[0][0].bet_id, "t1");
  await assert.rejects(recordCashOut({ ticket_id: "t1", amount: 500 }, NOW, d), /more than the ticket could ever pay/);
  await assert.rejects(recordCashOut({ ticket_id: "nope", amount: 5 }, NOW, d), /No open ticket/);
  const settled = deps([leg("t1")], { finals: new Set(["g1"]) });
  await assert.rejects(recordCashOut({ ticket_id: "t1", amount: 5 }, NOW, settled.d), /settled on the score/);
});

test("a parlay is cashed out as one ticket, every leg in one write, prop results kept", async () => {
  const legs = [
    leg("a", { parlay_id: "P", parlay_price: 300, price: null }),
    leg("b", { parlay_id: "P", parlay_price: 300, price: null, market: "prop", side: "over", line: 0.5, prop_player: "Jahmyr Gibbs", prop_stat: "anytime_td", prop_result: "won" }),
  ];
  const { d, saved, results } = deps(legs);
  const p = await recordCashOut({ ticket_id: "a", amount: 60 }, NOW, d);
  await recordCashOut({ ticket_id: "a", amount: 60, confirm: true, preview_id: p.data.preview_id as string }, NOW, d);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].length, 2);
  assert.ok(saved[0].every((r) => r.parlay_id === "P" && r.cashout === 60));
  assert.deepEqual(saved[0].map((r) => r.supersedes), ["a", "b"]);
  assert.equal(saved[0][1].prop_result, undefined);
  assert.deepEqual(results, [[saved[0][1].bet_id, "won"]]);
});

test("edit_bet fixes a parlay's book on every leg at once, after a preview", async () => {
  const { editBet } = await import("./mcp-write.ts");
  const legs = [
    leg("a", { parlay_id: "P", parlay_price: 195, price: null }),
    leg("b", { parlay_id: "P", parlay_price: 195, price: null, market: "prop", side: "over", line: 0.5, prop_player: "Jahmyr Gibbs", prop_stat: "anytime_td", prop_result: "won" }),
  ];
  const { d, saved, results } = deps(legs);
  const p = await editBet({ ticket_id: "a", book: "BetRivers" }, NOW, d);
  assert.match(p.summary, /^PREVIEW.*Correct FanDuel 2-leg parlay .*: book FanDuel → BetRivers\./);
  assert.equal(saved.length, 0);
  await assert.rejects(editBet({ ticket_id: "a", book: "BetRivers", confirm: true }, NOW, d), /doesn't match a preview/);
  await editBet({ ticket_id: "a", book: "BetRivers", confirm: true, preview_id: p.data.preview_id as string }, NOW, d);
  assert.equal(saved.length, 1);
  assert.equal(saved[0].length, 2);
  assert.ok(saved[0].every((r) => r.book === "BetRivers" && r.parlay_id === "P" && r.parlay_price === 195 && r.voided === false));
  assert.deepEqual(saved[0].map((r) => r.supersedes), ["a", "b"]);
  assert.deepEqual(results, [[saved[0][1].bet_id, "won"]]);
});

test("edit_bet changes a single's price and stake, removes a ticket, and refuses no-ops", async () => {
  const { editBet } = await import("./mcp-write.ts");
  const { d, saved } = deps([leg("t1")]);
  const p = await editBet({ ticket_id: "t1", price: -135, stake: 20 }, NOW, d);
  assert.match(p.summary, /stake \$25\.00 → \$20\.00, price -140 → -135/);
  await editBet({ ticket_id: "t1", price: -135, stake: 20, confirm: true, preview_id: p.data.preview_id as string }, NOW, d);
  assert.equal(saved[0][0].price, -135);
  assert.equal(saved[0][0].stake, 20);
  assert.equal(saved[0][0].supersedes, "t1");

  const r = await editBet({ ticket_id: "t1", remove: true }, NOW, d);
  assert.match(r.summary, /Remove FanDuel Detroit Lions ML/);
  await editBet({ ticket_id: "t1", remove: true, confirm: true, preview_id: r.data.preview_id as string }, NOW, d);
  assert.equal(saved[1][0].voided, true);
  assert.equal(saved[1][0].supersedes, "t1");

  await assert.rejects(editBet({ ticket_id: "t1", book: "FanDuel" }, NOW, d), /Nothing to change/);
  await assert.rejects(editBet({ ticket_id: "t1", price: 50 }, NOW, d), /American odds/);
  await assert.rejects(editBet({ ticket_id: "zzz", remove: true }, NOW, d), /No ticket/);
});
