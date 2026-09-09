import { expectedRoi } from "./shop";
import type { Candidate } from "./survivor";
import type { Game } from "./types";

/**
 * Turning a survivor pick into a bet you could actually place.
 *
 * Worth saying plainly, because the page has to: a survivor pick and a good moneyline
 * bet are chosen by opposite rules. Survivor wants the highest probability of winning
 * and does not care what it pays — you are buying survival, and the price is
 * irrelevant because there is no price. A bet wants the largest gap between what a
 * team is worth and what it costs, and a heavy favourite is precisely where that gap
 * is smallest and the vig bites hardest.
 *
 * So most survivor picks are bad moneyline bets, and the honest thing is to compute
 * the return and show it rather than to offer a button and let the number go unasked.
 * Occasionally one is genuinely priced well, and then it is worth knowing.
 */

/** Strip a team name to something two sources can be compared on. */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export interface BettablePick {
  candidate: Candidate;
  /** ESPN event id, when this fixture has reached the board. */
  eventId: string | null;
  league: string | null;
  price: number | null;
  book: string | null;
  /** Expected return per dollar at that price, using the survivor win probability. */
  expectedRoi: number | null;
  /** Why it cannot be logged yet, when it cannot. */
  blocked: string | null;
}

/**
 * Match a fixture to the board, so a logged bet can settle.
 *
 * A bet stored against the feed's own id would never settle: `game_results` is keyed
 * on ESPN ids, and nothing would ever join to it. Rather than store an id that looks
 * fine and quietly breaks the ledger, a pick with no board fixture is reported as not
 * yet loggable.
 *
 * Both teams must match and kickoff must agree within a day. The same rule as the
 * collector's matcher, and for the same reason: a half-match is a different game.
 */
export function linkToBoard(candidate: Candidate, games: Game[]): Game | null {
  const team = normalize(candidate.team);
  const opponent = normalize(candidate.opponent);
  const at = new Date(candidate.commenceTime).getTime();

  for (const game of games) {
    const home = normalize(game.homeTeam ?? "");
    const away = normalize(game.awayTeam ?? "");
    const pair = candidate.home ? home === team && away === opponent
                                : away === team && home === opponent;
    if (!pair) continue;
    const when = new Date(game.commenceTime).getTime();
    if (Math.abs(when - at) > 24 * 3600 * 1000) continue;
    return game;
  }
  return null;
}

/**
 * The best moneyline available at your own books for this pick.
 *
 * `myBooks` empty means no filter, matching how the rest of the app treats it. Prices
 * you cannot reach are excluded, because a return computed against a book you do not
 * hold is not a return you can have.
 */
export function bestMoneyline(
  eventId: string,
  side: "home" | "away",
  quotes: Array<{ book: string; market: string; side: string; price: number | null }>,
  myBooks: string[],
): { price: number; book: string } | null {
  let best: { price: number; book: string } | null = null;
  for (const quote of quotes) {
    if (quote.market !== "moneyline" || quote.side !== side) continue;
    if (quote.price === null) continue;
    if (myBooks.length > 0 && !myBooks.includes(quote.book)) continue;
    // Higher American odds always pay more for the same stake, whether the number is
    // positive or negative: -150 beats -170, and +160 beats both.
    if (best === null || quote.price > best.price) {
      best = { price: quote.price, book: quote.book };
    }
  }
  return best;
}

export function toBettable(
  candidate: Candidate,
  games: Game[],
  quotesByEvent: Map<string, Array<{ book: string; market: string; side: string; price: number | null }>>,
  myBooks: string[],
): BettablePick {
  const game = linkToBoard(candidate, games);
  if (!game) {
    return {
      candidate, eventId: null, league: null, price: null, book: null,
      expectedRoi: null,
      blocked: "Not on the board yet, so a bet on it could not settle.",
    };
  }

  const side = candidate.home ? "home" : "away";
  const fromFeed = bestMoneyline(
    game.eventId, side, quotesByEvent.get(game.eventId) ?? [], myBooks);

  // The board's own book, as a fallback when the feed has no moneyline for it.
  const boardPrice = game.moneyline?.[side]?.price ?? null;
  const best = fromFeed ?? (boardPrice !== null
    ? { price: boardPrice, book: "DraftKings" }
    : null);

  if (!best) {
    return {
      candidate, eventId: game.eventId, league: game.league, price: null, book: null,
      expectedRoi: null,
      blocked: "No moneyline priced at your books.",
    };
  }

  return {
    candidate,
    eventId: game.eventId,
    league: game.league,
    price: best.price,
    book: best.book,
    expectedRoi: expectedRoi(candidate.winProbability, best.price),
    blocked: null,
  };
}
