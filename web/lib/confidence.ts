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
 * Chance of winning a WEEKLY prize against `rivals` other players, for the plain
 * ranking and for each single underdog flip (same points slot, other team).
 *
 * Outcomes are drawn from each game's chance. Rivals are drawn fresh each season-week:
 * how this pool picks is not known yet, so they are assumed to be ordinary players --
 * they take the favourite more often than its chance alone would say (a 55% favourite
 * gets ~60% of picks, a 65% one ~78%, a 75% one 90%), and rank their picks by chance
 * with a fair amount of noise. Tried tighter and looser fields too: the plain ranking
 * wins 4-11% against nine of them, and one underdog at mid-range points beat it every
 * time -- a 3-point flip barely moves you, a 14-point one costs too often; the slot
 * that pays is big enough to leapfrog a field that all scored the same chalk. Ties for first split the prize. Only games not yet
 * kicked off can be flipped. Seeded, so the page does not shuffle on every refresh.
 */
export function weeklyWin(
  picks: ConfidencePick[],
  options: { rivals?: number; sims?: number; seed?: number; now?: number } = {},
) {
  const rivals = options.rivals ?? 9;
  const sims = options.sims ?? 20_000;
  const now = options.now ?? Date.now();
  let state = options.seed ?? 20261011;
  const rand = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  const n = picks.length;
  const sharpen = (p: number) => p ** 2 / (p ** 2 + (1 - p) ** 2);
  const slots = picks.map((p) => p.points).sort((a, b) => b - a);
  const flippable = picks.map((p) => Date.parse(p.game.commenceTime) > now);
  const wins = new Array(n + 1).fill(0); // [0] the plain ranking, [i + 1] game i flipped

  const favWon = new Array<boolean>(n);
  const perceived = new Array<{ i: number; v: number; fav: boolean }>(n);
  for (let s = 0; s < sims; s++) {
    let base = 0;
    for (let i = 0; i < n; i++) {
      favWon[i] = rand() < picks[i].chance;
      if (favWon[i]) base += picks[i].points;
    }
    let best = -1;
    let atBest = 0;
    for (let r = 0; r < rivals; r++) {
      for (let i = 0; i < n; i++) {
        const fav = rand() < sharpen(picks[i].chance);
        perceived[i] = { i, v: (fav ? picks[i].chance : 1 - picks[i].chance) + 0.12 * normal(), fav };
      }
      const order = [...perceived].sort((a, b) => b.v - a.v);
      let score = 0;
      order.forEach((o, k) => {
        if (o.fav === favWon[o.i]) score += slots[k];
      });
      if (score > best) { best = score; atBest = 1; } else if (score === best) atBest += 1;
    }
    for (let e = 0; e <= n; e++) {
      if (e > 0 && !flippable[e - 1]) continue;
      const i = e - 1;
      const mine = e === 0 ? base : base + (favWon[i] ? -picks[i].points : picks[i].points);
      if (mine > best) wins[e] += 1;
      else if (mine === best) wins[e] += 1 / (atBest + 1);
    }
  }
  const plain = wins[0] / sims;
  const flips = picks
    .map((p, i) => ({ pick: p, win: flippable[i] ? wins[i + 1] / sims : null }))
    .filter((f): f is { pick: ConfidencePick; win: number } => f.win !== null)
    .sort((a, b) => b.win - a.win);
  return { plain, flips, players: rivals + 1 };
}
