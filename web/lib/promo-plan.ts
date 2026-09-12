import { allBookLines } from "./book-lines";
import { listBets } from "./bets-db";
import { buildBoardShop } from "./board-shop";
import { getData } from "./data";
import { winProbabilityFromSpread } from "./probability";
import {
  bestBonusTarget,
  bestQualifier,
  progress,
  promoValue,
  qualifyingDates,
  type BonusTarget,
  type PromoPlan,
  type Progress,
} from "./promo";
import type { Candidate } from "./survivor";

/**
 * Today's qualifying bet and where to put the bonus it earns.
 *
 * Lifted out of the notification route so the page and the push cannot drift. They were
 * always going to: the same arithmetic written twice is the same arithmetic until
 * somebody fixes one of them, and then the screen and the phone disagree about what to
 * bet with no way to tell which is right.
 */

export const PROMO_BOOK = "FanDuel";
export const PROMO_STAKE = 5;
export const PROMO_BONUS_FACE = 50;
export const PROMO_DAYS = 7;

export interface PromoToday {
  /** The cheapest qualifying bet at the book. Frequently still a losing one. */
  qualifier: PromoPlan;
  /** Where the $50 the qualifier earns is worth most. */
  bonus: BonusTarget | null;
  /** How many qualifying days are logged, and which day is next. */
  progress: Progress;
  /** Cash value of the whole promotion, both sides, across every day. */
  worth: number;
  book: string;
  stake: number;
  face: number;
}

export async function promoToday(): Promise<PromoToday> {
  const data = getData();
  const [games, models, lines, ledger] = await Promise.all([
    data.games(),
    data.marginModels(),
    allBookLines(),
    listBets().catch(() => []),
  ]);

  const done = progress(qualifyingDates(ledger, PROMO_BOOK, PROMO_STAKE), PROMO_DAYS);
  const shop = buildBoardShop(games, lines, models);
  const qualifier = bestQualifier(shop.rows, PROMO_BOOK, PROMO_STAKE);

  // Bonus candidates: every moneyline this book offers, priced with OUR model's
  // probability rather than the one implied by the price. The implied number carries
  // the favourite-longshot bias, which would push every recommendation toward +5000
  // shots that win far less often than they are priced to.
  const targets: Array<{ candidate: Candidate; price: number }> = [];
  for (const game of games) {
    const model = models[game.league];
    const spread = game.spread?.home?.line;
    if (!model || spread === null || spread === undefined) continue;
    if (new Date(game.commenceTime).getTime() <= Date.now()) continue;

    for (const side of ["home", "away"] as const) {
      const quotes = lines.get(game.eventId) ?? [];
      const mine = quotes.find(
        (q) => q.book === PROMO_BOOK && q.market === "moneyline" && q.side === side,
      );
      const price = mine?.price ?? game.moneyline?.[side]?.price ?? null;
      if (price === null) continue;
      const probability = winProbabilityFromSpread(model, spread, side);
      if (probability === null) continue;
      targets.push({
        candidate: {
          team: (side === "home" ? game.homeTeam : game.awayTeam) ?? "?",
          opponent: (side === "home" ? game.awayTeam : game.homeTeam) ?? "?",
          home: side === "home",
          winProbability: probability,
          spread: side === "home" ? spread : -spread,
          commenceTime: game.commenceTime,
          eventId: game.eventId,
        },
        price,
      });
    }
  }

  const bonus = bestBonusTarget(targets, PROMO_BONUS_FACE);
  return {
    qualifier,
    bonus,
    progress: done,
    worth: promoValue(qualifier.expectedProfit, PROMO_DAYS, bonus?.value ?? 0),
    book: PROMO_BOOK,
    stake: PROMO_STAKE,
    face: PROMO_BONUS_FACE,
  };
}
