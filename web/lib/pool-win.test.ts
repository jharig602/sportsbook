import assert from "node:assert/strict";
import { test } from "node:test";


/** One week with two priced games, so two entries must split them. */
function twoTeamWeek(): Week[] {
  return [
    {
      week: 1,
      startsAt: "2026-09-13T17:00:00Z",
      candidates: [
        { team: "Alpha", opponent: "Bravo", home: true, commenceTime: "2026-09-13T17:00:00Z", winProbability: 0.86, spread: -10, eventId: "g1" },
        { team: "Charlie", opponent: "Delta", home: true, commenceTime: "2026-09-13T17:00:00Z", winProbability: 0.8, spread: -7, eventId: "g2" },
      ] as never,
    },
  ];
}

import { lastStandingWin, prepareField } from "./last-standing.ts";
import { survival } from "./pool-odds.ts";
import {
  buildPoolWinPlans,
  crowdingFrom,
  crossoverCrowding,
  poolWin,
  poolWinStability,
  rankByPoolWin,
  shareOfPot,
  type Field,
  poolCrowding,
  fieldFromRivals,
} from "./pool-win.ts";
import { buildWeeks, type SeasonGame, type Week } from "./survivor.ts";
import type { MarginModel } from "./probability.ts";

function normalPmf(mean: number, sd: number): Record<string, number> {
  const pmf: Record<string, number> = {};
  let total = 0;
  for (let half = -120; half <= 120; half += 1) {
    const x = half / 2;
    const z = (x - mean) / sd;
    const density = Math.exp(-0.5 * z * z);
    pmf[String(half)] = density;
    total += density;
  }
  for (const key of Object.keys(pmf)) pmf[key] /= total;
  return pmf;
}

const NFL: MarginModel = {
  league: "nfl",
  games: 2215,
  mean: -0.19,
  sd: 12.74,
  lo: -60,
  hi: 60,
  pmf: normalPmf(-0.19, 12.74),
};

// --- the closed form -----------------------------------------------------------------

test("shareOfPot matches a brute-force binomial sum", () => {
  const brute = (rivals: number, q: number) => {
    let total = 0;
    let coefficient = 1; // C(rivals, k)
    for (let k = 0; k <= rivals; k += 1) {
      total += (coefficient * q ** k * (1 - q) ** (rivals - k)) / (k + 1);
      coefficient = (coefficient * (rivals - k)) / (k + 1);
    }
    return total;
  };
  for (const rivals of [0, 1, 5, 12, 136]) {
    for (const q of [0.01, 0.0674, 0.3, 0.75, 0.99]) {
      assert.ok(
        Math.abs(shareOfPot(rivals, q) - brute(rivals, q)) < 1e-12,
        `rivals=${rivals} q=${q}`,
      );
    }
  }
});

test("a pot with nobody else in it is entirely yours", () => {
  assert.equal(shareOfPot(0, 0.5), 1);
  // Rivals who always survive split it evenly.
  assert.equal(shareOfPot(3, 1), 0.25);
});

// --- the identity that anchors the whole model ---------------------------------------

test("with no rivals, winning the pool IS surviving it", () => {
  // Not a coincidence to be checked loosely: the branch weights must sum to exactly
  // the survival probability, or the enumeration has lost or double-counted mass.
  // Shared weeks carry the crowd's own number, because a shared week is the same team.
  const mine = [0.8, 0.81, 0.8, 0.88, 0.8];
  const field: Field = { probabilities: [0.8, 0.75, 0.8, 0.82, 0.8], crowding: 0.4 };
  for (const lossesAllowed of [0, 1, 2]) {
    const got = poolWin({
      mine,
      shared: [true, false, true, false, true],
      field,
      lossesAllowed,
      poolSize: 1,
    });
    assert.ok(
      Math.abs(got - survival(mine, lossesAllowed)) < 1e-12,
      `lives=${lossesAllowed + 1}: ${got} vs ${survival(mine, lossesAllowed)}`,
    );
  }
});

test("a week marked shared whose probability disagrees is an error, not a guess", () => {
  // The failure mode this guards is silent: without it the crowd's number is used for
  // your own season and the answer looks entirely reasonable.
  assert.throws(
    () =>
      poolWin({
        mine: [0.75],
        shared: [true],
        field: { probabilities: [0.8], crowding: 0.3 },
        lossesAllowed: 0,
        poolSize: 13,
      }),
    /marked shared/,
  );
});

test("the branch weights are a probability distribution whatever the crowding", () => {
  // Same check from the other side: crowding moves who survives, never how much
  // probability there is to go round.
  const mine = [0.7, 0.9, 0.75];
  for (const crowding of [0, 0.25, 0.5, 1]) {
    const got = poolWin({
      mine,
      shared: [true, false, false],
      field: { probabilities: [0.7, 0.85, 0.8], crowding },
      lossesAllowed: 1,
      poolSize: 1,
    });
    assert.ok(Math.abs(got - survival(mine, 1)) < 1e-12, `crowding=${crowding}`);
  }
});

// --- the claim this module exists to make --------------------------------------------

test("when the field crowds, a slightly worse pick that separates you is worth more", () => {
  // The whole argument in four lines. Week 1 you either join the crowd on an 80% team
  // or take a 75% team of your own; week 2 you are back with everyone else.
  const field: Field = { probabilities: [0.8, 0.8], crowding: 0 };
  const join = (crowding: number) =>
    poolWin({
      mine: [0.8, 0.8],
      shared: [true, true],
      field: { ...field, crowding },
      lossesAllowed: 0,
      poolSize: 50,
    });
  const separate = (crowding: number) =>
    poolWin({
      mine: [0.75, 0.8],
      shared: [false, true],
      field: { ...field, crowding },
      lossesAllowed: 0,
      poolSize: 50,
    });

  // With an uncorrelated field there is nothing to separate FROM, so the safer team
  // simply wins. This is the case the old model assumed, and it is a real case.
  assert.ok(join(0) > separate(0), "uncorrelated: the safer pick should win");
  // Once the field is genuinely on one team, sharing it stops paying.
  assert.ok(separate(0.9) > join(0.9), "crowded: separation should win");
});

test("joining a crowded field is worth strictly less as the crowd grows", () => {
  const win = (crowding: number) =>
    poolWin({
      mine: [0.8, 0.8, 0.8],
      shared: [true, true, true],
      field: { probabilities: [0.8, 0.8, 0.8], crowding },
      lossesAllowed: 1,
      poolSize: 100,
    });
  const curve = [0, 0.2, 0.4, 0.6, 0.8, 1].map(win);
  for (let i = 1; i < curve.length; i += 1) {
    assert.ok(curve[i] < curve[i - 1], `crowding step ${i} did not reduce the win chance`);
  }
});

test("a bigger pool is harder to win, holding everything else fixed", () => {
  const win = (poolSize: number) =>
    poolWin({
      mine: [0.78, 0.8],
      shared: [false, true],
      field: { probabilities: [0.8, 0.8], crowding: 0.3 },
      lossesAllowed: 1,
      poolSize,
    });
  assert.ok(win(13) > win(137));
  assert.ok(win(137) > win(10000));
});

// --- reading the crowd off the popularity feed ----------------------------------------

test("no popularity data means no crowding assumption at all", () => {
  // Null rather than a default. A guessed crowding rate would manufacture exactly the
  // edge this module claims to measure.
  assert.equal(crowdingFrom({}, "Los Angeles Chargers"), null);
});

test("crowding is the share on the crowd's own team, not the largest share", () => {
  const popularity = { "Los Angeles Chargers": 0.276, "Jacksonville Jaguars": 0.234 };
  assert.equal(crowdingFrom(popularity, "Jacksonville Jaguars"), 0.234);
  // Only when the crowd's team is missing does the biggest share stand in.
  assert.equal(crowdingFrom(popularity, "Denver Broncos"), 0.276);
  assert.equal(crowdingFrom(popularity, null), 0.276);
});

// --- end to end, through the planner --------------------------------------------------

function slate(days: number, pairs: Array<[string, string, number]>): SeasonGame[] {
  const base = new Date("2026-09-13T17:00:00Z").getTime() + days * 86400000;
  return pairs.map(([home, away, spread], i) => ({
    feedEventId: `w${days}-${i}`,
    commenceTime: new Date(base + i * 1000).toISOString(),
    homeTeam: home,
    awayTeam: away,
    homeSpread: spread,
    books: 8,
  }));
}

/**
 * A season where greedy and optimal agree, so the crowd's pick really is the best one.
 *
 * `twoWeeks` cannot serve here: both teams play both weeks, so either order yields the
 * same product and the two candidates are a genuine dead heat -- confirmed at 800,000
 * sampled seasons, 0.7297% against 0.7299%. Asserting a winner there was asserting
 * noise. Giving every week its own strong team removes the save-it-for-later tension
 * and makes the greedy line the survival-optimal line, which is the setup these tests
 * actually need.
 */
function crowdLeads(): Week[] {
  return buildWeeks(
    [
      ...slate(0, [["Best1", "Weak1", -14], ["Fair1", "Other1", -3]]),
      ...slate(7, [["Best2", "Weak2", -14], ["Fair2", "Other2", -3]]),
      ...slate(14, [["Best3", "Weak3", -14], ["Fair3", "Other3", -3]]),
    ],
    NFL,
  );
}

function twoWeeks(): Week[] {
  return buildWeeks(
    [
      ...slate(0, [["Chalk", "Patsy", -10], ["Solid", "Filler", -8]]),
      ...slate(7, [["Chalk", "Filler", -10], ["Solid", "Patsy", -8]]),
    ],
    NFL,
  );
}

test("with an uncorrelated field the ranking is the old survival ranking", () => {
  const ranked = rankByPoolWin(twoWeeks(), {
    lossesAllowed: 0,
    poolSize: 137,
    crowding: 0,
  });
  assert.ok(ranked.length >= 2);
  // Ranked by pool win, but with crowding 0 that order must agree with survival.
  const bySurvival = [...ranked].sort((a, b) => b.survival - a.survival);
  assert.deepEqual(
    ranked.map((r) => r.candidate.team),
    bySurvival.map((r) => r.candidate.team),
  );
});

test("a crowded field can move the recommended pick off the chalk", () => {
  const weeks = crowdLeads();
  const quiet = rankByPoolWin(weeks, { lossesAllowed: 0, poolSize: 137, crowding: 0 });
  const crowded = rankByPoolWin(weeks, { lossesAllowed: 0, poolSize: 137, crowding: 0.9 });
  assert.equal(quiet[0].candidate.team, "Best1");
  assert.ok(quiet[0].isCrowdPick, "with nobody correlated, the safest team should win");
  assert.notEqual(
    crowded[0].candidate.team,
    "Best1",
    "with nine in ten entrants on Best1, sharing it cannot be the best play",
  );
});

test("a team already spent is never ranked", () => {
  const ranked = rankByPoolWin(twoWeeks(), {
    used: new Set(["Chalk"]),
    lossesAllowed: 0,
    poolSize: 13,
    crowding: 0.3,
  });
  assert.ok(ranked.length > 0);
  assert.ok(ranked.every((r) => r.candidate.team !== "Chalk"));
});

test("an unplayable season ranks nothing rather than throwing", () => {
  assert.deepEqual(rankByPoolWin([], { lossesAllowed: 1, poolSize: 13, crowding: 0.3 }), []);
  const unpriced: Week[] = [{ week: 1, startsAt: "", candidates: [] }];
  assert.deepEqual(rankByPoolWin(unpriced, { lossesAllowed: 1, poolSize: 13, crowding: 0.3 }), []);
});

test("horizon stability reports the pool-win pick, not the survival one", () => {
  // The card sits directly under the headline pick. If it answered for a different
  // objective it would eventually name a different team than the one recommended.
  const weeks = twoWeeks();
  const options = { lossesAllowed: 0, poolSize: 137, crowding: 0.9 };
  const stability = poolWinStability(weeks, [1, 2], options);
  assert.deepEqual(stability.map((s) => s.horizon), [1, 2]);
  const full = rankByPoolWin(weeks, options)[0].candidate.team;
  assert.equal(stability[stability.length - 1].team, full);
});

test("horizon stability collapses duplicate and oversized horizons", () => {
  const stability = poolWinStability(twoWeeks(), [2, 2, 50], {
    lossesAllowed: 0,
    poolSize: 13,
    crowding: 0,
  });
  assert.equal(stability.length, 1, "2, 2 and 50 all cap to the same two priced weeks");
});

test("the crossover says how much room a contrarian call actually has", () => {
  // A margin, not a verdict. The crowding rate is one weekly measurement assumed to
  // hold all season, so "ahead" without "ahead by how much room" invites a confidence
  // the input cannot support.
  const field: Field = { probabilities: [0.8, 0.8], crowding: 0 };
  const chalk = { mine: [0.8, 0.8], shared: [true, true] };
  const contrarian = { mine: [0.75, 0.8], shared: [false, true] };

  const crossover = crossoverCrowding(contrarian, chalk, field, 0, 50);
  assert.ok(crossover !== null, "these two must swap somewhere in [0, 1]");
  assert.ok(crossover! > 0 && crossover! < 1, `outside the range: ${crossover}`);

  const at = (crowding: number, line: typeof chalk) =>
    poolWin({ ...line, field: { ...field, crowding }, lossesAllowed: 0, poolSize: 50 });
  // Below the crossover the chalk wins; above it the contrarian does. That IS the claim.
  assert.ok(at(crossover! - 0.05, chalk) > at(crossover! - 0.05, contrarian));
  assert.ok(at(crossover! + 0.05, contrarian) > at(crossover! + 0.05, chalk));
});

test("a call that does not depend on the crowd reports no crossover", () => {
  const field: Field = { probabilities: [0.8, 0.8], crowding: 0.3 };
  const line = { mine: [0.8, 0.8], shared: [true, true] };
  // A line against itself never swaps, at any crowding rate.
  assert.equal(crossoverCrowding(line, line, field, 0, 137), null);
  // Nor does one that is simply better everywhere.
  const worse = { mine: [0.6, 0.8], shared: [false, true] };
  const better = { mine: [0.79, 0.8], shared: [false, true] };
  assert.equal(crossoverCrowding(worse, better, field, 0, 137), null);
});

test("two entries are never put on the same team in the same week", () => {
  // The one thing a second entry buys. Both on one team is a single bet paid for twice.
  const plans = buildPoolWinPlans(
    twoWeeks(),
    [
      { name: "Pool A", used: [], size: 13, lossesAllowed: 1 },
      { name: "Pool B", used: [], size: 137, lossesAllowed: 1 },
    ],
    { crowding: 0.3 },
  );
  assert.equal(plans.length, 2);
  const openers = plans.map((p) => p.plan.picks[0]?.pick?.team);
  assert.ok(openers.every(Boolean));
  assert.notEqual(openers[0], openers[1]);
});

test("each entry's own history is respected, and only the current week is reserved", () => {
  const plans = buildPoolWinPlans(
    twoWeeks(),
    [
      { name: "Pool A", used: ["Chalk"], size: 13, lossesAllowed: 0 },
      { name: "Pool B", used: [], size: 13, lossesAllowed: 0 },
    ],
    { crowding: 0 },
  );
  assert.ok(plans[0].plan.picks.every((p) => p.pick?.team !== "Chalk"));
  // Pool B still gets the chalk: A never took it, so nothing is reserved against it.
  assert.equal(plans[1].plan.picks[0]?.pick?.team, "Chalk");
});

test("when the two objectives agree, the page is told so rather than left to guess", () => {
  const [only] = buildPoolWinPlans(
    twoWeeks(),
    [{ name: "Pool A", used: [], size: 13, lossesAllowed: 0 }],
    { crowding: 0 },
  );
  // Uncorrelated field: pool-win and survival must name the same team.
  assert.equal(only.insteadOf, null);
});

// --- the measured season --------------------------------------------------------------

/**
 * The live 18-week plan, taken off the deployed page rather than invented.
 *
 * `[your probability, the crowd's or null where you are both on the same team]`. The
 * crowd's numbers are shrunk on the six weeks they differ so the sequence survives at
 * the 6.74% the planner's own legal greedy baseline reports — the scraped line reuses
 * teams, which no real entry may do.
 */
const LIVE: Array<[number, number | null]> = [
  [0.765, 0.788], [0.789, 0.813], [0.835, null], [0.739, 0.765],
  [0.764, null], [0.874, null], [0.745, null], [0.813, null],
  [0.874, null], [0.714, 0.813], [0.835, null], [0.714, null],
  [0.764, null], [0.692, 0.717], [0.813, 0.860], [0.789, null],
  [0.745, null], [0.813, null],
];

function liveField(): { mine: number[]; shared: boolean[]; crowd: number[] } {
  const mine = LIVE.map(([p]) => p);
  const shared = LIVE.map(([, g]) => g === null);
  const raw = LIVE.map(([p, g]) => g ?? p);
  let lo = 0.3;
  let hi = 1;
  for (let i = 0; i < 80; i += 1) {
    const k = (lo + hi) / 2;
    const trial = raw.map((g, j) => (shared[j] ? g : Math.min(0.999, g * k)));
    if (survival(trial, 1) > 0.0674) hi = k;
    else lo = k;
  }
  const k = (lo + hi) / 2;
  return { mine, shared, crowd: raw.map((g, j) => (shared[j] ? g : Math.min(0.999, g * k))) };
}

test("on the real season, an uncorrelated field reproduces the old estimate exactly", () => {
  // The regression that keeps this honest. With crowding 0 the edge over greedy must
  // collapse to the ratio of the two survival numbers -- 7.04% / 6.74% -- because that
  // is all a model without correlation can ever see. Anything above that is the new
  // part, and if this drifts the new part is not what it claims to be.
  const { mine, shared, crowd } = liveField();
  const field: Field = { probabilities: crowd, crowding: 0 };
  const plan = poolWin({ mine, shared, field, lossesAllowed: 1, poolSize: 13 });
  const greedy = poolWin({
    mine: crowd,
    shared: crowd.map(() => true),
    field,
    lossesAllowed: 1,
    poolSize: 13,
  });
  const ratio = survival(mine, 1) / survival(crowd, 1);
  assert.ok(Math.abs(plan / greedy - ratio) < 1e-9, `${plan / greedy} vs ${ratio}`);
  assert.ok(Math.abs(ratio - 1.0448) < 0.001, `survival ratio drifted: ${ratio}`);
});

test("on the real season, the measured edge at the observed crowding is about 1.33x", () => {
  // The popularity feed had 27.6% of the field on one team in week 1. At that rate the
  // planner is worth a third again as much as picking greedily -- not the 4% the
  // survival ratio alone reports. These are the numbers quoted in the module header;
  // they are pinned here so a change to the model has to argue with them.
  const { mine, shared, crowd } = liveField();
  const at = (crowding: number) => {
    const field: Field = { probabilities: crowd, crowding };
    return (
      poolWin({ mine, shared, field, lossesAllowed: 1, poolSize: 13 }) /
      poolWin({
        mine: crowd,
        shared: crowd.map(() => true),
        field,
        lossesAllowed: 1,
        poolSize: 13,
      })
    );
  };
  assert.ok(Math.abs(at(0.3) - 1.328) < 0.01, `Pool A at 30% crowding: ${at(0.3)}`);
  // And the direction that matters: more crowding, more edge.
  assert.ok(at(0.6) > at(0.3));
  assert.ok(at(0.3) > at(0));
});

test("the bigger pool rewards separation more, not less", () => {
  // This inverts what pool-value.ts concluded from a single week. A 137-entry pool is
  // where the crowd's accumulated losses matter most, and one week cannot see that.
  const { mine, shared, crowd } = liveField();
  const edge = (poolSize: number) => {
    const field: Field = { probabilities: crowd, crowding: 0.3 };
    return (
      poolWin({ mine, shared, field, lossesAllowed: 1, poolSize }) /
      poolWin({
        mine: crowd,
        shared: crowd.map(() => true),
        field,
        lossesAllowed: 1,
        poolSize,
      })
    );
  };
  assert.ok(edge(137) > edge(13), `${edge(137)} should exceed ${edge(13)}`);
});

// --- pinning, through the pool-win layer -------------------------------------------

test("a pinned opening week overrides the ranking rather than being outvoted", () => {
  const weeks = crowdLeads();
  const free = buildPoolWinPlans(weeks, [{ name: "A", used: [], size: 137, lossesAllowed: 0 }], {
    crowding: 0,
  });
  assert.equal(free[0].plan.picks[0]?.pick?.team, "Best1");

  const pinned = buildPoolWinPlans(
    weeks,
    [{ name: "A", used: [], size: 137, lossesAllowed: 0, pinned: new Map([[1, "Fair1"]]) }],
    { crowding: 0 },
  );
  assert.equal(pinned[0].plan.picks[0]?.pick?.team, "Fair1");
  // The ranking still shows the alternative, so the page can say what it cost.
  assert.ok(pinned[0].ranking.some((r) => r.candidate.team === "Best1"));
});

test("a pinned team outside the shortlist is still priced", () => {
  // rankByPoolWin only scores the few best teams, because re-planning a season per
  // candidate is not free. A pin has to escape that cut or pinning a long shot would
  // silently score nothing and fall back to the planner's own pick.
  const weeks = twoWeeks();
  const longShot = weeks[0].candidates[weeks[0].candidates.length - 1].team;
  const ranked = rankByPoolWin(weeks, {
    lossesAllowed: 0,
    poolSize: 13,
    crowding: 0,
    consider: 1,
    pinned: new Map([[1, longShot]]),
  });
  assert.ok(
    ranked.some((r) => r.candidate.team === longShot),
    `${longShot} should have been priced despite consider: 1`,
  );
});

test("a pin on a later week constrains every candidate's re-plan", () => {
  const weeks = twoWeeks();
  const ranked = rankByPoolWin(weeks, {
    lossesAllowed: 0,
    poolSize: 13,
    crowding: 0,
    pinned: new Map([[2, "Solid"]]),
  });
  for (const row of ranked) {
    const weekTwo = row.plan.picks.find((p) => p.week === 2);
    // Either week 2 is on the pinned team, or it has no legal pick because this
    // candidate already spent it in week 1. Never a third team.
    assert.ok(
      weekTwo?.pick === null || weekTwo?.pick?.team === "Solid",
      `week 2 was ${weekTwo?.pick?.team}`,
    );
  }
});

test("pins on one entry do not leak into the other", () => {
  const plans = buildPoolWinPlans(
    twoWeeks(),
    [
      { name: "A", used: [], size: 13, lossesAllowed: 0, pinned: new Map([[1, "Solid"]]) },
      { name: "B", used: [], size: 13, lossesAllowed: 0 },
    ],
    { crowding: 0 },
  );
  assert.equal(plans[0].plan.picks[0]?.pick?.team, "Solid");
  assert.equal(plans[1].plan.picks[0]?.pick?.team, "Chalk");
});

test("no pins gives byte-for-byte the plan it gave before pinning existed", () => {
  const weeks = twoWeeks();
  const pools = [{ name: "A", used: [], size: 13, lossesAllowed: 1 }];
  const a = buildPoolWinPlans(weeks, pools, { crowding: 0.3 });
  const b = buildPoolWinPlans(
    weeks,
    [{ ...pools[0], pinned: new Map() }],
    { crowding: 0.3 },
  );
  assert.deepEqual(
    a.map((p) => [p.plan.picks.map((x) => x.pick?.team), p.poolWin]),
    b.map((p) => [p.plan.picks.map((x) => x.pick?.team), p.poolWin]),
  );
});

// --- planning the whole season, not just the opening week ---------------------------

test("the season solver never does worse than maximising survival alone", () => {
  // The sweep picks a point on the survival/separation frontier by scoring each one on
  // the real objective, and plain survival (no penalty) is always one of the points it
  // considers. So the answer can tie that baseline but must never fall below it.
  const weeks = crowdLeads();
  for (const [poolSize, crowding] of [[13, 0], [13, 0.5], [137, 0.3], [137, 0.9]]) {
    const ranked = rankByPoolWin(weeks, { lossesAllowed: 1, poolSize, crowding });
    assert.ok(ranked.length > 0);
    const survivalFirst = [...ranked].sort((a, b) => b.survival - a.survival)[0];
    assert.ok(
      ranked[0].poolWin >= survivalFirst.poolWin - 1e-9,
      `size ${poolSize} crowding ${crowding}: chose ${ranked[0].poolWin}, ` +
        `survival-first was worth ${survivalFirst.poolWin}`,
    );
  }
});

test("with an uncorrelated field the solver has no reason to separate", () => {
  // At crowding 0 there is nothing to separate FROM, so paying anything for it is a
  // pure loss. The chosen line should therefore keep the crowd's teams.
  const weeks = crowdLeads();
  const ranked = rankByPoolWin(weeks, { lossesAllowed: 1, poolSize: 137, crowding: 0 });
  const shares = ranked[0].line.shared.filter(Boolean).length;
  assert.ok(shares > 0, "an uncorrelated field gives no reason to avoid the best teams");
});

test("a crowded field pushes the season off the crowd's teams", () => {
  const weeks = crowdLeads();
  const quiet = rankByPoolWin(weeks, { lossesAllowed: 1, poolSize: 137, crowding: 0 });
  const crowded = rankByPoolWin(weeks, { lossesAllowed: 1, poolSize: 137, crowding: 0.9 });
  const share = (r: typeof quiet) => r[0].line.shared.filter(Boolean).length;
  assert.ok(
    share(crowded) <= share(quiet),
    `crowded shared ${share(crowded)} weeks, quiet shared ${share(quiet)}`,
  );
});

// --- entries kept off each other -------------------------------------------------

test("a contested team is reported, not silently taken", () => {
  // The effect was visible and the cause was not: changing one entry's pick moves
  // another's, and which entry wins depends only on the order the pools are stored in.
  const weeks = twoTeamWeek();
  const plans = buildPoolWinPlans(
    weeks,
    [
      { used: [], size: 141, lossesAllowed: 1 },
      { used: [], size: 11, lossesAllowed: 1 },
    ],
    { crowding: 0 },
  );
  const first = plans[0].plan.picks[0]?.pick?.team;
  assert.ok(first, "the first entry should have a pick");
  // The first entry took it, so the second must be told it was kept off.
  assert.deepEqual(plans[1].keptOff, [first]);
  assert.deepEqual(plans[0].keptOff, [], "nothing was reserved before the first entry");
  assert.notEqual(plans[1].plan.picks[0]?.pick?.team, first);
});

test("a team already spent is not reported as kept off", () => {
  // It was never available to that entry, so naming it would explain the wrong thing.
  const weeks = twoTeamWeek();
  const plans = buildPoolWinPlans(
    weeks,
    [
      { used: [], size: 20, lossesAllowed: 0 },
      { used: [], size: 20, lossesAllowed: 0 },
    ],
    { crowding: 0 },
  );
  const taken = plans[0].plan.picks[0]!.pick!.team;
  const withSpent = buildPoolWinPlans(
    weeks,
    [
      { used: [], size: 20, lossesAllowed: 0 },
      { used: [taken], size: 20, lossesAllowed: 0 },
    ],
    { crowding: 0 },
  );
  assert.deepEqual(withSpent[1].keptOff, []);
});

test("a single entry is never kept off anything", () => {
  const plans = buildPoolWinPlans(twoTeamWeek(), [{ used: [], size: 20, lossesAllowed: 0 }], {
    crowding: 0,
  });
  assert.deepEqual(plans[0].keptOff, []);
});

// --- each pool's own crowding -----------------------------------------------------

test("a pool's own herding replaces the national figure as its evidence grows", () => {
  // The owner's big pool: 105 of 282 picks on the top team (37%), 124 alive.
  const big = { crowd: { top: 105, picks: 282 }, field: [42, 82] };
  const blended = poolCrowding(big, 0.276, true);
  assert.ok(blended > 0.33 && blended < 0.36, `big pool ${blended}`);
});

test("a small pool's two weeks cannot set the number on their own", () => {
  // 11 of 22 picks on the top team (50%): real herding, thin evidence. The national
  // figure counts as one more week of this pool.
  const small = { crowd: { top: 11, picks: 22 }, field: [2, 9] };
  const blended = poolCrowding(small, 0.276, true);
  assert.ok(Math.abs(blended - (11 + 11 * 0.276) / 33) < 1e-12, `small pool ${blended}`);
  assert.ok(blended > 0.276 && blended < 0.5, "between the two, pulled toward its own");
});

test("with no national figure, the pool's own ratio stands alone", () => {
  // Blending toward a zero nobody measured would invent a calm field.
  assert.equal(poolCrowding({ crowd: { top: 11, picks: 22 }, field: [2, 9] }, 0, false), 0.5);
});

test("with no measurement of its own, a pool uses the national figure", () => {
  assert.equal(poolCrowding({ field: [42, 82] }, 0.276, true), 0.276);
  assert.equal(poolCrowding({ crowd: { top: 0, picks: 0 } }, 0.276, true), 0.276);
});

test("each pool is planned against its own crowding, and the plan says which", () => {
  const weeks = twoTeamWeek();
  const plans = buildPoolWinPlans(
    weeks,
    [
      { used: [], size: 124, lossesAllowed: 1, field: [42, 82], crowd: { top: 105, picks: 282 } },
      { used: [], size: 20, lossesAllowed: 0 },
    ],
    { crowding: 0.276, crowdingMeasured: true },
  );
  assert.ok(Math.abs(plans[0].crowding - poolCrowding(plans[0].pool, 0.276, true)) < 1e-12);
  assert.equal(plans[1].crowding, 0.276, "a pool with no sheets keeps the national figure");
});

// --- the pool's sheet: every rival's history -------------------------------------------------------

function candidate(team: string, p: number) {
  return {
    team, opponent: `${team} opp`, home: true, commenceTime: "2026-09-27T17:00:00Z",
    winProbability: p, spread: -7, eventId: team,
  } as never;
}

/**
 * Three weeks. Buffalo is the safest team in week 3, so it is the assumed crowd team, and
 * Kansas City is week 4's favourite -- for whoever has not spent it.
 */
function season(): Week[] {
  return [
    { week: 3, startsAt: "2026-09-27T17:00:00Z", candidates: [
      candidate("Buffalo Bills", 0.86), candidate("Kansas City Chiefs", 0.8),
      candidate("San Francisco 49ers", 0.75), candidate("Seattle Seahawks", 0.7),
    ] },
    { week: 4, startsAt: "2026-10-04T17:00:00Z", candidates: [
      candidate("Kansas City Chiefs", 0.9), candidate("Detroit Lions", 0.82), candidate("Baltimore Ravens", 0.78),
    ] },
    { week: 5, startsAt: "2026-10-11T17:00:00Z", candidates: [
      candidate("Philadelphia Eagles", 0.8), candidate("Denver Broncos", 0.72),
    ] },
  ];
}

const R = 119;
const blank = (n = R) => ({ used: [] as string[], n });
const herdOn = (field: Field, week: number, team: string) =>
  field.blocs![week].find((b) => b.team === team)?.herd ?? 0;
const near = (a: number, b: number, tol = 1e-12) => Math.abs(a - b) < tol;

test("a sheet of blank histories is exactly the old greedy crowd", () => {
  const { field, crowdPicks } = fieldFromRivals(season(), { week: 3, groups: [blank()] }, R, 0.344, "Buffalo Bills");
  assert.deepEqual(crowdPicks.map((c) => c?.team), ["Buffalo Bills", "Kansas City Chiefs", "Philadelphia Eagles"]);
  for (const week of field.blocs!) {
    assert.equal(week.length, 1, "everyone alike means one bloc a week");
    assert.equal(week[0].herd, 1);
    assert.equal(week[0].fixed, 0);
  }
  assert.deepEqual(field.restProbabilities, [0.86, 0.9, 0.8]);
});

test("and it scores the same as having no sheet at all", () => {
  const base = { lossesAllowed: 1, poolSize: 120, crowding: 0.344, rivalLosses: [41, 79] };
  const none = rankByPoolWin(season(), base);
  const sheet = rankByPoolWin(season(), { ...base, rivals: { week: 3, groups: [blank()] } });
  assert.deepEqual(sheet.map((r) => r.candidate.team), none.map((r) => r.candidate.team));
  // Different dice (one draw per game rather than per week), so close rather than equal.
  for (const r of sheet) {
    const was = none.find((x) => x.candidate.team === r.candidate.team)!.poolWin;
    assert.ok(Math.abs(r.poolWin - was) / was < 0.05, `${r.candidate.team}: ${r.poolWin} vs ${was}`);
  }
});

test("a team a rival has spent is off their board: it only draws the rivals who still have it", () => {
  const { field } = fieldFromRivals(
    season(),
    { week: 3, groups: [{ used: ["Kansas City Chiefs"], n: 60 }, blank(59)] },
    R, 0.344, "Buffalo Bills",
  );
  assert.ok(near(herdOn(field, 1, "Kansas City Chiefs"), 59 / R));
  assert.ok(near(herdOn(field, 1, "Detroit Lions"), 60 / R), "the other 60 move to their next-best team");
});

test("this week's picks come off the board for next week", () => {
  const { field } = fieldFromRivals(
    season(),
    { week: 3, groups: [{ used: [], pick: "Kansas City Chiefs", n: 12 }, blank(107)] },
    R, 0.344, "Buffalo Bills",
  );
  assert.ok(near(herdOn(field, 1, "Kansas City Chiefs"), 107 / R), "the 12 on Kansas City cannot take them again");
  assert.ok(near(herdOn(field, 1, "Detroit Lions"), 12 / R));
});

test("every known pick counts on its own team, even a single one", () => {
  const { field, summary } = fieldFromRivals(
    season(),
    { week: 3, groups: [{ used: [], pick: "Seattle Seahawks", n: 1 }, blank(118)] },
    R, 0.344, "Buffalo Bills",
  );
  const seattle = field.blocs![0].find((b) => b.team === "Seattle Seahawks")!;
  assert.ok(near(seattle.fixed, 1 / R));
  assert.equal(seattle.herd, 0, "a pick already made is not scaled by the herding rate");
  assert.equal(summary.known, 1);
  assert.equal(summary.crowdTeam, "Buffalo Bills");
});

test("the biggest bloc is this week's crowd, counted and estimated together", () => {
  const { summary, crowdPicks } = fieldFromRivals(
    season(),
    { week: 3, groups: [{ used: ["Buffalo Bills"], pick: "Kansas City Chiefs", n: 50 }, blank(69)] },
    R, 0.344, "Buffalo Bills",
  );
  // 50 counted on Kansas City beats 69 x 34.4% = 23.7 herding onto Buffalo.
  assert.equal(summary.crowdTeam, "Kansas City Chiefs");
  assert.equal(summary.knownOnCrowd, 50);
  assert.equal(summary.moved, true);
  assert.equal(crowdPicks[0]?.team, "Kansas City Chiefs");
});

test("taking a team rivals are already on is scored as sharing its fate", () => {
  // One week, so nothing later differs: twelve known picks on Kansas City against the
  // same twelve on Seattle. Only whether you hold their ticket changes.
  const oneWeek = season().slice(0, 1);
  const base = { lossesAllowed: 1, poolSize: 120, crowding: 0.344, rivalLosses: [41, 79] };
  const on = (team: string) =>
    rankByPoolWin(oneWeek, { ...base, rivals: { week: 3, groups: [{ used: [], pick: team, n: 12 }, blank(107)] } })
      .find((x) => x.candidate.team === "Kansas City Chiefs")!.poolWin;
  assert.ok(on("Kansas City Chiefs") < on("Seattle Seahawks"), "twelve rivals on your ticket is less separation");
});

test("a sheet read for a later week than the one planned changes nothing", () => {
  const base = { lossesAllowed: 1, poolSize: 120, crowding: 0.344, rivalLosses: [41, 79] };
  const plain = rankByPoolWin(season(), base).map((r) => [r.candidate.team, r.poolWin]);
  const future = rankByPoolWin(season(), {
    ...base,
    rivals: { week: 4, groups: [{ used: [], pick: "Kansas City Chiefs", n: 60 }] },
  }).map((r) => [r.candidate.team, r.poolWin]);
  assert.deepEqual(future, plain);
});

test("last week's sheet still counts as history, but none of its picks as this week's", () => {
  const { field, summary } = fieldFromRivals(
    season(),
    { week: 2, groups: [{ used: [], pick: "Kansas City Chiefs", n: 60 }] },
    R, 0.344, "Buffalo Bills",
  );
  assert.equal(summary.known, 0);
  assert.ok(near(herdOn(field, 1, "Kansas City Chiefs"), 59 / R), "the 60 spent Kansas City last week");
});

test("picks and spent teams the schedule does not know are counted, never silently dropped", () => {
  const { summary } = fieldFromRivals(
    season(),
    { week: 3, groups: [
      { used: [], pick: "Green Bay Packers", n: 5 },
      { used: ["Philly"], n: 2 },
      blank(112),
    ] },
    R, 0.344, "Buffalo Bills",
  );
  assert.equal(summary.unmatched, 5);
  assert.equal(summary.known, 0);
  assert.equal(summary.unknownUsed, 2);
});

test("taking the team the whole field is playing against wins exactly when they lose", () => {
  // One week, every rival on A. Take B, A's opponent: you are the only survivor when A
  // loses and out when A wins, so the pool is yours with probability 1 - P(A wins).
  const field: Field = {
    probabilities: [0.7],
    crowding: 0.5,
    blocs: [[{ team: "A", opponent: "B", eventId: "g", probability: 0.7, fixed: 1, herd: 0 }]],
    events: [["g"]],
  };
  const prepared = prepareField(field, 1, 0);
  const win = lastStandingWin({ mine: [0.3], shared: [false], teams: ["B"] }, prepared, 11);
  assert.ok(Math.abs(win - 0.3) < 0.02, `got ${win}`);
});

test("two blocs on one game can never both win", () => {
  const field: Field = {
    probabilities: [0.6],
    crowding: 0.5,
    blocs: [[
      { team: "A", opponent: "B", eventId: "g", probability: 0.6, fixed: 0.5, herd: 0 },
      { team: "B", opponent: "A", eventId: "g", probability: 0.4, fixed: 0.5, herd: 0 },
    ]],
    events: [["g"]],
  };
  const prepared = prepareField(field, 1, 0, 2000);
  let aLost = 0;
  for (let s = 0; s < 2000; s += 1) {
    const w = prepared.blocWidth!;
    assert.equal(prepared.blocLost![s * w] + prepared.blocLost![s * w + 1], 1);
    aLost += prepared.blocLost![s * w];
  }
  assert.ok(Math.abs(aLost / 2000 - 0.4) < 0.04);
});
