import assert from "node:assert/strict";
import { test } from "node:test";

import { parsePins, serializePins, withPin } from "./pins.ts";

test("a round trip through the URL preserves the pins", () => {
  const pins = new Map([
    [1, "Philadelphia Eagles"],
    [5, "Detroit Lions"],
  ]);
  assert.deepEqual(parsePins(serializePins(pins)), pins);
});

test("pins are serialised in week order whatever order they were set in", () => {
  // So the same set of pins always produces the same URL, and the browser treats
  // re-selecting the same thing as the same page.
  const a = withPin(withPin(new Map(), 9, "Chicago Bears"), 2, "Denver Broncos");
  const b = withPin(withPin(new Map(), 2, "Denver Broncos"), 9, "Chicago Bears");
  assert.equal(serializePins(a), serializePins(b));
  assert.equal(serializePins(a), "2:Denver Broncos,9:Chicago Bears");
});

test("team names with spaces survive", () => {
  assert.deepEqual(parsePins("12:Tampa Bay Buccaneers"), new Map([[12, "Tampa Bay Buccaneers"]]));
});

test("nothing at all parses to no pins rather than throwing", () => {
  for (const input of [undefined, null, "", ",", ":", "abc", "0:Team", "x:Team"]) {
    assert.equal(parsePins(input).size, 0, `input ${JSON.stringify(input)}`);
  }
});

test("a malformed pair is dropped, not guessed at, and the rest still parse", () => {
  // Half a URL is not a reason to lose the other half, and it is certainly not a
  // reason to invent a week number.
  const pins = parsePins("1:Philadelphia Eagles,nonsense,99:Too Late,4:Detroit Lions");
  assert.deepEqual(pins, new Map([[1, "Philadelphia Eagles"], [4, "Detroit Lions"]]));
});

test("a repeated week keeps the first, so a doubled parameter cannot shuffle the answer", () => {
  assert.deepEqual(parsePins("3:Denver Broncos,3:Chicago Bears"), new Map([[3, "Denver Broncos"]]));
});

test("a repeated query parameter is read as more pairs", () => {
  // Next hands back an array when the same parameter appears twice.
  assert.deepEqual(
    parsePins(["1:Philadelphia Eagles", "5:Detroit Lions"]),
    new Map([[1, "Philadelphia Eagles"], [5, "Detroit Lions"]]),
  );
});

test("a hostile URL cannot grow the plan without bound", () => {
  const many = Array.from({ length: 400 }, (_, i) => `${(i % 30) + 1}:Team${i}`).join(",");
  assert.ok(parsePins(many).size <= 18);
  const long = parsePins(`1:${"x".repeat(500)}`);
  assert.equal(long.get(1)!.length, 60);
});

test("setting and clearing one week leaves the others alone", () => {
  const pins = new Map([[1, "A"], [2, "B"]]);
  assert.deepEqual(withPin(pins, 2, "C"), new Map([[1, "A"], [2, "C"]]));
  assert.deepEqual(withPin(pins, 2, null), new Map([[1, "A"]]));
  // And the original is untouched: the page re-renders from it.
  assert.deepEqual(pins, new Map([[1, "A"], [2, "B"]]));
});
