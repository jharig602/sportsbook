import assert from "node:assert/strict";
import test from "node:test";

import { checkPrice, fairAmerican, groupProps, propFair, rungLabel, worthAt, type PropRow } from "./props.ts";

const row = (over: Partial<PropRow> = {}): PropRow => ({
  marketTicker: "KXNFLRECYDS-26OCT19WASSF-SFGKITTLE85-65",
  stat: "rec_yds",
  player: "George Kittle",
  teamSide: "home",
  line: 64.5,
  yesBid: 0.51,
  yesAsk: 0.52,
  bidSize: 3718,
  askSize: 216,
  volume: 61715,
  lastSeen: "2026-10-19T22:00:00.000Z",
  ...over,
});
const TAX = { rate: 0.2625, losses: "none" as const };

test("labels: lines read as N+, touchdown markets by kind", () => {
  assert.equal(rungLabel(row()), "65+");
  assert.equal(rungLabel(row({ stat: "first_td", line: null })), "1st TD");
  assert.equal(rungLabel(row({ stat: "anytime_td", line: null })), "Anytime");
});

test("fair chance is the midpoint, refused when thin", () => {
  assert.ok(Math.abs(propFair(row())! - 0.515) < 1e-12);
  assert.equal(propFair(row({ askSize: 50 })), null, "shallow");
  assert.equal(propFair(row({ yesBid: 0.4, yesAsk: 0.5 })), null, "wide");
});

test("fair American price", () => {
  assert.equal(fairAmerican(0.625), -167);
  assert.equal(fairAmerican(0.4), 150);
  assert.equal(fairAmerican(0.5), -100);
});

test("worthAt is where expected value after tax crosses zero", () => {
  for (const [p, boost] of [[0.515, 0], [0.3, 0.5], [0.7, 0.3]] as const) {
    const price = worthAt(p, TAX, boost)!;
    assert.ok(checkPrice(p, price, TAX, boost).after >= -1e-9, `at the threshold ${price}`);
    const worse = price - 5; // five cents worse for the bettor, either side of even
    assert.ok(checkPrice(p, worse, TAX, boost).after < 0, `just worse than ${price}`);
  }
  // A coin flip needs +136 to break even after a 26.25% tax with losses not deducted.
  assert.equal(worthAt(0.5, TAX), 136);
});

test("grouping: stat, then player, lowest line first", () => {
  const g = groupProps([row({ line: 74.5 }), row({ line: 54.5 }), row({ player: "Mike Evans", line: 59.5 })]);
  assert.deepEqual(g.get("rec_yds")!.get("George Kittle")!.map((r) => r.line), [54.5, 74.5]);
  assert.equal(g.get("rec_yds")!.size, 2);
});
