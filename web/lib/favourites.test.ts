import assert from "node:assert/strict";
import { test } from "node:test";

import {
  betsAgainst,
  parseFavourites,
  serializeFavourites,
  teamTheme,
  themedTeams,
  themeFor,
} from "./favourites.ts";

test("the theme applies only to exactly one favourite", () => {
  // Two teams have no single colour, and picking the first would be arbitrary in a way
  // the interface could not explain.
  assert.ok(themeFor(["Detroit Lions"]));
  assert.equal(themeFor([]), null);
  assert.equal(themeFor(["Detroit Lions", "Green Bay Packers"]), null);
});

test("every themed team has both colours, and they are real hex", () => {
  for (const team of themedTeams()) {
    const t = teamTheme(team)!;
    assert.match(t.accent, /^#[0-9a-f]{6}$/i, team);
    assert.match(t.muted, /^#[0-9a-f]{6}$/i, team);
  }
});

test("no accent is so dark it would vanish on the app's background", () => {
  // The reason these are hand-picked rather than copied from brand guides: several real
  // team colours are near-black or near-white and would be unreadable here.
  const luminance = (hex: string) => {
    const n = parseInt(hex.slice(1), 16);
    const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => c / 255);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (const team of themedTeams()) {
    const l = luminance(teamTheme(team)!.accent);
    assert.ok(l > 0.2, `${team} accent is too dark to read on the dark ground (${l.toFixed(2)})`);
  }
});

test("all 32 NFL teams are covered, so nobody's pick is missing", () => {
  assert.equal(themedTeams().length, 32);
});

test("an unknown team has no theme rather than a guessed one", () => {
  assert.equal(teamTheme("Michigan Wolverines"), null);
  assert.equal(teamTheme(null), null);
});

test("favourites round-trip and are de-duplicated", () => {
  const raw = serializeFavourites(["Detroit Lions", "Detroit Lions", "Chicago Bears"]);
  assert.deepEqual(parseFavourites(raw), ["Detroit Lions", "Chicago Bears"]);
});

test("a hostile or empty payload yields no favourites rather than throwing", () => {
  for (const bad of [null, undefined, "", "not json", "{}", "5"]) {
    assert.deepEqual(parseFavourites(bad), [], JSON.stringify(bad));
  }
});

test("the list cannot grow without bound", () => {
  const many = serializeFavourites(Array.from({ length: 40 }, (_, i) => `Team ${i}`));
  assert.ok(parseFavourites(many).length <= 8);
});

// --- never against your own team -------------------------------------------------

const JETS_AT_LIONS = { homeTeam: "Detroit Lions", awayTeam: "New York Jets" };

test("the other side's spread and moneyline are against your team", () => {
  const lions = ["Detroit Lions"];
  assert.equal(
    betsAgainst({ ...JETS_AT_LIONS, market: "moneyline", side: "away" }, lions),
    "Detroit Lions",
  );
  assert.equal(
    betsAgainst({ ...JETS_AT_LIONS, market: "spread", side: "away" }, lions),
    "Detroit Lions",
  );
});

test("backing your own team is not against it", () => {
  const lions = ["Detroit Lions"];
  assert.equal(betsAgainst({ ...JETS_AT_LIONS, market: "moneyline", side: "home" }, lions), null);
  assert.equal(betsAgainst({ ...JETS_AT_LIONS, market: "spread", side: "home" }, lions), null);
});

test("a total picks no side, so it is never against anybody", () => {
  const lions = ["Detroit Lions"];
  assert.equal(betsAgainst({ ...JETS_AT_LIONS, market: "total", side: "over" }, lions), null);
  assert.equal(betsAgainst({ ...JETS_AT_LIONS, market: "total", side: "under" }, lions), null);
});

test("a game your team is not in is left alone", () => {
  assert.equal(
    betsAgainst(
      { homeTeam: "Buffalo Bills", awayTeam: "New York Jets", market: "moneyline", side: "away" },
      ["Detroit Lions"],
    ),
    null,
  );
});

test("with no teams chosen nothing is filtered", () => {
  assert.equal(betsAgainst({ ...JETS_AT_LIONS, market: "moneyline", side: "away" }, []), null);
});

test("with both teams chosen, every side bet on the game is against one of them", () => {
  const both = ["Detroit Lions", "New York Jets"];
  assert.ok(betsAgainst({ ...JETS_AT_LIONS, market: "moneyline", side: "home" }, both));
  assert.ok(betsAgainst({ ...JETS_AT_LIONS, market: "moneyline", side: "away" }, both));
});

test("names are matched without caring about case or stray spaces", () => {
  assert.equal(
    betsAgainst({ ...JETS_AT_LIONS, market: "moneyline", side: "away" }, [" detroit lions "]),
    " detroit lions ",
  );
});
