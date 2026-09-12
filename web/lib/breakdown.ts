/**
 * The record, cut by market and by league.
 *
 * The point of cutting it is to find where the rule actually works, and the danger of
 * cutting it is that a small record always contains a cell that looks like it works.
 * Three markets across two leagues is six cells; at a hundred graded alerts that is
 * about seventeen games each, and seventeen games produces a 70% win rate roughly one
 * time in eight from a rule with no edge whatsoever. Six chances at that, and the board
 * will show you something convincing almost every time.
 *
 * So every cell is judged twice. `alone` is the verdict if that slice were the only
 * question ever asked of the record — which is the number a naive table would print,
 * and the one that is wrong to act on. `adjusted` spends the same 5% across all six
 * comparisons, which is the honest reading when the plan is to look at the table and
 * bet whichever cell won.
 *
 * On top of that, `selection` answers the question the table itself provokes: given
 * that the best cell reads what it reads, how often would SOME cell look at least that
 * good if nothing here had any edge at all? That number is usually the one that settles
 * the argument, and it is usually much larger than people expect.
 */
import type { League, Market } from "./types";
import { binomialTailAtLeast } from "./stats";
import { BREAK_EVEN, judge, zForFamily, type Judgement } from "./verdict";

/**
 * The least a row needs to be counted.
 *
 * Both graded sources fit it — line-movement alerts and cross-book edges — so one
 * breakdown serves both and the two can never drift into disagreeing about what a
 * push does to a denominator.
 */
export interface Gradeable {
  market: Market;
  league: League;
  /** Null means push: neither a hit nor a miss. */
  result_covered: boolean | null;
  result_push: boolean;
}

export const MARKETS: Market[] = ["spread", "total", "moneyline"];
export const LEAGUES: League[] = ["nfl", "ncaaf"];

export type MarketFilter = Market | "all";
export type LeagueFilter = League | "all";

export interface Cell {
  market: MarketFilter;
  league: LeagueFilter;
  label: string;
  /** Settled and not a push. Only these carry a rate. */
  decided: number;
  covered: number;
  pushes: number;
  rate: number | null;
  /** Verdict as if this slice were the only question asked. Do not act on this one. */
  alone: Judgement;
  /** Verdict knowing it is one of several compared. */
  adjusted: Judgement;
  /** One-sided probability of a rate this high from a cell with no edge. */
  p: number | null;
}

export interface Selection {
  /** How many cells carry enough data to be compared at all. */
  compared: number;
  best: Cell | null;
  /**
   * Probability that at least one cell would read as well as the best one does, if
   * every cell were exactly break-even.
   *
   * Exact under independence: for each cell, the chance IT alone would reach the best
   * observed rate, combined across cells. Unequal sample sizes are handled properly,
   * which matters here because the cells are nothing like equal.
   *
   * Null when no cell has data.
   */
  familyP: number | null;
}

export interface Breakdown {
  cells: Cell[];
  selection: Selection;
  breakEven: number;
}

function matches(grade: Gradeable, market: MarketFilter, league: LeagueFilter): boolean {
  if (market !== "all" && grade.market !== market) return false;
  if (league !== "all" && grade.league !== league) return false;
  return true;
}

/** Grades left after a filter. Exported because the page filters more than the table. */
export function filterGrades<T extends Gradeable>(
  grades: T[],
  market: MarketFilter,
  league: LeagueFilter,
): T[] {
  return grades.filter((g) => matches(g, market, league));
}

export function labelFor(market: MarketFilter, league: LeagueFilter): string {
  const m = market === "all" ? "All markets" : market === "moneyline" ? "Moneyline" : market === "total" ? "Total" : "Spread";
  const l = league === "all" ? "both leagues" : league.toUpperCase();
  return `${m} · ${l}`;
}

function cell(
  grades: Gradeable[],
  market: MarketFilter,
  league: LeagueFilter,
  breakEven: number,
  z: number,
): Cell {
  const slice = filterGrades(grades, market, league);
  // A push is neither a hit nor a miss and must leave the denominator, or every rule
  // that lands on key numbers reads worse than it is.
  const decidedRows = slice.filter((g) => g.result_covered !== null);
  const covered = decidedRows.filter((g) => g.result_covered).length;
  const decided = decidedRows.length;

  return {
    market,
    league,
    label: labelFor(market, league),
    decided,
    covered,
    pushes: slice.filter((g) => g.result_push).length,
    rate: decided > 0 ? covered / decided : null,
    alone: judge(covered, decided, breakEven),
    adjusted: judge(covered, decided, breakEven, z),
    p: decided > 0 ? binomialTailAtLeast(covered, decided, breakEven) : null,
  };
}

/**
 * Every market/league cell, plus the selection effect of reading them together.
 *
 * `minCompared` keeps cells with almost nothing in them out of the selection maths
 * rather than out of the table. A cell of two games shows a 100% rate and contributes
 * nothing but noise to "how often would the best look this good" — but hiding it would
 * leave the impression that the record has no moneyline alerts at all, which is a
 * different and worse lie.
 */
export function buildBreakdown(
  grades: Gradeable[],
  { breakEven = BREAK_EVEN, minCompared = 5 }: { breakEven?: number; minCompared?: number } = {},
): Breakdown {
  const combos: Array<[MarketFilter, LeagueFilter]> = [];
  for (const market of MARKETS) for (const league of LEAGUES) combos.push([market, league]);

  const z = zForFamily(combos.length);
  const cells = combos.map(([market, league]) => cell(grades, market, league, breakEven, z));

  const comparable = cells.filter((c) => c.decided >= minCompared && c.rate !== null);
  let best: Cell | null = null;
  for (const candidate of comparable) {
    if (!best || candidate.rate! > best.rate!) best = candidate;
  }

  let familyP: number | null = null;
  if (best && best.rate !== null) {
    // For each cell, the chance it alone would reach the best observed rate. Combined
    // as 1 - prod(1 - q), which is the probability that ANY of them does.
    let noneReach = 1;
    for (const c of comparable) {
      const needed = Math.ceil(best.rate * c.decided - 1e-9);
      noneReach *= 1 - binomialTailAtLeast(needed, c.decided, breakEven);
    }
    familyP = Math.min(1, Math.max(0, 1 - noneReach));
  }

  return { cells, selection: { compared: comparable.length, best, familyP }, breakEven };
}
