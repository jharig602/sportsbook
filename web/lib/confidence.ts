/**
 * Confidence picks: every NFL game this week, picked straight up, ranked so the surest
 * pick carries the most points (16, 15, ... down).
 *
 * For the most expected points the answer is exact and simple: pick each game's
 * likelier winner, and hand out points in order of how likely. Swapping any two ranks
 * can only move more points onto the less likely pick (the rearrangement inequality),
 * so nothing beats this order on expected points.
 *
 * Each game's chance is the median of every book's de-vigged moneyline, falling back to
 * the spread model when no book prices it. Beating OTHER people is a different
 * objective -- fading the crowd's favourites in a big field -- and needs to know how the
 * pool picks; this is the base any such adjustment starts from.
 */
import type { BookQuote } from "./shop";
import { deVig, winProbabilityFromSpread, type MarginModel } from "./probability";
import type { Game } from "./types";

export const TOP_POINTS = 16;

export interface ConfidenceGame {
  eventId: string;
  commenceTime: string;
  home: string;
  away: string;
  /** Chance the home team wins. */
  homeChance: number;
  source: "market" | "model";
  books: number;
}

export interface ConfidencePick {
  game: ConfidenceGame;
  team: string;
  opponent: string;
  chance: number;
  points: number;
  /**
   * Expected points given up by taking the underdog in this slot instead:
   * points x (chance - (1 - chance)). Near-coin-flips at low points cost almost nothing
   * -- the cheap way to differ from a pool that all takes the favourite.
   */
  flipCost: number;
}

/** The NFL week `now` falls in: Tuesday 12:00 UTC to the next, as `nflWeek` counts it. */
export function weekWindow(now: Date): { start: number; end: number } {
  const sinceTuesday = (now.getUTCDay() - 2 + 7) % 7;
  let start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - sinceTuesday, 12);
  if (start > now.getTime()) start -= 7 * 86_400_000;
  return { start, end: start + 7 * 86_400_000 };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** One game's home win chance from every book's moneyline, else from the spread model. */
export function gameChance(game: Game, quotes: BookQuote[], model: MarginModel | null): ConfidenceGame | null {
  if (!game.homeTeam || !game.awayTeam) return null;
  const fairs = quotes
    .filter((q) => q.market === "moneyline" && q.side === "home" && !q.stale && q.price != null && q.oppositePrice != null)
    .map((q) => deVig(q.price ?? null, q.oppositePrice ?? null)?.a)
    .filter((v): v is number => typeof v === "number");
  const market = median(fairs);
  const spread = game.spread?.home?.line ?? null;
  const fromModel = model && spread !== null ? winProbabilityFromSpread(model, spread, "home") : null;
  const homeChance = market ?? fromModel;
  if (homeChance === null || homeChance === undefined) return null;
  return {
    eventId: game.eventId,
    commenceTime: game.commenceTime,
    home: game.homeTeam,
    away: game.awayTeam,
    homeChance,
    source: market !== null ? "market" : "model",
    books: fairs.length,
  };
}

/** The likelier winner of every game, surest first, with points from `top` down. */
export function rankConfidence(games: ConfidenceGame[], top = TOP_POINTS) {
  const highest = Math.max(top, games.length);
  const picks: ConfidencePick[] = games
    .map((game) => {
      const home = game.homeChance >= 0.5;
      return {
        game,
        team: home ? game.home : game.away,
        opponent: home ? game.away : game.home,
        chance: home ? game.homeChance : 1 - game.homeChance,
        points: 0,
        flipCost: 0,
      };
    })
    .sort((a, b) => b.chance - a.chance || a.game.commenceTime.localeCompare(b.game.commenceTime))
    .map((p, i) => ({ ...p, points: highest - i, flipCost: (highest - i) * (2 * p.chance - 1) }));
  const expected = picks.reduce((sum, p) => sum + p.chance * p.points, 0);
  const possible = picks.reduce((sum, p) => sum + p.points, 0);
  // Spread of the week's score: each pick is an independent coin with its own weight.
  const sd = Math.sqrt(picks.reduce((sum, p) => sum + p.points ** 2 * p.chance * (1 - p.chance), 0));
  return { picks, expected, possible, sd };
}
