/**
 * Where a profit boost is worth the most, at one book: moneylines and game totals.
 *
 * Every candidate is scored as ONE maximum-size bet with the boost on: its fair chance
 * of winning times the boosted profit, less the stake times its chance of losing, with a
 * push (a whole-number total landed exactly) returning the stake.
 *
 * **Moneylines** -- the lowest of every independent estimate: the other books' de-vigged
 * consensus and the spread model. Proportional de-vig flatters underdogs and a boost
 * multiplies the flattery, so the conservative reading is the honest one. Ported from
 * `scripts/boost-candidates.ts`, which found it the hard way (a +400 ranked at 24% that
 * the only other book had at 19%).
 *
 * **Totals** -- the other books' fair total (each book's line, nudged by how its own
 * over and under are priced), plus the measured lean: finals land a little over the
 * closing total (+0.58 NFL / +0.61 college on seven seasons, `score_models.totalMean`),
 * scattered by the fitted `totalSd`. So an over and an under at the same number are no
 * longer mirror images: at equal prices the over is worth a little more, which is the
 * whole reason to rank totals for a boost -- the lean alone does not beat the vig, but
 * a boost on the better side of it does.
 *
 * Guards, each one an error that would otherwise present as the best bet on the list:
 * a side needs two other books quoting it to be ranked (fewer is listed apart); a total
 * more than three points off the others' consensus is a stale or mistyped line, not a
 * gift, and is listed apart too; blowouts are skipped; and a moneyline against one of
 * your teams is never suggested.
 */
import { isBlowout } from "./blowout";
import { quotesForGame, type BookLineRow } from "./book-lines";
import { betsAgainst } from "./favourites";
import type { ScoreModel } from "./joint-score";
import { deVig, normalCdf, winProbabilityFromSpread, type MarginModel } from "./probability";
import { boostedPrice, profitPerDollar } from "./profit-boost";
import type { Game, Side } from "./types";

export const MIN_OTHER_BOOKS = 2;
/** A total this far from the other books is a stale or mistyped line. */
export const MAX_TOTAL_GAP = 3;

export interface BoostPick {
  eventId: string;
  league: Game["league"];
  commenceTime: string;
  game: string;
  market: "moneyline" | "total";
  side: Side;
  /** "Kentucky Wildcats ML" or "Over 54.5". */
  label: string;
  line: number | null;
  price: number;
  /** What to log: the price the boost actually pays at. */
  logPrice: number;
  win: number;
  push: number;
  /** How many other books the estimate stands on. */
  books: number;
  /** One line on where the chance came from. */
  basis: string;
  /** Expected profit on the stake, boosted and not. */
  boosted: number;
  plain: number;
  /** Two other books, and (for a total) within MAX_TOTAL_GAP of them. */
  checked: boolean;
}

export interface BoostOptions {
  book: string;
  /** 0.5 for a 50% profit boost. */
  boost: number;
  stake: number;
  favourites?: string[];
  maxSpread: number;
  now?: Date;
  horizonDays?: number;
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Expected profit per $1: a win pays the boosted profit, a push refunds, a loss costs. */
export function evPerDollar(win: number, push: number, price: number, boost: number): number {
  const b = profitPerDollar(price);
  if (!Number.isFinite(b)) return Number.NaN;
  return win * b * (1 + boost) - (1 - win - push);
}

/** P(over wins) and P(push) for a total, given where the final is centred and its scatter. */
export function totalChances(side: "over" | "under", line: number, mean: number, sd: number) {
  const whole = Number.isInteger(line);
  const above = 1 - normalCdf(((whole ? line + 0.5 : line) - mean) / sd);
  const below = normalCdf(((whole ? line - 0.5 : line) - mean) / sd);
  const push = whole ? Math.max(0, 1 - above - below) : 0;
  return { win: side === "over" ? above : below, push };
}

export function findBoosts(
  games: Game[],
  stored: Map<string, BookLineRow[]>,
  models: Record<string, MarginModel>,
  scoreModels: Record<string, ScoreModel>,
  options: BoostOptions,
): { checked: BoostPick[]; unchecked: BoostPick[]; gamesAtBook: number } {
  const { book, boost, stake, favourites = [], maxSpread } = options;
  const now = options.now ?? new Date();
  const until = now.getTime() + (options.horizonDays ?? 8) * 86_400_000;
  const picks: BoostPick[] = [];
  let gamesAtBook = 0;

  for (const game of games) {
    const kickoff = Date.parse(game.commenceTime);
    if (!(kickoff > now.getTime() && kickoff <= until)) continue;
    const homeSpread = game.spread?.home?.line ?? null;
    if (isBlowout(homeSpread, maxSpread)) continue;
    const quotes = quotesForGame(game, stored.get(game.eventId) ?? [], "DraftKings", now).filter(
      (q) => !q.stale && q.price !== null,
    );
    const mine = quotes.filter((q) => q.book === book);
    if (mine.length === 0) continue;
    gamesAtBook += 1;
    const matchup = `${game.awayTeam ?? "Away"} @ ${game.homeTeam ?? "Home"}`;
    const base = { eventId: game.eventId, league: game.league, commenceTime: game.commenceTime, game: matchup };

    // Moneylines.
    for (const quote of mine.filter((q) => q.market === "moneyline")) {
      const side = quote.side;
      const team = (side === "home" ? game.homeTeam : game.awayTeam) ?? side;
      if (betsAgainst({ market: "moneyline", side, homeTeam: game.homeTeam, awayTeam: game.awayTeam }, favourites)) continue;
      const fairs = quotes
        .filter((q) => q.market === "moneyline" && q.book !== book && q.side === side && q.oppositePrice != null)
        .map((q) => deVig(q.price ?? null, q.oppositePrice ?? null)?.a)
        .filter((v): v is number => typeof v === "number");
      const market = median(fairs);
      const model = models[game.league] && homeSpread !== null
        ? winProbabilityFromSpread(models[game.league], homeSpread, side)
        : null;
      const estimates = [market, model].filter((v): v is number => v !== null);
      if (estimates.length === 0) continue;
      const win = Math.min(...estimates);
      const price = quote.price as number;
      picks.push({
        ...base,
        market: "moneyline",
        side,
        label: `${team} ML`,
        line: null,
        price,
        logPrice: boostedPrice(price, boost),
        win,
        push: 0,
        books: fairs.length,
        basis:
          estimates.length === 1
            ? model !== null ? "spread model only" : `${fairs.length} other books`
            : win === model ? `spread model (lower than ${fairs.length} other books)` : `${fairs.length} other books (lower than the model)`,
        boosted: stake * evPerDollar(win, 0, price, boost),
        plain: stake * evPerDollar(win, 0, price, 0),
        checked: fairs.length >= MIN_OTHER_BOOKS,
      });
    }

    // Game totals.
    const score = scoreModels[game.league];
    if (!score || !(score.totalSd > 0)) continue;
    const density = 1 / (score.totalSd * Math.sqrt(2 * Math.PI));
    // Each other book's fair total: its line, moved by how far its over is priced off
    // even money. One number per book, read from its over.
    const fairTotals = quotes
      .filter((q) => q.market === "total" && q.side === "over" && q.book !== book && q.line !== null && q.oppositePrice != null)
      .map((q) => {
        const pOver = deVig(q.price ?? null, q.oppositePrice ?? null)?.a;
        return typeof pOver === "number" ? (q.line as number) + (pOver - 0.5) / density : null;
      })
      .filter((v): v is number => v !== null);
    const consensus = median(fairTotals);
    if (consensus === null) continue;
    const mean = consensus + score.totalMean;
    for (const quote of mine.filter((q) => q.market === "total" && q.line !== null)) {
      const side = quote.side as "over" | "under";
      if (side !== "over" && side !== "under") continue;
      const line = quote.line as number;
      const price = quote.price as number;
      const { win, push } = totalChances(side, line, mean, score.totalSd);
      picks.push({
        ...base,
        market: "total",
        side,
        label: `${side === "over" ? "Over" : "Under"} ${line}`,
        line,
        price,
        logPrice: boostedPrice(price, boost),
        win,
        push,
        books: fairTotals.length,
        basis: `others' fair total ${consensus.toFixed(1)}, finals land ${score.totalMean >= 0 ? "+" : ""}${score.totalMean.toFixed(1)} over it`,
        boosted: stake * evPerDollar(win, push, price, boost),
        plain: stake * evPerDollar(win, push, price, 0),
        checked: fairTotals.length >= MIN_OTHER_BOOKS && Math.abs(line - consensus) <= MAX_TOTAL_GAP,
      });
    }
  }

  picks.sort((a, b) => b.boosted - a.boosted);
  return {
    checked: picks.filter((p) => p.checked),
    unchecked: picks.filter((p) => !p.checked),
    gamesAtBook,
  };
}
