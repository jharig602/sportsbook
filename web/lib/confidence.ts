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

/**
 * The Monday-night tiebreaker: a guess at the game's total points.
 *
 * Each book's total, nudged toward the side its juice favours (an over at -120 says a bit
 * more than the number) -- the same fair-total reading as the boost finder -- then the
 * median across books, plus the measured lean (NFL finals land ~0.6 over the closing
 * total), rounded to a whole score.
 */
export function tiebreakerTotal(
  quotes: BookQuote[],
  model: { totalMean: number; totalSd: number } | null,
): { guess: number; line: number; fair: number; books: number } | null {
  const sd = model && model.totalSd > 0 ? model.totalSd : 13;
  const density = 1 / (sd * Math.sqrt(2 * Math.PI));
  const overs = quotes.filter((q) => q.market === "total" && q.side === "over" && !q.stale && q.line !== null && q.price != null);
  const fairs = overs
    .map((q) => {
      const pOver = q.oppositePrice != null ? deVig(q.price ?? null, q.oppositePrice ?? null)?.a : 0.5;
      return typeof pOver === "number" ? (q.line as number) + (pOver - 0.5) / density : null;
    })
    .filter((v): v is number => v !== null);
  const fair = median(fairs);
  const line = median(overs.map((q) => q.line as number));
  if (fair === null || line === null) return null;
  return { guess: Math.round(fair + (model?.totalMean ?? 0)), line, fair, books: fairs.length };
}

/** The underdog chance the weekly rule looks for (see `weeklyPick`). */
export const WEEKLY_DOG_CHANCE = 0.35;

/**
 * The entry for a WEEKLY pot: the ranking, with one change -- the underdog whose chance
 * is nearest 35% (about +185) takes the top slot, and everyone else moves down one.
 *
 * Backtested on 197 real NFL weeks (2015 to 2026 week 5, nflverse closing moneylines and
 * results) against 11 simulated rivals with this pool's measured habits (76% on the
 * favourite in close games, points following the odds at r ~0.75): the plain ranking won
 * 4.8% of weeks (fair share 8.3%); this rule won 12.7%. Chosen on 2015-2020 (13.6%) and
 * held on 2021-2026 (11.8%). Every single-underdog rule in the top three slots landed at
 * 12-14%; the hill-climbing search that preceded this won 11.0%, and underdogs in the
 * lowest slots did nothing (4.7%). It costs ~5.6 expected points a week, which is why the
 * season race still plays it as ranked. Games already kicked off are left where they are.
 */
export function weeklyPick(picks: ConfidencePick[], now: number) {
  const open = picks.map((p) => Date.parse(p.game.commenceTime) > now);
  let dog = -1;
  picks.forEach((p, i) => {
    if (!open[i]) return;
    const gap = Math.abs(1 - p.chance - WEEKLY_DOG_CHANCE);
    if (dog < 0 || gap < Math.abs(1 - picks[dog].chance - WEEKLY_DOG_CHANCE)) dog = i;
  });
  if (dog < 0) return null;
  // The open slots, best first; the dog takes the first, the other open picks follow.
  const openSlots = picks.map((p, i) => (open[i] ? p.points : null)).filter((v): v is number => v !== null);
  const others = picks.filter((_, i) => open[i] && i !== dog);
  const entry = [
    { pick: picks[dog], team: picks[dog].opponent, points: openSlots[0], underdog: true },
    ...others.map((p, k) => ({ pick: p, team: p.team, points: openSlots[k + 1], underdog: false })),
  ];
  const expected = entry.reduce((sum, e) => sum + e.points * (e.underdog ? 1 - e.pick.chance : e.pick.chance), 0);
  const plain = others.concat(picks[dog]).reduce((sum, p) => sum + p.points * p.chance, 0);
  return { dog: entry[0], entry, cost: plain - expected };
}

