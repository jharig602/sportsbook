/**
 * When to tell you about your team's game, and what to say.
 *
 * One push per game per team, sometime in the day and a half before kickoff. Not a
 * recommendation to bet your team -- that decision was made before the app opened -- but
 * the one part of it still open: which way in costs least. The Shop page already works
 * that out (`planBacking`); this just brings it to the phone before the game rather than
 * waiting to be looked up.
 *
 * ## Why a window rather than a time
 *
 * GitHub delivers the collector three to five times a day at arbitrary minutes, and a
 * reminder gated on a two-hour window here once went five days without firing at all.
 * So every run offers, the first run inside the window sends, and the game is remembered
 * as done. Whether the push arrives depends on a run having happened, not on when.
 *
 * Thirty hours covers every NFL slot with daylight to spare: a Sunday 1 PM game opens
 * Saturday morning, a Monday night game Sunday afternoon, a Thursday night game Wednesday
 * afternoon, and a London game Friday. Earlier than that and the lines being compared are
 * still moving; the whole point of the message is which price is cheapest, which is only
 * worth knowing close to when you would take it.
 */
import type { Game } from "./types";

export const FAVOURITE_WINDOW_HOURS = 30;

export interface FavouriteGame {
  team: string;
  opponent: string;
  home: boolean;
  eventId: string;
  commenceTime: string;
}

/** The id a sent push is remembered by: one per game per team. */
export function favouriteKey(eventId: string, team: string): string {
  return `${eventId}|${team}`;
}

function same(a: string | null | undefined, b: string): boolean {
  return !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Your teams' games that should be announced now.
 *
 * Kickoff must be in the future and within the window, and the game must not already
 * have been announced. A game already under way is never announced: a message about
 * which price to take arrives after the prices have gone.
 */
export function dueFavouriteGames(
  games: Game[],
  favourites: string[],
  now: Date,
  sent: Set<string>,
): FavouriteGame[] {
  if (favourites.length === 0) return [];
  const out: FavouriteGame[] = [];
  for (const game of games) {
    const kickoff = Date.parse(game.commenceTime);
    if (!Number.isFinite(kickoff)) continue;
    const hoursAway = (kickoff - now.getTime()) / 3_600_000;
    if (hoursAway <= 0 || hoursAway > FAVOURITE_WINDOW_HOURS) continue;

    for (const team of favourites) {
      const home = same(game.homeTeam, team);
      const away = same(game.awayTeam, team);
      if (!home && !away) continue;
      const name = (home ? game.homeTeam : game.awayTeam) as string;
      if (sent.has(favouriteKey(game.eventId, name))) continue;
      out.push({
        team: name,
        opponent: (home ? game.awayTeam : game.homeTeam) ?? "their opponent",
        home,
        eventId: game.eventId,
        commenceTime: game.commenceTime,
      });
    }
  }
  return out;
}

/**
 * What an option costs, in words.
 *
 * Almost always a cost: backing one side at a book is paying the vig, and the finding is
 * how little it can be, not that it is free. Said in cents per dollar because that is the
 * unit the choice is actually made in.
 */
export function describeCost(expectedRoi: number): string {
  if (expectedRoi >= 0) return `+${(expectedRoi * 100).toFixed(1)}% expected`;
  const cents = -expectedRoi * 100;
  return `costs about ${cents < 1 ? cents.toFixed(1) : Math.round(cents)}¢ per $1 in vig`;
}
