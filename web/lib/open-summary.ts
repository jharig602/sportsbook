/**
 * What is riding on the open tickets: money in play, the most it could win, and what it
 * should win on average.
 *
 * "Could win" is every ticket hitting, which almost never happens -- five bets at -110
 * all land about 3% of the time. The number worth planning around is the expected one:
 * each ticket's payout times its FAIR chance of winning, minus its stake times its
 * chance of losing.
 *
 * The fair chance comes from the other books, exactly as on the Shop: the de-vigged
 * consensus for a moneyline, and the consensus line plus the points you are better or
 * worse than it for a spread or total. Never from the ticket's own price, which for a
 * boosted bet is the book's promotional number and would make every boost look like a
 * bad bet. A ticket with no market to price it against -- a team total, a game nobody
 * else quotes -- is counted at break-even and said so, rather than guessed at.
 *
 * A parlay's legs are multiplied as if independent, which is fair across different
 * games and wrong within one, so a parlay with two legs on the same game is left
 * unpriced. Legs already won count as certain.
 */
import { quotesForGame, type BookLineRow } from "./book-lines";
import type { MarginModel } from "./probability";
import { decimalOdds, settleOnScore, type Bet, type GradedRow, type Score } from "./settle";
import { shopSide } from "./shop";
import type { Game } from "./types";

const TICKET = "__ticket__";

/** The fair chance this bet wins, from the other books; null when there is no market. */
export function fairChance(
  bet: Bet,
  game: Game | undefined,
  stored: BookLineRow[],
  model: MarginModel | null,
  now: Date = new Date(),
): number | null {
  // A team total is priced by nobody in the feed.
  if (bet.market === "total" && bet.team) return null;
  if (bet.market !== "moneyline" && bet.line === null) return null;
  const quotes = quotesForGame(game, stored, "DraftKings", now).filter(
    (q) => q.market === bet.market && q.side === bet.side && q.book !== TICKET,
  );
  if (!quotes.some((q) => !q.stale)) return null;
  const mine = {
    book: TICKET,
    market: bet.market,
    side: bet.side,
    line: bet.market === "moneyline" ? null : bet.line,
    price: bet.price,
  };
  const result = shopSide([...quotes, mine], model).find((r) => r.book === TICKET);
  if (!result) return null;
  // Outside the moneyline band the Shop refuses to quote a RETURN, but the consensus is
  // still the best estimate of the chance, and a summary needs one.
  const p = result.fairProbability ?? (bet.market === "moneyline" ? result.consensusProbability : null);
  return p !== null && p > 0 && p < 1 ? p : null;
}

export interface OpenSummary {
  tickets: number;
  /** Your own money in play. */
  atStake: number;
  /** Bonus-bet stakes in play: the book's money, which cannot be lost. */
  bonusStake: number;
  /** Profit if every open ticket wins. */
  ifAllWin: number;
  /** Expected profit across the open tickets. */
  expected: number;
  /** Tickets with no market to price them, counted at break-even. */
  unpriced: number;
  /**
   * Per open ticket (by `bet_id`): its fair chance and what holding it is worth in cash
   * -- the fair chance times what it pays back. A cash-out offer below `value` is the
   * book keeping the difference. Absent when there is no market to price it.
   */
  hold: Map<string, { chance: number; value: number; started: boolean }>;
}

export function openSummary(
  rows: GradedRow[],
  legsByParlay: Map<string, Bet[]>,
  chance: (bet: Bet) => number | null,
  scores: Map<string, Score>,
): OpenSummary {
  const out: OpenSummary = { tickets: 0, atStake: 0, bonusStake: 0, ifAllWin: 0, expected: 0, unpriced: 0, hold: new Map() };
  const now = Date.now();

  for (const row of rows) {
    if (row.outcome !== "open") continue;
    out.tickets += 1;
    if (row.bonus) out.bonusStake += row.stake;
    else out.atStake += row.stake;

    let p: number | null;
    let profit: number;
    const legs = row.parlay_id ? legsByParlay.get(row.parlay_id) ?? [] : null;

    if (legs) {
      const decimal =
        row.parlay_price !== null && row.parlay_price !== undefined
          ? decimalOdds(row.parlay_price)
          : legs.reduce<number | null>((acc, leg) => {
              const d = decimalOdds(leg.price);
              return acc === null || d === null ? null : acc * d;
            }, 1);
      profit = decimal === null ? 0 : row.stake * (decimal - 1);
      const openLegs = legs.filter((leg) => !scores.has(leg.event_id));
      const games = new Set(openLegs.map((leg) => leg.event_id));
      if (games.size < openLegs.length) {
        p = null; // two legs on one game are not independent
      } else {
        p = 1;
        for (const leg of legs) {
          const score = scores.get(leg.event_id);
          // Decided legs: a win (or push) is certain now; a loss would have closed it.
          const q = score ? (settleOnScore(leg, score).outcome === "lost" ? 0 : 1) : chance(leg);
          if (q === null) {
            p = null;
            break;
          }
          p *= q;
        }
      }
    } else {
      const decimal = decimalOdds(row.price);
      profit = decimal === null ? 0 : row.stake * (decimal - 1);
      p = chance(row);
    }

    out.ifAllWin += profit;
    if (p === null) {
      out.unpriced += 1;
      continue; // break-even: contributes nothing either way
    }
    out.expected += p * profit - (1 - p) * (row.bonus ? 0 : row.stake);
    // What comes back on a win: stake and profit, or the profit alone on a bonus bet.
    const back = row.bonus ? profit : row.stake + profit;
    const kickoffs = (legs ?? [row]).map((b) => (b.commence_time ? Date.parse(b.commence_time) : NaN));
    out.hold.set(row.bet_id, {
      chance: p,
      value: p * back,
      started: kickoffs.some((k) => Number.isFinite(k) && k <= now),
    });
  }
  return out;
}
