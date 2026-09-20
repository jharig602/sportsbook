/**
 * Same-game parlays: what one is worth, and which one is worth looking at today.
 *
 * `joint-score.ts` answers how often a set of legs all land. This turns that into the
 * only number that decides anything — **the price the book has to beat** — and picks
 * candidates off the board.
 *
 * ## The number that matters
 *
 * A book does not publish how it marks up a same-game parlay, and nothing in this
 * database holds its SGP price. So the honest product is not "this ticket is +7%"; it is
 * "this ticket is fair at +420, go and look". That is a smaller claim and a more useful
 * one: it is checkable in five seconds on the bet slip, and it cannot be wrong in the
 * quiet way an invented edge is wrong.
 *
 * Two prices are reported beside the fair one, and the gap between them is the point:
 *
 * - **Independent** — what the legs would pay if they came from different games, the
 *   product of their offered prices. A book always pays less than this on one game.
 * - **Fair** — what this ticket is actually worth, from the joint model.
 *
 * `markupBudget` is how far the book may mark the ticket down from the independent
 * price before it stops being worth taking. Positive means there is room; negative means
 * the legs are not good enough for any SGP price to rescue, and no amount of shopping
 * will help.
 *
 * ## Bonus bets, which is what prompted this
 *
 * A bonus bet does not return its stake, so only the profit is real and the conversion
 * rate is `1 - 1/d`: a +100 bonus bet converts at 50%, a +900 one at 90%. That pushes
 * hard toward long prices, and a same-game parlay is the cheapest long price on the
 * board — provided it is a real one. `sgpEv` takes a `bonus` flag for exactly this, and
 * the pull toward length is why the fair price matters more here than anywhere else: the
 * tickets that convert best are also the ones where a markup hides most easily.
 *
 * ## What the automatic pick can and cannot see
 *
 * Candidates are built from legs this app has prices for, which is spreads, totals and
 * moneylines. **Team totals are the best same-game legs and are not here**, because no
 * feed in this project prices them — the shop pulls `h2h,spreads,totals` and nothing
 * else. The builder will price a team-total leg perfectly well when the price is typed
 * in, since `joint-score.ts` handles it; the automatic pick simply cannot find one on
 * its own. That is a gap in the data, not in the model, and it is worth saying out loud
 * rather than quietly ranking a worse ticket first.
 */
import type { BoardEdge } from "./board-shop";
import { type GameLines, type ScoreLeg, type ScoreModel, jointProbability, independentProduct } from "./joint-score";
import { toAmerican } from "./parlay";
import type { MarginModel } from "./probability";
import { decimalFrom } from "./promo-ev";
import type { Market, Side } from "./types";

export interface SgpQuote {
  legs: ScoreLeg[];
  win: number;
  push: number;
  loss: number;
  pushPossible: boolean;
  /**
   * The decimal price at which this ticket breaks even, pushes included.
   *
   * A push returns the stake, so the ticket only has to pay on the winning branch:
   * `win * d + push = 1`. Null when the legs cannot all land, which is the right answer
   * for a ticket with no price at all rather than a very large one.
   */
  fairDecimal: number | null;
  fairAmerican: number | null;
  /** What the model would have said if the legs came from different games. */
  independentWin: number;
  /**
   * How far correlation moves the ticket, as a fraction of the independent chance.
   *
   * Positive means the legs help each other and the ticket is likelier than the product
   * — the case a book charges the most for. Negative means they fight, and the book's
   * generic markup may be charging for a correlation running the other way.
   */
  correlationShift: number;
}

/** Price a set of legs from one game. */
export function priceSameGame(
  margin: MarginModel,
  score: ScoreModel,
  lines: GameLines,
  legs: ScoreLeg[],
): SgpQuote | null {
  const joint = jointProbability(margin, score, lines, legs);
  if (joint === null) return null;
  const independent = independentProduct(margin, score, lines, legs) ?? 0;

  const fairDecimal = joint.win > 0 ? (1 - joint.push) / joint.win : null;
  return {
    legs,
    win: joint.win,
    push: joint.push,
    loss: joint.loss,
    pushPossible: joint.pushPossible,
    fairDecimal,
    fairAmerican: fairDecimal === null ? null : toAmerican(fairDecimal),
    independentWin: independent,
    correlationShift: independent > 0 ? joint.win / independent - 1 : 0,
  };
}

/**
 * Expected return per dollar at a price the book is actually offering.
 *
 * Cash: the stake is at risk, a push returns it, and the fair price makes this exactly
 * zero — which is the check worth keeping in mind when reading it.
 *
 * Bonus: the stake is never returned, so a loss costs nothing and only the profit
 * counts. The push branch is left out rather than guessed at; books generally re-credit
 * a bonus bet whose ticket voids, but that is their policy and not arithmetic, so
 * pretending to know it would put an invented number next to a real one.
 */
export function sgpEv(
  quote: SgpQuote,
  offeredAmerican: number,
  options: { bonus?: boolean } = {},
): number | null {
  if (!Number.isFinite(offeredAmerican) || Math.abs(offeredAmerican) < 100) return null;
  const d = decimalFrom(offeredAmerican);
  if (options.bonus) return quote.win * (d - 1);
  return quote.win * d - (1 - quote.push);
}

/** A leg the board can actually price, ready to be combined. */
export interface PricedLeg {
  leg: ScoreLeg;
  price: number;
  market: Market;
  side: Side;
  line: number | null;
  label: string;
  /** The cross-book edge measured for this leg on its own, in percentage points. */
  edgePoints: number | null;
}

export interface SgpGame {
  eventId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  lines: GameLines;
  legs: PricedLeg[];
}

export interface SgpPick {
  game: SgpGame;
  legs: PricedLeg[];
  quote: SgpQuote;
  /** Product of the legs' offered prices: what a cross-game parlay of them would pay. */
  independentDecimal: number;
  independentAmerican: number;
  /** How far the book may mark this down from the independent price and still be worth it. */
  markupBudget: number;
  /** What a bonus bet of this face value converts to, at the fair price. */
  bonusConversion: number | null;
}

/** Turn a board row into a leg the score model understands. */
export function legFor(market: Market, side: Side, line: number | null): ScoreLeg | null {
  if (market === "moneyline" && (side === "home" || side === "away")) {
    return { market: "moneyline", side };
  }
  if (market === "spread" && (side === "home" || side === "away")) {
    return line === null ? null : { market: "spread", side, line };
  }
  if (market === "total" && (side === "over" || side === "under")) {
    return line === null ? null : { market: "total", side, line };
  }
  return null;
}

/** Every combination of `size` legs, in order. */
function combinations<T>(items: T[], size: number): T[][] {
  if (size === 0) return [[]];
  const out: T[][] = [];
  for (let i = 0; i <= items.length - size; i += 1) {
    for (const rest of combinations(items.slice(i + 1), size - 1)) {
      out.push([items[i], ...rest]);
    }
  }
  return out;
}

export interface SgpOptions {
  minLegs?: number;
  maxLegs?: number;
  limit?: number;
  /** Games already carrying a bet, which are excluded so the pick is something new. */
  exclude?: Set<string>;
  /** Rank for a bonus bet, which wants length, rather than for cash. */
  bonus?: boolean;
}

/**
 * The same-game tickets worth a look, best first.
 *
 * Ranked by `markupBudget`: how much correlation markup the ticket can absorb before it
 * stops paying. That is the right statistic because it is the only one that combines
 * both things that decide the bet — whether the legs beat their own prices, and whether
 * correlation makes the ticket likelier or less likely than the product implies.
 *
 * Ranking by fair price instead would be worse than useless. A bonus bet converts better
 * at longer odds, so "longest price" would sort a five-leg lottery ticket to the top
 * every time, and its fair price would be long precisely because it almost never wins.
 * For a bonus bet the length is a tie-breaker among tickets that already pay, never the
 * reason to take one.
 */
export function bestSameGameParlays(
  games: SgpGame[],
  margins: Record<string, MarginModel>,
  scores: Record<string, ScoreModel>,
  options: SgpOptions = {},
): SgpPick[] {
  const minLegs = Math.max(2, options.minLegs ?? 2);
  const maxLegs = Math.max(minLegs, options.maxLegs ?? 3);
  const picks: SgpPick[] = [];

  for (const game of games) {
    if (options.exclude?.has(game.eventId)) continue;
    const margin = margins[game.league];
    const score = scores[game.league];
    if (!margin || !score) continue;

    for (let size = minLegs; size <= maxLegs; size += 1) {
      for (const combo of combinations(game.legs, size)) {
        // Two sides of one market cannot both land; the model would say 0% and the
        // ticket would sort last anyway, but skipping is cheaper and clearer.
        if (opposed(combo)) continue;

        const quote = priceSameGame(margin, score, game.lines, combo.map((l) => l.leg));
        if (quote === null || quote.fairDecimal === null || quote.win <= 0) continue;

        let independentDecimal = 1;
        for (const leg of combo) independentDecimal *= decimalFrom(leg.price);

        picks.push({
          game,
          legs: combo,
          quote,
          independentDecimal,
          independentAmerican: toAmerican(independentDecimal),
          markupBudget: independentDecimal / quote.fairDecimal - 1,
          bonusConversion: 1 - 1 / quote.fairDecimal,
        });
      }
    }
  }

  picks.sort((a, b) => {
    if (b.markupBudget !== a.markupBudget) return b.markupBudget - a.markupBudget;
    // Among tickets that pay equally, a bonus bet prefers the longer one, because only
    // the profit is ever returned. Cash prefers the shorter one, which wins more often.
    const aFair = a.quote.fairDecimal ?? 0;
    const bFair = b.quote.fairDecimal ?? 0;
    return options.bonus ? bFair - aFair : aFair - bFair;
  });

  return picks.slice(0, options.limit ?? 5);
}

function opposed(legs: PricedLeg[]): boolean {
  const OPPOSITE: Record<string, string> = {
    home: "away", away: "home", over: "under", under: "over",
  };
  for (let i = 0; i < legs.length; i += 1) {
    for (let j = i + 1; j < legs.length; j += 1) {
      const a = legs[i];
      const b = legs[j];
      if (a.market === b.market && OPPOSITE[a.side] === b.side && a.line === b.line) return true;
    }
  }
  return false;
}

/**
 * Turn the shopped board into games a ticket can be built from.
 *
 * Only games with both a posted spread and a posted total qualify. A same-game parlay is
 * priced off one scoreline, and half a scoreline prices nothing — a game missing either
 * number is skipped rather than filled in from a league average, which would invent the
 * very quantity the ticket turns on.
 *
 * Where several books price the same leg, the best price wins. That is not cherry-picking:
 * it is the price actually available to someone who holds accounts at those books, which
 * is the only price that decides anything.
 */
export function sgpGamesFromBoard(
  rows: BoardEdge[],
  options: { books?: string[] } = {},
): SgpGame[] {
  const allowed = options.books && options.books.length > 0 ? new Set(options.books) : null;
  const byEvent = new Map<string, BoardEdge[]>();
  for (const row of rows) {
    if (allowed && !allowed.has(row.book)) continue;
    const list = byEvent.get(row.eventId);
    if (list) list.push(row);
    else byEvent.set(row.eventId, [row]);
  }

  const games: SgpGame[] = [];
  for (const [eventId, group] of byEvent) {
    const homeSpread = group.find((r) => r.gameSpread !== null)?.gameSpread ?? null;
    const totalLine = group.find((r) => r.market === "total" && r.line !== null)?.line ?? null;
    if (homeSpread === null || totalLine === null) continue;

    // Best price per leg, keyed on the line too: two books on different numbers are
    // different bets, and collapsing them would quote one book's price at another's line.
    const best = new Map<string, PricedLeg>();
    for (const row of group) {
      if (row.price === null || Math.abs(row.price) < 100) continue;
      const leg = legFor(row.market, row.side, row.line);
      if (leg === null) continue;
      const key = `${row.market}|${row.side}|${row.line ?? ""}`;
      const current = best.get(key);
      if (current && decimalFrom(current.price) >= decimalFrom(row.price)) continue;
      best.set(key, {
        leg,
        price: row.price,
        market: row.market,
        side: row.side,
        line: row.line,
        label: `${labelFor(row)}`,
        edgePoints: row.edgePoints,
      });
    }
    if (best.size < 2) continue;

    const first = group[0];
    games.push({
      eventId,
      league: first.league,
      homeTeam: first.homeTeam,
      awayTeam: first.awayTeam,
      commenceTime: first.commenceTime,
      lines: { homeSpread, total: totalLine },
      legs: [...best.values()],
    });
  }
  return games;
}

function labelFor(row: BoardEdge): string {
  if (row.market === "total") {
    return `${row.side === "over" ? "Over" : "Under"} ${row.line}`;
  }
  const team = row.side === "home" ? row.homeTeam : row.awayTeam;
  if (row.market === "moneyline") return `${team} ML`;
  return `${team} ${row.line !== null && row.line > 0 ? "+" : ""}${row.line}`;
}
