/**
 * The line-shopping record, judged the way it has to be: by money, one result at a time.
 *
 * Two things the generic breakdown gets wrong for these picks, and why each matters.
 *
 * **Break-even depends on the price.** The breakdown asks whether a cell wins more than
 * 52.4% -- the right bar for a -110 bet and the wrong one for almost anything else. A
 * +300 underdog breaks even winning 25%, so a moneyline cell winning 43% could be
 * making money while the grid reads it as a failure, and a cell of heavy favourites
 * winning 60% could be losing. So each cell here reports the return actually made per
 * dollar, at the prices actually taken, next to the return that was predicted.
 *
 * The verdict is price-aware too. If every pick were priced exactly fair, profit would
 * average zero, and a pick paying `b` per dollar has variance exactly `b` (win b with
 * probability 1/(1+b), lose 1 otherwise). Summing those gives the spread a record of
 * mixed prices should show from luck alone, and the verdict only calls a cell when its
 * return sits outside that -- widened, as the breakdown's is, for six cells compared.
 *
 * **Several books on the same number are one result.** Picks are recorded per book, so
 * when FanDuel and BetMGM both offer the better line on one game, that game is counted
 * twice and decided once. Thirty-one "picks" might be twenty games, and the record would
 * look twice as sure of itself as it is. So picks on the same game, market, side and
 * line collapse to one result before anything is counted. Different lines stay separate
 * -- a -3 and a -3.5 can finish differently -- and so do different markets, which is why
 * a slice spanning markets is still a little over-counted.
 */
import {
  filterGrades,
  labelFor,
  LEAGUES,
  MARKETS,
  type LeagueFilter,
  type MarketFilter,
} from "./breakdown";
import { profitPerDollar } from "./profit-boost";
import { upperTail } from "./stats";
import type { League, Market, ShopGrade } from "./types";
import { Z, zForFamily } from "./verdict";

export type Part = "over" | "under" | "favourite" | "underdog";

/** The half of its market a pick is on. Null when it cannot be told. */
export function partOf(market: Market, side: string, line: number | null, price: number | null): Part | null {
  if (market === "total") return side === "over" ? "over" : side === "under" ? "under" : null;
  if (market === "spread" && line !== null && line !== 0) return line < 0 ? "favourite" : "underdog";
  if (price === null) return null;
  // A moneyline (or a pick'em spread) is decided by the price: the side laying odds is
  // the favourite. Even money has no favourite.
  return price < 0 && price !== -100 ? "favourite" : price > 100 ? "underdog" : null;
}

export interface OutcomeRow {
  key: string;
  eventId: string | null;
  league: League;
  market: Market;
  side: string;
  /**
   * Which half of the market this is: over/under for a total, favourite/underdog for a
   * spread (by the line; a pick'em by the price) or a moneyline (by the price).
   */
  part: Part | null;
  books: string[];
  /** How many recorded picks this one result stands for. */
  copies: number;
  /** Profit per $1 if it wins, averaged over the books that offered it. */
  profit: number;
  fair_probability: number;
  expected_roi: number | null;
  result_covered: boolean | null;
  result_push: boolean;
}

/**
 * One row per outcome.
 *
 * The result is part of the key on purpose. Picks sharing a game, market, side and line
 * cannot finish differently -- so if they ever appear to, something upstream is wrong,
 * and splitting them keeps the disagreement visible instead of averaging it away. A pick
 * with no game id (an older row the join could not match) stays on its own rather than
 * being guessed into a group.
 */
export function collapseByOutcome(grades: ShopGrade[]): OutcomeRow[] {
  const groups = new Map<string, ShopGrade[]>();
  for (const g of grades) {
    if (g.price === null || !Number.isFinite(profitPerDollar(g.price))) continue;
    const result = g.result_push ? "push" : String(g.result_covered);
    const key = g.event_id
      ? `${g.event_id}|${g.market}|${g.side}|${g.line ?? ""}|${result}`
      : `pick:${g.pick_id}`;
    groups.set(key, [...(groups.get(key) ?? []), g]);
  }

  const out: OutcomeRow[] = [];
  for (const [key, rows] of groups) {
    const first = rows[0];
    const mean = (values: number[]) => values.reduce((a, b) => a + b, 0) / values.length;
    const rois = rows.map((r) => r.expected_roi).filter((v): v is number => v !== null);
    out.push({
      key,
      eventId: first.event_id ?? null,
      league: first.league,
      market: first.market,
      side: first.side,
      part: partOf(first.market, first.side, first.line, first.price),
      books: [...new Set(rows.map((r) => r.book).filter((b): b is string => Boolean(b)))],
      copies: rows.length,
      profit: mean(rows.map((r) => profitPerDollar(r.price as number))),
      fair_probability: mean(rows.map((r) => r.fair_probability)),
      expected_roi: rois.length > 0 ? mean(rois) : null,
      result_covered: first.result_covered,
      result_push: first.result_push,
    });
  }
  return out;
}

export interface RoiCell {
  market: MarketFilter;
  league: LeagueFilter;
  label: string;
  /** Results, pushes included: a push returned the stake, so it was still a bet. */
  games: number;
  decided: number;
  wins: number;
  pushes: number;
  winRate: number | null;
  /** Total profit from $1 on each result. */
  profit: number;
  /** Profit per $1 staked. */
  roi: number | null;
  /** What the picks predicted, per $1, when they were made. */
  expectedRoi: number | null;
  /** How far luck alone would spread `profit`, if every pick were priced fair. */
  nullSd: number;
  lo: number | null;
  hi: number | null;
  state: "clears" | "fails" | "undecided" | "no-data";
}

export function roiCell(
  rows: OutcomeRow[],
  market: MarketFilter,
  league: LeagueFilter,
  zCritical: number = Z,
  /** Narrow to one half of the market: over/under, favourite/underdog. */
  part?: Part,
): RoiCell {
  const slice = filterGrades(rows, market, league).filter((r) => !part || r.part === part);
  let profit = 0;
  let variance = 0;
  let wins = 0;
  let pushes = 0;
  let expectedSum = 0;
  let expectedCount = 0;
  for (const r of slice) {
    if (r.expected_roi !== null) {
      expectedSum += r.expected_roi;
      expectedCount += 1;
    }
    if (r.result_push || r.result_covered === null) {
      pushes += 1;
      continue;
    }
    variance += r.profit;
    if (r.result_covered) {
      wins += 1;
      profit += r.profit;
    } else {
      profit -= 1;
    }
  }

  const games = slice.length;
  const decided = games - pushes;
  const nullSd = Math.sqrt(variance);
  if (games === 0) {
    return {
      market, league, label: labelFor(market, league), games, decided, wins, pushes,
      winRate: null, profit: 0, roi: null, expectedRoi: null, nullSd, lo: null, hi: null,
      state: "no-data",
    };
  }
  const roi = profit / games;
  const halfWidth = (zCritical * nullSd) / games;
  const lo = roi - halfWidth;
  const hi = roi + halfWidth;
  return {
    market,
    league,
    label: labelFor(market, league),
    games,
    decided,
    wins,
    pushes,
    winRate: decided > 0 ? wins / decided : null,
    profit,
    roi,
    expectedRoi: expectedCount > 0 ? expectedSum / expectedCount : null,
    nullSd,
    lo,
    hi,
    state: decided === 0 ? "no-data" : lo > 0 ? "clears" : hi < 0 ? "fails" : "undecided",
  };
}

/** The halves each market splits into. */
export const PARTS: Record<Market, [Part, Part]> = {
  spread: ["favourite", "underdog"],
  total: ["over", "under"],
  moneyline: ["favourite", "underdog"],
};

export interface RoiBreakdown {
  cells: RoiCell[];
  /**
   * The same cells split in half: over/under, favourite/underdog. Judged as their own
   * family of twelve, so a split cell has to clear a stricter bar than a whole one --
   * cutting a record finer is more looks, and each look is another chance at a fluke.
   * Kept out of `best` and `familyP`, which describe the six whole cells.
   */
  parts: Array<RoiCell & { part: Part }>;
  best: RoiCell | null;
  /** How many cells had enough results to be compared. */
  compared: number;
  /**
   * Chance that SOME cell would show a return at least as good as the best one's if
   * every pick were priced fair. Null with nothing to compare.
   */
  familyP: number | null;
  /** Recorded picks before collapsing, for the "N picks were M results" line. */
  picks: number;
  results: number;
}

export function buildRoiBreakdown(rows: OutcomeRow[], minCompared = 5): RoiBreakdown {
  const combos: Array<[MarketFilter, LeagueFilter]> = [];
  for (const m of MARKETS) for (const l of LEAGUES) combos.push([m, l]);
  const z = zForFamily(combos.length);
  const cells = combos.map(([m, l]) => roiCell(rows, m, l, z));

  const comparable = cells.filter((c) => c.decided >= minCompared && c.roi !== null && c.nullSd > 0);
  let best: RoiCell | null = null;
  for (const c of comparable) if (!best || (c.roi as number) > (best.roi as number)) best = c;

  let familyP: number | null = null;
  if (best && best.roi !== null) {
    let noneReach = 1;
    for (const c of comparable) {
      // The profit this cell would need to match the best return, in units of its
      // own luck-only spread.
      noneReach *= 1 - upperTail((best.roi * c.games) / c.nullSd);
    }
    familyP = Math.min(1, Math.max(0, 1 - noneReach));
  }

  const partCombos: Array<[Market, LeagueFilter, Part]> = [];
  for (const m of MARKETS) for (const l of LEAGUES) for (const part of PARTS[m]) partCombos.push([m, l, part]);
  const zParts = zForFamily(partCombos.length);
  const parts = partCombos.map(([m, l, part]) => ({ ...roiCell(rows, m, l, zParts, part), part }));

  return {
    cells,
    parts,
    best,
    compared: comparable.length,
    familyP,
    picks: rows.reduce((sum, r) => sum + r.copies, 0),
    results: rows.length,
  };
}
