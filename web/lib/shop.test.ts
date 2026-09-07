import assert from "node:assert/strict";
import { test } from "node:test";

import {
  expectedRoi,
  median,
  orientedLine,
  pointsToProbability,
  shopAll,
  shopSide,
  type BookQuote,
} from "./shop.ts";
import type { MarginModel } from "./probability.ts";

const NFL: MarginModel = { league: "nfl", games: 291, mean: 0.35, sd: 12.32, pmf: {} };
const CFB: MarginModel = { league: "ncaaf", games: 976, mean: 1.4, sd: 15.14, pmf: {} };

function quote(book: string, line: number | null, price = -110): BookQuote {
  return { book, market: "spread", side: "home", line, price, oppositePrice: -110 };
}

test("median handles both parities", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 2.5);
  assert.equal(median([]), null);
});

test("a point of line is worth about 3.2 points in the NFL and 2.6 in college", () => {
  assert.ok(Math.abs(pointsToProbability(NFL) * 100 - 3.24) < 0.02);
  assert.ok(Math.abs(pointsToProbability(CFB) * 100 - 2.64) < 0.02);
});

test("larger oriented line is better for whoever holds it", () => {
  // A home dog would rather have +3 than +2.5, and a home favourite would rather lay
  // -2.5 than -3. Both are just "bigger number", so the spread needs no flip.
  assert.ok(orientedLine("spread", "home", 3) > orientedLine("spread", "home", 2.5));
  assert.ok(orientedLine("spread", "home", -2.5) > orientedLine("spread", "home", -3));
  // The over wants the smallest total it can get; the under wants the largest.
  assert.ok(orientedLine("total", "over", 44) > orientedLine("total", "over", 44.5));
  assert.ok(orientedLine("total", "under", 44.5) > orientedLine("total", "under", 44));
});

test("the whole point: a one-point gap clears the vig, a half-point does not", () => {
  // Three books at -3, one outlier at -2. The outlier is a full point better.
  const [outlier] = shopSide(
    [quote("Outlier", -2), quote("A", -3), quote("B", -3), quote("C", -3)],
    NFL,
  ).filter((r) => r.book === "Outlier");

  assert.equal(outlier.consensusLine, -3);
  assert.equal(outlier.advantagePoints, 1);
  // 50% + 3.24pp of edge, against the 52.4% that -110 demands.
  assert.ok(outlier.fairProbability! > 0.532 && outlier.fairProbability! < 0.533);
  assert.ok(outlier.breakEven! > 0.523 && outlier.breakEven! < 0.525);
  assert.ok(outlier.expectedRoi! > 0, "a full point should beat -110");

  const [half] = shopSide(
    [quote("Outlier", -2.5), quote("A", -3), quote("B", -3), quote("C", -3)],
    NFL,
  ).filter((r) => r.book === "Outlier");
  assert.equal(half.advantagePoints, 0.5);
  assert.ok(half.expectedRoi! < 0, "half a point is real but does not cover the hold");
});

test("the books that match consensus price out at the hold, not at zero", () => {
  const rows = shopSide([quote("A", -3), quote("B", -3), quote("C", -3)], NFL);
  for (const row of rows) {
    assert.equal(row.advantagePoints, 0);
    assert.equal(row.fairProbability, 0.5);
    // A coin flip at -110 loses 4.5 cents on the dollar. That is the vig, and it is
    // the correct answer for a board with no disagreement on it.
    assert.ok(Math.abs(row.expectedRoi! + 0.0454) < 0.001);
  }
});

test("consensus is leave-one-out, so an outlier cannot pull its own reference", () => {
  // With only two books, including yourself would put the consensus at the midpoint
  // and halve every gap. Each side must see the other's number, undiluted.
  const rows = shopSide([quote("A", -2), quote("B", -3)], NFL);
  assert.equal(rows.find((r) => r.book === "A")!.consensusLine, -3);
  assert.equal(rows.find((r) => r.book === "B")!.consensusLine, -2);
  assert.equal(rows.find((r) => r.book === "A")!.advantagePoints, 1);
  assert.equal(rows.find((r) => r.book === "B")!.advantagePoints, -1);
});

test("the median ignores a single broken book", () => {
  const rows = shopSide(
    [quote("A", -3), quote("B", -3), quote("C", -3), quote("Broken", 40)],
    NFL,
  );
  // A's reference is the median of (-3, -3, 40), which is -3 — not the -11.3 a mean
  // would have produced, and not a manufactured 8-point "edge".
  assert.equal(rows.find((r) => r.book === "A")!.consensusLine, -3);
  assert.equal(rows.find((r) => r.book === "A")!.advantagePoints, 0);
});

test("price is shopped even when the line is identical", () => {
  const rows = shopSide(
    [
      { book: "Cheap", market: "spread", side: "home", line: -3, price: -105, oppositePrice: -115 },
      { book: "A", market: "spread", side: "home", line: -3, price: -110, oppositePrice: -110 },
      { book: "B", market: "spread", side: "home", line: -3, price: -110, oppositePrice: -110 },
    ],
    NFL,
  );
  const cheap = rows.find((r) => r.book === "Cheap")!;
  const normal = rows.find((r) => r.book === "A")!;
  assert.equal(cheap.advantagePoints, 0);
  // Same number, better price: the fair probability is unchanged but less is charged
  // for it, so the return is strictly better while still short of the hold.
  assert.ok(cheap.expectedRoi! > normal.expectedRoi!);
  assert.ok(cheap.expectedRoi! < 0);
});

test("a moneyline is shopped on price against the de-vigged consensus", () => {
  const rows = shopSide(
    [
      { book: "Rich", market: "moneyline", side: "home", line: null, price: 150, oppositePrice: -180 },
      { book: "A", market: "moneyline", side: "home", line: null, price: -110, oppositePrice: -110 },
      { book: "B", market: "moneyline", side: "home", line: null, price: -110, oppositePrice: -110 },
    ],
    NFL,
  );
  const rich = rows.find((r) => r.book === "Rich")!;
  // The others call it a coin flip; +150 pays 1.5:1 on a coin flip.
  assert.equal(rich.consensusProbability, 0.5);
  assert.ok(Math.abs(rich.expectedRoi! - 0.25) < 1e-9);
});

test("a lone book is reported, not silently dropped", () => {
  const rows = shopSide([quote("Only", -3)], NFL);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].booksCompared, 0);
  assert.equal(rows[0].expectedRoi, null);
  assert.match(rows[0].note, /nothing to compare/i);
});

test("without a fitted model, points are not priced rather than guessed", () => {
  const rows = shopSide([quote("A", -2), quote("B", -3)], null);
  assert.equal(rows[0].advantagePoints, 1);
  assert.equal(rows[0].fairProbability, null);
  assert.equal(rows[0].expectedRoi, null);
});

test("expectedRoi matches the standard payouts", () => {
  assert.ok(Math.abs(expectedRoi(0.5, 100)) < 1e-9);
  assert.ok(Math.abs(expectedRoi(0.5, -110) + 0.04545) < 1e-4);
  assert.ok(Math.abs(expectedRoi(0.524, -110)) < 0.002);
});

test("shopAll keeps sides apart and ranks by return", () => {
  const rows = shopAll(
    [
      { book: "A", market: "spread", side: "home", line: -3, price: -110, oppositePrice: -110 },
      { book: "B", market: "spread", side: "home", line: -3, price: -110, oppositePrice: -110 },
      { book: "A", market: "spread", side: "away", line: 3, price: -110, oppositePrice: -110 },
      { book: "B", market: "spread", side: "away", line: 5, price: -110, oppositePrice: -110 },
    ],
    NFL,
  );
  assert.equal(rows.length, 4);
  // B's away +5 against a consensus of +3 is the only real advantage on the board.
  assert.equal(rows[0].book, "B");
  assert.equal(rows[0].side, "away");
  assert.equal(rows[0].advantagePoints, 2);
  assert.ok(rows[0].expectedRoi! > 0);
  // The home side is untouched by the away disagreement; grouping kept them apart.
  const home = rows.filter((r) => r.side === "home");
  assert.equal(home.length, 2);
  for (const row of home) assert.equal(row.advantagePoints, 0);
});
