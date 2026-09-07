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
import type { Side } from "./types.ts";

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
  const rows = shopSide([quote("A", -3), quote("B", -3), quote("C", -3), quote("D", -3)], NFL);
  for (const row of rows) {
    assert.equal(row.advantagePoints, 0);
    assert.equal(row.fairProbability, 0.5);
    // A coin flip at -110 loses 4.5 cents on the dollar. That is the vig, and it is
    // the correct answer for a board with no disagreement on it.
    assert.ok(Math.abs(row.expectedRoi! + 0.0454) < 0.001);
  }
});

test("consensus is leave-one-out, so an outlier cannot pull its own reference", () => {
  // Including a quote in its own reference would drag the consensus toward the number
  // being tested and halve every gap. A sees (-3, -3, -3); it must not see its own -2.
  const rows = shopSide(
    [quote("A", -2), quote("B", -3), quote("C", -3), quote("D", -3)],
    NFL,
  );
  assert.equal(rows.find((r) => r.book === "A")!.consensusLine, -3);
  assert.equal(rows.find((r) => r.book === "A")!.advantagePoints, 1);
  // B sees (-2, -3, -3): the median is still -3, so it stands level with the field.
  assert.equal(rows.find((r) => r.book === "B")!.consensusLine, -3);
  assert.equal(rows.find((r) => r.book === "B")!.advantagePoints, 0);
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
      { book: "C", market: "spread", side: "home", line: -3, price: -110, oppositePrice: -110 },
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
      { book: "C", market: "moneyline", side: "home", line: null, price: -110, oppositePrice: -110 },
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
  const rows = shopSide(
    [quote("A", -2), quote("B", -3), quote("C", -3), quote("D", -3)],
    null,
  );
  const a = rows.find((r) => r.book === "A")!;
  assert.equal(a.advantagePoints, 1, "the gap is still measured");
  assert.equal(a.fairProbability, null, "but points cannot be converted without a model");
  assert.equal(a.expectedRoi, null);
});

test("expectedRoi matches the standard payouts", () => {
  assert.ok(Math.abs(expectedRoi(0.5, 100)) < 1e-9);
  assert.ok(Math.abs(expectedRoi(0.5, -110) + 0.04545) < 1e-4);
  assert.ok(Math.abs(expectedRoi(0.524, -110)) < 0.002);
});

test("shopAll keeps sides apart and ranks by return", () => {
  const spread = (book: string, side: Side, line: number): BookQuote => ({
    book, market: "spread", side, line, price: -110, oppositePrice: -110,
  });
  const rows = shopAll(
    [
      spread("A", "home", -3), spread("B", "home", -3),
      spread("C", "home", -3), spread("D", "home", -3),
      spread("A", "away", 3), spread("C", "away", 3), spread("D", "away", 3),
      spread("B", "away", 5),
    ],
    NFL,
  );
  assert.equal(rows.length, 8);
  // B's away +5 against a consensus of +3 is the only real advantage on the board.
  assert.equal(rows[0].book, "B");
  assert.equal(rows[0].side, "away");
  assert.equal(rows[0].advantagePoints, 2);
  assert.ok(rows[0].expectedRoi! > 0);
  // The home side is untouched by the away disagreement; grouping kept them apart.
  const home = rows.filter((r) => r.side === "home");
  assert.equal(home.length, 4);
  for (const row of home) assert.equal(row.advantagePoints, 0);
});

// --- guards against pricing what cannot be priced ---------------------------------

function ml(book: string, price: number, opposite: number): BookQuote {
  return { book, market: "moneyline", side: "home", line: null, price, oppositePrice: opposite };
}

test("a longshot moneyline is compared but not priced", () => {
  // The failure that shipped: proportional de-vig barely touches a +2500 dog, so a
  // book at +3500 reads as +36% expected return out of nothing. The first live board
  // reported 79 of these, every one a big underdog.
  const rows = shopSide(
    [
      ml("Outlier", 3500, -5000),
      ml("A", 2500, -5000),
      ml("B", 2500, -5000),
      ml("C", 2400, -4800),
    ],
    NFL,
  );
  const outlier = rows.find((r) => r.book === "Outlier")!;
  assert.equal(outlier.expectedRoi, null, "no return may be quoted out here");
  assert.equal(outlier.fairProbability, null);
  assert.ok(outlier.consensusProbability! < 0.1);
  assert.match(outlier.note, /longshot/i);
});

test("a heavy favourite moneyline is equally refused", () => {
  const rows = shopSide(
    [ml("Outlier", -4000, 2000), ml("A", -5000, 2500), ml("B", -5000, 2500), ml("C", -4800, 2400)],
    NFL,
  );
  assert.equal(rows.find((r) => r.book === "Outlier")!.expectedRoi, null);
});

test("a moneyline near even money is still priced normally", () => {
  const rows = shopSide(
    [ml("Rich", 150, -180), ml("A", -110, -110), ml("B", -110, -110), ml("C", -110, -110)],
    NFL,
  );
  const rich = rows.find((r) => r.book === "Rich")!;
  assert.equal(rich.consensusProbability, 0.5);
  assert.ok(Math.abs(rich.expectedRoi! - 0.25) < 1e-9);
});

test("a board-level floor refuses a reference of two books", () => {
  // Mining a whole board for the largest number selects the thinnest reference, so the
  // board asks for three. The same call without the floor still prices it, because a
  // deliberate head-to-head against your own book is a different question.
  const quotes = [quote("A", -2), quote("B", -3), quote("C", -3)];
  for (const row of shopSide(quotes, NFL, 3)) {
    assert.equal(row.expectedRoi, null);
    assert.match(row.note, /too thin/i);
    assert.equal(row.thinConsensus, true);
  }
  const unfloored = shopSide(quotes, NFL).find((r) => r.book === "A")!;
  assert.equal(unfloored.advantagePoints, 1);
  assert.ok(unfloored.expectedRoi! > 0);
  assert.equal(unfloored.thinConsensus, true, "still flagged as thin");
});

test("hand entry keeps working: one book against the board is priced", () => {
  // Plan B's whole purpose. A floor applied everywhere would have silently disabled it.
  const rows = shopSide([quote("DraftKings", -3), quote("BetMGM", -2)], NFL);
  const mgm = rows.find((r) => r.book === "BetMGM")!;
  assert.equal(mgm.advantagePoints, 1);
  assert.ok(mgm.expectedRoi! > 0);
  assert.equal(mgm.thinConsensus, true);
});

test("three other books is enough to price", () => {
  const rows = shopSide([quote("A", -2), quote("B", -3), quote("C", -3), quote("D", -3)], NFL);
  const a = rows.find((r) => r.book === "A")!;
  assert.equal(a.booksCompared, 3);
  assert.equal(a.advantagePoints, 1);
  assert.ok(a.expectedRoi! > 0, "a genuine full point still clears the vig");
});

test("the spread path is untouched by the moneyline band", () => {
  // Spreads sit near 50/50 by construction, which is exactly where de-vig holds.
  const rows = shopSide([quote("A", -2), quote("B", -3), quote("C", -3), quote("D", -3)], NFL);
  assert.ok(rows.every((r) => r.market === "spread"));
  assert.ok(rows.find((r) => r.book === "A")!.expectedRoi !== null);
});

// --- dispersion by line size ------------------------------------------------------

/**
 * NCAAF as actually fitted, on 6,142 games from seven seasons.
 *
 * Worth reading before trusting any intuition about big spreads: the dispersion is
 * FLAT from 0 to 35 points, and drops at 35+. It does not widen with the spread, which
 * is what this fixture was originally written (wrongly) to assert.
 */
const CFB_BUCKETED: MarginModel = {
  ...CFB,
  sd: 15.43,
  buckets: [
    { lo: 0, hi: 3, games: 785, mean: -0.07, sd: 15.7 },
    { lo: 3, hi: 7, games: 1432, mean: 0.8, sd: 15.45 },
    { lo: 7, hi: 10, games: 736, mean: 0.11, sd: 15.85 },
    { lo: 10, hi: 14, games: 781, mean: 0.49, sd: 15.46 },
    { lo: 14, hi: 21, games: 1007, mean: -0.73, sd: 15.16 },
    { lo: 21, hi: 28, games: 624, mean: -0.36, sd: 15.63 },
    { lo: 28, hi: 35, games: 365, mean: 1.52, sd: 16.02 },
    // The one band that genuinely differs, about four standard errors below.
    { lo: 35, hi: 999, games: 412, mean: 1.12, sd: 13.63 },
  ],
};

/** Invented, not measured: used only to prove the lookup responds to the band. */
const SYNTHETIC_WIDENING: MarginModel = {
  ...CFB,
  sd: 15.43,
  buckets: [
    { lo: 0, hi: 3, games: 900, mean: 0, sd: 13.2 },
    { lo: 35, hi: 999, games: 400, mean: 0, sd: 21.6 },
  ],
};

test("the density follows whichever band the line falls in", () => {
  const near = pointsToProbability(SYNTHETIC_WIDENING, 1.5) * 100;
  const far = pointsToProbability(SYNTHETIC_WIDENING, 42.5) * 100;
  assert.ok(near > far, "wider scatter must mean a point buys less");
  assert.ok(near > 2.9 && near < 3.1);
  assert.ok(far > 1.7 && far < 1.9);
});

test("measured football does NOT widen with the spread", () => {
  // The hypothesis this whole lookup was built to act on, tested against the fit.
  // Every band from 0 to 35 sits within a few hundredths of the league figure...
  const league = pointsToProbability(CFB_BUCKETED, null) * 100;
  for (const size of [1.5, 5, 8.5, 12, 17, 24, 31]) {
    const d = pointsToProbability(CFB_BUCKETED, size) * 100;
    assert.ok(Math.abs(d - league) < 0.12, `band at ${size} moved to ${d} from ${league}`);
  }
  // ...and above 35 a point is worth MORE, not less.
  assert.ok(pointsToProbability(CFB_BUCKETED, 42.5) * 100 > league + 0.25);
});

test("the league figure is used when no buckets are fitted", () => {
  assert.equal(pointsToProbability(CFB, 42.5), pointsToProbability(CFB, 1.5));
});

test("an unknown or missing spread falls back rather than guessing", () => {
  assert.equal(pointsToProbability(CFB_BUCKETED, null), 1 / (15.43 * Math.sqrt(2 * Math.PI)));
  assert.equal(pointsToProbability(CFB_BUCKETED, NaN), 1 / (15.43 * Math.sqrt(2 * Math.PI)));
});

test("the sign of the spread does not matter, only its size", () => {
  assert.equal(pointsToProbability(CFB_BUCKETED, 42.5), pointsToProbability(CFB_BUCKETED, -42.5));
});

test("the Notre Dame row: measuring made it larger, not smaller", () => {
  // What started this. FanDuel -42.5 against a field at -44.5 is a genuine 2-point
  // difference, and priced at the league-wide density it read +5.3% and topped the
  // board. The gap is real; what was wrong was how much a point out there is worth.
  const at = (line: number, book: string): BookQuote => ({
    book, market: "spread", side: "home", line, price: -110, oppositePrice: -110,
  });
  const quotes = [at(-42.5, "FanDuel"), at(-44.5, "A"), at(-44.5, "B"), at(-44.5, "C")];

  const naive = shopSide(quotes, CFB).find((r) => r.book === "FanDuel")!;
  const fixed = shopSide(quotes, CFB_BUCKETED).find((r) => r.book === "FanDuel")!;

  assert.equal(naive.advantagePoints, 2);
  assert.equal(fixed.advantagePoints, 2, "the gap itself is unchanged; only its worth");
  // The uncomfortable part. I expected this correction to shrink the row; the 35+
  // band is tighter than the league, so it grows. Keeping the test in this direction
  // so nobody "fixes" the model back toward the intuition it disproved.
  assert.ok(
    fixed.expectedRoi! > naive.expectedRoi!,
    "the tighter 35+ band makes a point out there worth more",
  );
});

test("a synthetic widening band does reorder the board", () => {
  // The ranking failure this fix is really about. Two identical 2-point gaps: at the
  // league-wide density they price the same and the blowout can top the board on
  // rounding alone. Measured properly, the near-pick'em one is plainly worth more.
  const at = (line: number, book: string): BookQuote => ({
    book, market: "spread", side: "home", line, price: -110, oppositePrice: -110,
  });
  const blowout = shopSide(
    [at(-42.5, "X"), at(-44.5, "A"), at(-44.5, "B"), at(-44.5, "C")],
    SYNTHETIC_WIDENING,
  ).find((r) => r.book === "X")!;
  const pickem = shopSide(
    [at(1, "X"), at(-1, "A"), at(-1, "B"), at(-1, "C")],
    SYNTHETIC_WIDENING,
  ).find((r) => r.book === "X")!;

  assert.equal(blowout.advantagePoints, 2);
  assert.equal(pickem.advantagePoints, 2);
  assert.ok(pickem.expectedRoi! > blowout.expectedRoi!);
});

test("a real gap near the middle survives the fix", () => {
  // The correction must not simply suppress everything: a full point on a near
  // pick'em still clears the vig, which is the whole premise.
  const at = (line: number, book: string): BookQuote => ({
    book, market: "spread", side: "home", line, price: -110, oppositePrice: -110,
  });
  const row = shopSide(
    [at(-2, "Bovada"), at(-3, "A"), at(-3, "B"), at(-3, "C")],
    CFB_BUCKETED,
  ).find((r) => r.book === "Bovada")!;
  assert.equal(row.advantagePoints, 1);
  assert.ok(row.expectedRoi! > 0);
});
