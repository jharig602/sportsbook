import type { BoardEdge } from "./board-shop";
import { isBlowout } from "./blowout";

/**
 * The cheapest way to back a team you are betting on anyway.
 *
 * This deliberately does not answer "should I bet the Lions". That decision is already
 * made, every week, and pretending the board has a say in it would be dishonest in both
 * directions — it would sometimes tell you not to, which you will ignore, and sometimes
 * tell you to, which it has not earned.
 *
 * What is still open is WHICH market. The same game offers a spread, a moneyline and a
 * total at different prices, and they are not equally good:
 *
 *   - A moneyline on a favourite is where the vig bites hardest. It asks the least of
 *     the team and charges the most for it.
 *   - A spread at a book that hangs a different number to the rest is where the only
 *     real edge on this board ever comes from.
 *   - A moneyline on an underdog pays long odds, which the model prices from the spread
 *     rather than from the implied probability — the implied number carries the
 *     favourite-longshot bias.
 *
 * So: every way to back this team this week, ranked by what each costs, with the honest
 * note that the least bad is frequently still negative.
 */

export interface BackingOption {
  row: BoardEdge;
  /** True when this is the side backing the favourite team. */
  team: string;
  /** Expected return per dollar. Usually negative; that is the finding, not a bug. */
  expectedRoi: number;
}

export interface BackingPlan {
  team: string;
  /** Every market at every book, best return first. */
  options: BackingOption[];
  /** The cheapest way in. Null when the team is not on the board this week. */
  best: BackingOption | null;
  /** True when even the best option loses money in expectation. */
  allNegative: boolean;
  /** Options at books you actually hold, which is the list that can be acted on. */
  atMyBooks: BackingOption[];
}

/**
 * Which side of a row backs this team.
 *
 * Totals are excluded outright rather than guessed at: an over is not a way of backing
 * a team, and including it would answer a different question than the one asked.
 */
function backsTeam(row: BoardEdge, team: string): boolean {
  if (row.market === "total") return false;
  const side = row.side === "home" ? row.homeTeam : row.side === "away" ? row.awayTeam : null;
  return side === team;
}

export function planBacking(
  rows: BoardEdge[],
  team: string,
  options: { myBooks?: string[]; maxSpread?: number } = {},
): BackingPlan {
  const myBooks = options.myBooks ?? [];
  const eligible = rows.filter(
    (row) =>
      backsTeam(row, team) &&
      row.expectedRoi !== null &&
      !row.stale &&
      (options.maxSpread === undefined || !isBlowout(row.gameSpread, options.maxSpread)),
  );

  const all: BackingOption[] = eligible
    .map((row) => ({ row, team, expectedRoi: row.expectedRoi as number }))
    .sort((a, b) => b.expectedRoi - a.expectedRoi);

  const atMyBooks = all.filter((o) => myBooks.includes(o.row.book));
  // The best you can actually place beats the best that exists but is out of reach.
  const best = atMyBooks[0] ?? all[0] ?? null;

  return {
    team,
    options: all,
    best,
    allNegative: all.length > 0 && all.every((o) => o.expectedRoi <= 0),
    atMyBooks,
  };
}

/**
 * How much the choice of market is worth, in cents per dollar staked.
 *
 * The number that makes this feature worth having. If backing the Lions on the spread
 * instead of the moneyline saves four cents on the dollar, that is four cents a week
 * for a decision you were making anyway — small, certain, and larger than most of the
 * edges this board ever finds.
 */
export function spreadOfOptions(plan: BackingPlan): number | null {
  const list = plan.atMyBooks.length > 1 ? plan.atMyBooks : plan.options;
  if (list.length < 2) return null;
  return list[0].expectedRoi - list[list.length - 1].expectedRoi;
}
