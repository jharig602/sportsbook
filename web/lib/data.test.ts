/**
 * Backend-parity tests.
 *
 * The two data backends must return identical shapes. They did not: `pg` hands back
 * Date objects and BIGINT strings, while the JSON fixture hands back ISO strings and
 * numbers. That divergence took /movers down in production while every local page
 * worked, because a JSON fixture cannot reproduce it. These tests can.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { collapseAlerts, normalizeRow } from "./rows.ts";

test("Date columns become ISO strings, like the fixture's", () => {
  const row = normalizeRow<{ created_at: string }>({
    created_at: new Date("2026-09-12T16:00:00Z"),
  });
  assert.equal(typeof row.created_at, "string");
  assert.equal(row.created_at, "2026-09-12T16:00:00.000Z");
});

test("BIGINT columns come back as numbers, not strings", () => {
  // node-postgres returns int8 as a string to avoid precision loss.
  const row = normalizeRow<Record<string, number>>({
    price: "-110",
    price_at_alert: "150",
    closing_price: "-2100",
  });
  assert.equal(row.price, -110);
  assert.equal(row.price_at_alert, 150);
  assert.equal(row.closing_price, -2100);
});

test("null and non-BIGINT values pass through untouched", () => {
  const row = normalizeRow<Record<string, unknown>>({
    price: null,
    magnitude: 2.5,
    message: "Line moved 54.5 to 56.5",
    league: "ncaaf",
    result_push: false,
  });
  assert.equal(row.price, null);
  assert.equal(row.magnitude, 2.5);
  assert.equal(row.message, "Line moved 54.5 to 56.5");
  assert.equal(row.result_push, false);
});

test("a string that is not a number becomes null rather than NaN", () => {
  const row = normalizeRow<Record<string, unknown>>({ price: "not-a-price" });
  assert.equal(row.price, null);
});

test("string columns that merely look numeric are left alone", () => {
  // event_id is a VARCHAR of digits. Coercing it would break every join and lookup.
  const row = normalizeRow<Record<string, unknown>>({ event_id: "401856782" });
  assert.equal(row.event_id, "401856782");
  assert.equal(typeof row.event_id, "string");
});

test("collapseAlerts survives normalised postgres rows", () => {
  // The exact failure: created_at as a Date has no localeCompare, so sorting threw
  // and the whole page 500'd.
  const raw = [
    { created_at: new Date("2026-09-12T10:00:00Z"), move_strength: 60 },
    { created_at: new Date("2026-09-12T11:00:00Z"), move_strength: 60 },
  ].map((r) =>
    normalizeRow<Record<string, unknown>>({
      ...r,
      event_id: "E1",
      market: "spread",
      kind: "steam",
      predicted_side: "home",
    }),
  );

  // Two alerts with different timestamps are distinct, and sorting must not throw.
  const collapsed = collapseAlerts(raw as never);
  assert.equal(collapsed.length, 2);
});

test("collapseAlerts merges rows describing the same move", () => {
  const shared = {
    event_id: "E1",
    market: "total",
    kind: "steam",
    predicted_side: "over",
    created_at: "2026-09-12T10:00:00.000Z",
  };
  const collapsed = collapseAlerts([
    { ...shared, move_strength: 40 },
    { ...shared, move_strength: 70 },
  ] as never);
  assert.equal(collapsed.length, 1);
  assert.equal(collapsed[0].move_strength, 70);
});

test("opening prices collapse to one card per game", () => {
  // One game posting its numbers fires per market and per side. Six alerts describing
  // a single event should read as one finding, not six.
  const shared = {
    event_id: "E1",
    kind: "first_price",
    created_at: "2026-09-12T10:00:00.000Z",
    move_strength: 87,
  };
  const raw = [
    { ...shared, market: "spread", predicted_side: "home" },
    { ...shared, market: "spread", predicted_side: "away" },
    { ...shared, market: "total", predicted_side: "over" },
    { ...shared, market: "total", predicted_side: "under" },
    { ...shared, market: "moneyline", predicted_side: "home" },
    { ...shared, market: "moneyline", predicted_side: "away" },
  ];
  assert.equal(collapseAlerts(raw as never).length, 1);
});

test("movement alerts stay split by market", () => {
  // A spread moving and a total moving are two separate pieces of information.
  const shared = {
    event_id: "E1",
    kind: "steam",
    predicted_side: "home",
    created_at: "2026-09-12T10:00:00.000Z",
    move_strength: 60,
  };
  const raw = [
    { ...shared, market: "spread" },
    { ...shared, market: "total" },
  ];
  assert.equal(collapseAlerts(raw as never).length, 2);
});

test("opening prices on different games stay separate", () => {
  const shared = {
    kind: "first_price",
    market: "spread",
    predicted_side: "home",
    created_at: "2026-09-12T10:00:00.000Z",
    move_strength: 87,
  };
  const raw = [
    { ...shared, event_id: "E1" },
    { ...shared, event_id: "E2" },
  ];
  assert.equal(collapseAlerts(raw as never).length, 2);
});
