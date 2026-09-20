import assert from "node:assert/strict";
import { test } from "node:test";

import {
  assignTokens,
  bestStake,
  bonusConversion,
  boostCoversHold,
  devigTwoWay,
  evCurve,
  expiryState,
  fairFromOneSide,
  parlayHold,
  promoEv,
  type PromoTerms,
} from "./promo-ev.ts";

const close = (a: number, b: number, tol = 1e-9) => Math.abs(a - b) < tol;

/* --- fair probability ------------------------------------------------------------ */

test("multiplicative de-vig splits the margin between the two sides", () => {
  const out = devigTwoWay(-110, -110)!;
  assert.ok(close(out.p, 0.5));
  assert.ok(close(out.hold, (110 / 210) * 2 - 1), "two -110 prices hold about 4.76%");
});

test("Shin and multiplicative agree near even money and part on longshots", () => {
  const evenMult = devigTwoWay(-110, -110)!.p;
  const evenShin = devigTwoWay(-110, -110, "shin")!.p;
  assert.ok(Math.abs(evenMult - evenShin) < 0.005, "nothing to argue about at a coin flip");

  // The longshot is where the two methods disagree, and Shin gives it less.
  const dogMult = devigTwoWay(600, -900)!.p;
  const dogShin = devigTwoWay(600, -900, "shin")!.p;
  assert.ok(dogShin < dogMult, `${dogShin} should sit below ${dogMult}`);
  assert.ok(dogMult - dogShin > 0.002, "and by enough to matter on a marginal promo");
});

test("Shin returns a probability, and the pair still sums to one", () => {
  const a = devigTwoWay(250, -300, "shin")!.p;
  const b = devigTwoWay(-300, 250, "shin")!.p;
  assert.ok(a > 0 && a < 1);
  assert.ok(close(a + b, 1, 1e-6));
});

test("one price plus an assumed hold is marked as an estimate", () => {
  const out = fairFromOneSide(-110)!;
  assert.equal(out.estimated, true);
  assert.equal(out.method, "assumed");
  assert.ok(out.p < 110 / 210, "the implied number always overstates the true chance");
});

test("nonsense prices yield nothing rather than a plausible number", () => {
  assert.equal(devigTwoWay(50, -110), null);
  assert.equal(fairFromOneSide(0), null);
});

/* --- bonus bets and parlays ------------------------------------------------------- */

test("a bonus bet converts better the longer the price", () => {
  assert.ok(close(bonusConversion(100), 0.5));
  assert.ok(close(bonusConversion(300), 0.75));
  assert.ok(Math.abs(bonusConversion(600) - 0.857) < 0.001);
  assert.ok(bonusConversion(-200) < 0.4, "a short favourite wastes most of the face");
});

test("parlay hold compounds per leg", () => {
  assert.ok(Math.abs(parlayHold(2) - (1 - 0.955 ** 2)) < 1e-9, "4.5% a leg compounds to 8.8%");
  assert.ok(Math.abs(parlayHold(2, 0.07) - (1 - 0.93 ** 2)) < 1e-9, "and 7% a leg to 13.5%");
  assert.ok(parlayHold(6) > parlayHold(3));
  assert.equal(parlayHold(0), 0);
});

test("a 50% boost covers about 33% hold, which six legs blow past", () => {
  assert.ok(Math.abs(boostCoversHold(0.5) - 1 / 3) < 1e-9);
  assert.ok(parlayHold(6, 0.07) > boostCoversHold(0.5));
});

/* --- the five types --------------------------------------------------------------- */

test("stake back: the refund is what makes a loss survivable", () => {
  const terms: PromoTerms = { type: "stake_back", capRefund: 25 };
  const withRefund = promoEv(terms, { p: 0.25, price: 300, stake: 25, conversion: 0.7 });
  const plain = promoEv({ type: "odds_boost", boostedPrice: 300 }, { p: 0.25, price: 300, stake: 25 });
  // A fair +300 bet is worth nothing; the refund is the entire value of the promo.
  assert.ok(Math.abs(plain.ev) < 1e-9);
  assert.ok(Math.abs(withRefund.ev - 0.75 * 25 * 0.7) < 1e-9);
});

test("stake back: staking above the cap is refused, and it says why", () => {
  const terms: PromoTerms = { type: "stake_back", capRefund: 25 };
  const over = promoEv(terms, { p: 0.25, price: 300, stake: 100 });
  assert.ok(over.binding.some((b) => /capped at \$25/.test(b)));
  assert.ok(over.binding.some((b) => /unprotected/.test(b)));
  // The extra $75 is simply not counted: the answer is the capped bet.
  assert.ok(close(over.ev, promoEv(terms, { p: 0.25, price: 300, stake: 25 }).ev));
});

test("stake back is worth more on long odds than short ones", () => {
  const terms: PromoTerms = { type: "stake_back", capRefund: 50 };
  const long = promoEv(terms, { p: 1 / 9, price: 800, stake: 50 }).ev;
  const short = promoEv(terms, { p: 2 / 3, price: -200, stake: 50 }).ev;
  assert.ok(long > short, `${long} should beat ${short}`);
});

test("profit boost: longer odds are worth more, at fair prices and at held ones", () => {
  const terms: PromoTerms = { type: "profit_boost", boostPct: 0.5, maxStake: 25 };
  // Priced fairly, a 50% boost on +200 is worth 33% of stake and on +1000 45%.
  const fair200 = promoEv(terms, { p: 1 / 3, price: 200, stake: 25 });
  const fair1000 = promoEv(terms, { p: 1 / 11, price: 1000, stake: 25 });
  assert.ok(Math.abs(fair200.evPerDollar - 1 / 3) < 1e-9, String(fair200.evPerDollar));
  assert.ok(Math.abs(fair1000.evPerDollar - 5 / 11) < 1e-9, String(fair1000.evPerDollar));
  assert.ok(fair1000.evPerDollar > fair200.evPerDollar, "longer is better either way");

  // The spec quotes +6.7% and +16.4% for these two. Those follow from the same formula
  // only if the true chance is 80% of what the price implies -- a market held about 25%.
  // Recorded here so the difference is a stated assumption rather than a lost one.
  const held200 = promoEv(terms, { p: 0.8 / 3, price: 200, stake: 25 });
  const held1000 = promoEv(terms, { p: 0.8 / 11, price: 1000, stake: 25 });
  assert.ok(Math.abs(held200.evPerDollar - 0.0667) < 0.001, String(held200.evPerDollar));
  assert.ok(Math.abs(held1000.evPerDollar - 0.1636) < 0.001, String(held1000.evPerDollar));
});

test("profit boost: a leg-stuffed ticket is flagged, not quietly priced", () => {
  const terms: PromoTerms = { type: "profit_boost", boostPct: 0.5, minLegs: 3 };
  const six = promoEv(terms, { p: 0.05, price: 1500, stake: 25, legs: 6 });
  assert.ok(six.warnings.some((w) => /legs carries about/.test(w)), "leg count alone is flagged");

  // Whether the boost can still overcome the hold depends on how the legs are priced.
  // At the measured -110 hold six legs cost 24%, under what a 50% boost covers; at the
  // 7% a boosted-parlay menu tends to charge, they cost 35% and it cannot.
  assert.ok(!six.warnings.some((w) => /only overcomes/.test(w)));
  const priced = promoEv(terms, { p: 0.05, price: 1500, stake: 25, legs: 6, holdPerLeg: 0.07 });
  assert.ok(priced.warnings.some((w) => /only overcomes/.test(w)));
});

test("profit boost: too few legs for the terms is a warning", () => {
  const terms: PromoTerms = { type: "profit_boost", boostPct: 0.5, minLegs: 3 };
  assert.ok(
    promoEv(terms, { p: 0.3, price: 250, stake: 25, legs: 1 }).warnings.some((w) =>
      /at least 3 legs/.test(w),
    ),
  );
});

test("a price below the minimum does not qualify, and says so", () => {
  const terms: PromoTerms = { type: "profit_boost", boostPct: 0.5, minOddsAmerican: -120 };
  assert.ok(
    promoEv(terms, { p: 0.75, price: -300, stake: 25 }).warnings.some((w) => /does not qualify/.test(w)),
  );
  assert.ok(
    promoEv(terms, { p: 0.5, price: 100, stake: 25 }).binding.some((b) => /-120 minimum/.test(b)),
  );
});

test("odds boost: a boost that only reaches fair is called a skip", () => {
  // +200 boosted to +220, but the fair price is +250: still short.
  const terms: PromoTerms = { type: "odds_boost", boostedPrice: 220, maxStake: 25 };
  const out = promoEv(terms, { p: 1 / 3.5, price: 200, stake: 25 });
  assert.ok(out.ev < 0);
  assert.ok(out.warnings.some((w) => /not worth taking/.test(w)));
});

test("odds boost: a real one shows a profit", () => {
  const terms: PromoTerms = { type: "odds_boost", boostedPrice: 400, maxStake: 25 };
  const out = promoEv(terms, { p: 1 / 3.5, price: 200, stake: 25 });
  assert.ok(out.ev > 0);
  assert.equal(out.warnings.length, 0);
});

test("bonus bet: value is winnings only, and reported against face", () => {
  const terms: PromoTerms = { type: "bonus_bet", bonusFace: 50 };
  const out = promoEv(terms, { p: 0.25, price: 300, stake: 50 });
  assert.ok(close(out.ev, 0.25 * 3 * 50));
  assert.ok(close(out.evPerDollar, bonusConversion(300)));
});

test("deposit match: the turnover is reported in dollars, not multiples", () => {
  const terms: PromoTerms = { type: "deposit_match", depositBonus: 1000, rolloverMultiple: 10 };
  const out = promoEv(terms, { p: 0.5, price: -110, stake: 0 });
  assert.equal(out.requiredTurnover, 10000);
  assert.ok(out.binding.some((b) => /\$10000 of bets/.test(b)));
});

test("deposit match: a rollover that eats the bonus is called out", () => {
  const heavy = promoEv(
    { type: "deposit_match", depositBonus: 500, rolloverMultiple: 30 },
    { p: 0.5, price: -110, stake: 0 },
  );
  assert.ok(heavy.ev < 0);
  assert.ok(heavy.warnings.some((w) => /costs more than the bonus/.test(w)));

  const light = promoEv(
    { type: "deposit_match", depositBonus: 500, rolloverMultiple: 3 },
    { p: 0.5, price: -110, stake: 0 },
  );
  assert.ok(light.ev > 0);
});

/* --- optimiser ---------------------------------------------------------------------- */

test("the curve shows longer odds paying more, and marks what does not qualify", () => {
  const terms: PromoTerms = { type: "stake_back", capRefund: 25, minOddsAmerican: 100 };
  const curve = evCurve(terms, 25);
  const short = curve.find((c) => c.price === -200)!;
  const long = curve.find((c) => c.price === 800)!;
  assert.equal(short.qualifies, false);
  assert.equal(long.qualifies, true);
  assert.ok(long.ev > short.ev);
});

test("the stake the terms point at is the cap, the max, or the face", () => {
  assert.equal(bestStake({ type: "stake_back", capRefund: 25 }), 25);
  assert.equal(bestStake({ type: "profit_boost", maxStake: 50 }), 50);
  assert.equal(bestStake({ type: "bonus_bet", bonusFace: 10 }), 10);
  assert.equal(bestStake({ type: "odds_boost" }, 20), 20);
});

/* --- expiry and assignment ---------------------------------------------------------- */

test("expiry is a countdown, and under a day is urgent", () => {
  const now = new Date("2026-09-20T12:00:00Z");
  const soon = expiryState("2026-09-20T20:00:00Z", now);
  assert.equal(soon.urgent, true);
  assert.equal(soon.expired, false);
  assert.ok(Math.abs(soon.hoursLeft - 8) < 1e-9);

  const later = expiryState("2026-09-25T12:00:00Z", now);
  assert.equal(later.urgent, false);

  const gone = expiryState("2026-09-19T12:00:00Z", now);
  assert.equal(gone.expired, true);
  assert.equal(gone.urgent, false, "an expired token is not urgent, it is finished");
});

test("an unreadable expiry counts as expired rather than as forever", () => {
  assert.equal(expiryState("not a date").expired, true);
});

test("the stake-back goes on the longest price, the boost on the next", () => {
  const assigned = assignTokens(
    [{ type: "profit_boost" as const, id: "boost" }, { type: "stake_back" as const, id: "reset" }],
    [150, 700, -110],
  );
  assert.equal(assigned[0].token.id, "reset");
  assert.equal(assigned[0].price, 700);
  assert.equal(assigned[1].token.id, "boost");
  assert.equal(assigned[1].price, 150);
});

test("more tokens than prices leaves the extras unassigned rather than doubling up", () => {
  const assigned = assignTokens(
    [{ type: "stake_back" as const }, { type: "profit_boost" as const }],
    [400],
  );
  assert.equal(assigned[0].price, 400);
  assert.equal(assigned[1].price, null);
});
