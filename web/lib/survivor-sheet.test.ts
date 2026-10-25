import { test } from "node:test";
import assert from "node:assert/strict";

import { updateSurvivorSheet } from "./mcp-write.ts";
import type { StoredPool } from "./pools.ts";
import { CROWD_PRIOR, entryUpdate, readSheet, teamFromSheet, type FinalGame } from "./survivor-sheet.ts";

// The pool's own key, as printed on the sheet, and the short forms used in pick cells.
const KEY: Record<string, string> = {
  "Da Bears": "Chicago Bears", Detroit: "Detroit Lions", "Green Bay": "Green Bay Packers", Minnesota: "Minnesota Vikings",
  Dallas: "Dallas Cowboys", NYGiants: "New York Giants", Philly: "Philadelphia Eagles", Washington: "Washington Commanders",
  Atlanta: "Atlanta Falcons", Carolina: "Carolina Panthers", NewOrleans: "New Orleans Saints", Tampa: "Tampa Bay Buccaneers",
  Arizona: "Arizona Cardinals", LARams: "Los Angeles Rams", "49ers": "San Francisco 49ers", Seattle: "Seattle Seahawks",
  Baltimore: "Baltimore Ravens", Cincinnati: "Cincinnati Bengals", Cleveland: "Cleveland Browns", Pittsburgh: "Pittsburgh Steelers",
  Buffalo: "Buffalo Bills", Miami: "Miami Dolphins", NewEngland: "New England Patriots", NYJets: "New York Jets",
  Houston: "Houston Texans", Indy: "Indianapolis Colts", Jacksonville: "Jacksonville Jaguars", Tennessee: "Tennessee Titans",
  Denver: "Denver Broncos", KansasCity: "Kansas City Chiefs", "Las Vegas Raiders": "Las Vegas Raiders", LAChargers: "Los Angeles Chargers",
  Minn: "Minnesota Vikings", Cleve: "Cleveland Browns", SF: "San Francisco 49ers", Jax: "Jacksonville Jaguars",
  Balt: "Baltimore Ravens", GB: "Green Bay Packers", LAC: "Los Angeles Chargers", KC: "Kansas City Chiefs", TB: "Tampa Bay Buccaneers", Sea: "Seattle Seahawks",
};

test("every spelling on the pool's sheets reads as the right team", () => {
  for (const [text, team] of Object.entries(KEY)) assert.equal(teamFromSheet(text), team, text);
  assert.equal(teamFromSheet("New York"), null); // two teams: never guessed
  assert.equal(teamFromSheet("LA"), null);
  assert.equal(teamFromSheet(""), null);
});

// Week 7 as the sheet showed it on 2026-10-25: 21 rows, Jake = me (Houston), Susan = ma (Minn).
const WEEK7 = [
  "Minn", "Houston", "Houston", "Cleve", "Houston", "Cleve", "Minn", "Houston", "SF", "Minn", "NYJets",
  "Minn", "Houston", "Minn", "Houston", "Denver", "NYJets", "Houston", "Houston", "Minn", "Houston",
].map((team, i) => ({ picks: { "7": team }, ...(i === 14 ? { who: "me" } : i === 13 ? { who: "ma" } : {}) }));

test("before the games are final, everyone is alive and the herding counts", () => {
  const sheet = readSheet(WEEK7, [], 1);
  assert.equal(sheet.week, 7);
  assert.deepEqual(sheet.field, [21, 0]);
  assert.deepEqual(sheet.own, { top: 9, picks: 21 });
  assert.deepEqual(sheet.weeks[0], { week: 7, team: "Houston Texans", count: 9, picks: 21 });
  const me = entryUpdate(sheet, "me")!;
  assert.deepEqual(me.used, ["Houston Texans"]);
  assert.equal(me.myLosses, 0);
  assert.deepEqual(me.crowd, { top: CROWD_PRIOR.top + 9, picks: CROWD_PRIOR.picks + 21 });
  // Rivals are everyone else alive: 20, with Houston one short of the 9 (Jake is not his own rival).
  const groups = me.rivals.groups;
  assert.equal(groups.reduce((a, g) => a + g.n, 0), 20);
  assert.equal(groups.find((g) => g.pick === "Houston Texans")?.n, 8);
  assert.equal(entryUpdate(sheet, "ma")!.rivals.groups.find((g) => g.pick === "Minnesota Vikings")?.n, 5);
});

const HOUSTON_LOSES: FinalGame[] = [
  { week: 7, home: "Houston Texans", away: "Seattle Seahawks", homeScore: 17, awayScore: 24 },
  { week: 7, home: "Minnesota Vikings", away: "Detroit Lions", homeScore: 20, awayScore: 20 },
  { week: 7, home: "Cleveland Browns", away: "Miami Dolphins", homeScore: 27, awayScore: 10 },
];

test("final scores decide losses, and a tie counts as one", () => {
  const sheet = readSheet(WEEK7, HOUSTON_LOSES, 1);
  // 9 Houston + 6 Minnesota (tie) lost; 2 Cleveland won; 4 still pending.
  assert.deepEqual(sheet.field, [6, 15]);
  const me = entryUpdate(sheet, "me")!;
  assert.equal(me.myLosses, 1);
  assert.equal(me.rivals.groups.filter((g) => g.losses === 1).reduce((a, g) => a + g.n, 0), 14);
  // A second strike is out: the row stops being anyone's rival.
  const week8 = WEEK7.map((r, i) => ({ ...r, picks: { ...r.picks, "8": i < 9 ? "Houston" : "KC" } }));
  const later = readSheet(week8, [...HOUSTON_LOSES, { week: 8, home: "Houston Texans", away: "Denver Broncos", homeScore: 3, awayScore: 9 }], 1);
  assert.ok(later.rows.some((r) => !r.alive));
  // The sheet's own stated losses win over the scores when given.
  const stated = readSheet([{ picks: { "7": "Houston" }, losses: 0 }, { picks: { "7": "Minn" } }], HOUSTON_LOSES, 1);
  assert.equal(stated.rows[0].losses, 0);
});

test("the tool previews, refuses unmarked or unreadable sheets, and saves both entries", async () => {
  const pools: StoredPool[] = [
    { name: "Me", used: ["Houston Texans"], size: 21, lossesAllowed: 1 },
    { name: "Ma", used: ["Minnesota Vikings"], size: 21, lossesAllowed: 1 },
  ];
  let saved: StoredPool[] | null = null;
  const deps = { pools, finals: [], savePools: async (p: StoredPool[]) => { saved = p; }, afterSave: async () => "Me: week 8 Kansas City." };

  const preview = await updateSurvivorSheet({ rows: WEEK7 }, deps);
  assert.match(preview.summary, /^PREVIEW, nothing saved\. Sheet through week 7: 21 entrants, 21 alive/);
  assert.match(preview.summary, /Me: 0 losses, week 7 Houston Texans \(not final\); Ma: 0 losses, week 7 Minnesota Vikings/);
  assert.equal(saved, null);

  await assert.rejects(updateSurvivorSheet({ rows: WEEK7.map(({ picks }) => ({ picks })) }, deps), /Mark which row is "Me"/);
  await assert.rejects(updateSurvivorSheet({ rows: [...WEEK7, { picks: { "7": "Gnats" } }] }, deps), /could not be read/);
  await assert.rejects(updateSurvivorSheet({ rows: WEEK7, confirm: true }, deps), /doesn't match a preview/);

  const done = await updateSurvivorSheet({ rows: WEEK7, confirm: true, preview_id: preview.data.preview_id as string }, deps);
  assert.match(done.summary, /^Saved\..*Me: week 8 Kansas City\.$/);
  const [me, ma] = saved!;
  assert.deepEqual(me.field, [21, 0]);
  assert.equal(me.size, 21);
  assert.equal(me.entered, 21);
  assert.deepEqual(me.crowd, { top: 29, picks: 65 });
  assert.deepEqual(ma.used, ["Minnesota Vikings"]);
  assert.equal(me.rivals?.week, 7);
});
