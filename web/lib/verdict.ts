/**
 * When a win rate has earned a verdict, and when it has not.
 *
 * The page could already show a percentage. What it could not say is whether that
 * percentage means anything yet, which is the only question worth asking of it — and
 * the one a bare number invites you to answer wrongly. 61.4% from a hundred games looks
 * exactly as authoritative as 61.4% from ten thousand.
 *
 * The bar is break-even, not a coin flip. At -110 you risk $1.10 to win $1.00, so a
 * coin flip loses 4.5 cents of every dollar and 52.38% is where a rule stops costing
 * money. Judging against 50% sets the bar two and a half points low and lets a losing
 * rule read as a finding.
 *
 * Three states, and the third is the usual one:
 *
 *   CLEARS    the interval sits entirely above break-even
 *   FAILS     it sits entirely below
 *   UNDECIDED it straddles, and the honest output is how much more is needed
 *
 * "Needed" is the sample at which the interval would stop straddling IF the observed
 * rate held. It is a projection, not a promise: a rate that drifts toward break-even
 * pushes the finish line away faster than games arrive, which is itself the answer.
 *
 * The critical value is a parameter because the same record can be asked one question
 * or many. Read on its own, a slice gets 1.96. Picked as the best of six, it does not:
 * see `zForFamily`.
 */

import { probit } from "./stats";

/** Break-even at -110: a winner returns 100/110, a loser costs the stake. */
export const BREAK_EVEN = 110 / 210;

/** Return per dollar staked at -110, given how often the pick wins. */
export function roiAt(rate: number): number {
  return rate * (100 / 110) - (1 - rate);
}

export type VerdictState = "clears" | "fails" | "undecided" | "no-data";

export interface Judgement {
  n: number;
  hits: number;
  rate: number | null;
  /** 95% interval on the rate. */
  lo: number;
  hi: number;
  state: VerdictState;
  /**
   * Settled games at which the interval would stop straddling break-even, if the
   * observed rate held. Null when there is no data, or when the rate IS break-even and
   * no sample would separate them.
   */
  needed: number | null;
  /** How many more than are in hand now. */
  moreNeeded: number | null;
  /** Return per dollar at the observed rate. */
  roi: number | null;
}

/** 95% two-sided, when one question is being asked. */
export const Z = 1.96;

/**
 * The critical value for ONE cell when `k` of them are being compared.
 *
 * Bonferroni: spend the 5% across every comparison rather than on each. Slicing a
 * record six ways and reading the best cell is not six independent questions, it is one
 * question — "is any of these good?" — and answering it at 1.96 finds something about a
 * quarter of the time in a record with no edge anywhere in it.
 *
 * Conservative, and deliberately so. The cost of the strict version is missing a real
 * edge for another month; the cost of the loose one is betting money on a coincidence.
 */
export function zForFamily(k: number): number {
  if (!Number.isFinite(k) || k <= 1) return Z;
  return probit(1 - 0.05 / (2 * k));
}

export function judge(
  hits: number,
  n: number,
  breakEven = BREAK_EVEN,
  /** Raise it when this is one slice of many; see `zForFamily`. */
  z: number = Z,
): Judgement {
  if (n <= 0) {
    return { n: 0, hits: 0, rate: null, lo: 0, hi: 1, state: "no-data", needed: null, moreNeeded: null, roi: null };
  }
  const rate = hits / n;
  const half = z * Math.sqrt((rate * (1 - rate)) / n);
  const lo = Math.max(0, rate - half);
  const hi = Math.min(1, rate + half);

  const state: VerdictState = lo > breakEven ? "clears" : hi < breakEven ? "fails" : "undecided";

  // How large a sample makes the half-width smaller than the distance to break-even.
  const gap = Math.abs(rate - breakEven);
  const needed =
    gap < 1e-9 ? null : Math.ceil((z / gap) ** 2 * rate * (1 - rate));

  return {
    n,
    hits,
    rate,
    lo,
    hi,
    state,
    needed,
    moreNeeded: needed === null ? null : Math.max(0, needed - n),
    roi: roiAt(rate),
  };
}

/**
 * When the verdict is likely to arrive, given how fast games are settling.
 *
 * Null when the rate is not settling, or when nothing is arriving — both of which are
 * more honest than a date computed from a rate of zero.
 */
export function projectDate(
  moreNeeded: number | null,
  gradesPerWeek: number,
  from = new Date(),
): Date | null {
  if (moreNeeded === null || moreNeeded <= 0) return null;
  if (!Number.isFinite(gradesPerWeek) || gradesPerWeek <= 0) return null;
  const weeks = moreNeeded / gradesPerWeek;
  // Past a season there is no useful date to give: the answer is "not this year".
  if (weeks > 52) return null;
  const out = new Date(from);
  out.setDate(out.getDate() + Math.ceil(weeks * 7));
  return out;
}

/** One line of plain English for whichever state applies. */
export function verdictLine(j: Judgement, what: string): string {
  if (j.state === "no-data") return `No ${what} settled yet.`;
  const rate = `${(j.rate! * 100).toFixed(1)}%`;
  const band = `${(j.lo * 100).toFixed(1)}–${(j.hi * 100).toFixed(1)}%`;
  if (j.state === "clears") {
    return `${what} clears the vig: ${rate} over ${j.n}, and the whole 95% range (${band}) pays.`;
  }
  if (j.state === "fails") {
    return `${what} does not clear the vig: ${rate} over ${j.n}, and the whole 95% range (${band}) loses.`;
  }
  return `${what} is undecided: ${rate} over ${j.n}, but the 95% range (${band}) still contains break-even.`;
}
