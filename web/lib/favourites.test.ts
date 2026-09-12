import assert from "node:assert/strict";
import { test } from "node:test";

import { parseFavourites, serializeFavourites, teamTheme, themedTeams, themeFor } from "./favourites.ts";

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
