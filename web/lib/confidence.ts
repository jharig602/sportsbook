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

/** How the pool's players pick, measured from its sheets (weeks 1, 2, 4, 5). */
export const POOL_HABITS = {
  /** Favourite sharpening: P(pick fav) = p^k / (p^k + (1-p)^k). 76% took the favourite in 55-65% games. */
  k: 2.5,
  /** Noise on their ranking; gives points-vs-odds correlation ~0.75, as measured. */
  sd: 0.12,
};

function rng(seed: number) {
  let state = seed;
  const rand = () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const normal = () => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
  return { rand, normal };
}

/** Simulated weeks: who won each game, and the best rival score (and how many share it). */
function simulateField(picks: ConfidencePick[], rivals: number, sims: number, seed: number) {
  const { rand, normal } = rng(seed);
  const n = picks.length;
  const slots = picks.map((p) => p.points).sort((a, b) => b - a);
  const favWon = new Uint8Array(sims * n);
  const best = new Float64Array(sims);
  const atBest = new Uint16Array(sims);
  const sharpen = (p: number) => p ** POOL_HABITS.k / (p ** POOL_HABITS.k + (1 - p) ** POOL_HABITS.k);
  const perceived = new Array<{ i: number; v: number; fav: boolean }>(n);
  for (let s = 0; s < sims; s++) {
    for (let i = 0; i < n; i++) favWon[s * n + i] = rand() < picks[i].chance ? 1 : 0;
    let top = -1;
    let count = 0;
    for (let r = 0; r < rivals; r++) {
      for (let i = 0; i < n; i++) {
        const fav = rand() < sharpen(picks[i].chance);
        perceived[i] = { i, v: (fav ? picks[i].chance : 1 - picks[i].chance) + POOL_HABITS.sd * normal(), fav };
      }
      const order = [...perceived].sort((a, b) => b.v - a.v);
      let score = 0;
      for (let k = 0; k < n; k++) if ((order[k].fav ? 1 : 0) === favWon[s * n + order[k].i]) score += slots[k];
      if (score > top) { top = score; count = 1; } else if (score === top) count += 1;
    }
    best[s] = top;
    atBest[s] = count;
  }
  return { n, sims, favWon, best, atBest };
}

type Field = ReturnType<typeof simulateField>;

/** Share of simulated weeks won (ties for first split) by an entry: side and points per game. */
function winShare(field: Field, fav: boolean[], points: number[]): { win: number; scores: Float64Array } {
  const { n, sims, favWon, best, atBest } = field;
  const scores = new Float64Array(sims);
  let win = 0;
  for (let s = 0; s < sims; s++) {
    let score = 0;
    for (let i = 0; i < n; i++) if ((fav[i] ? 1 : 0) === favWon[s * n + i]) score += points[i];
    scores[s] = score;
    win += score > best[s] ? 1 : score === best[s] ? 1 / (atBest[s] + 1) : 0;
  }
  return { win: win / sims, scores };
}

export interface WeeklyEntry {
  picks: Array<ConfidencePick & { underdog: boolean; entryPoints: number; entryTeam: string }>;
  /** Chance of winning the week, measured on fresh simulated weeks (not the ones searched). */
  win: number;
  /** The plain ranking on those same fresh weeks. */
  plain: number;
  /** Expected points given up against the plain ranking. */
  cost: number;
}

/**
 * The entry most likely to WIN THE WEEK against this pool -- not the most points.
 *
 * Starts from the plain ranking and climbs: any game may be switched to its underdog and
 * any two games may trade point slots; each step keeps the change that wins the most
 * simulated weeks. Rivals' picks do not depend on yours, so each simulated week's best
 * rival score is drawn once and every candidate is scored against the same weeks. The
 * answer is then re-measured on a fresh set of weeks, so a change that only fit the
 * noise of the search set shows up as no gain. Games already kicked off are left alone.
 */
export function bestWeeklyEntry(
  picks: ConfidencePick[],
  options: { rivals?: number; sims?: number; now?: number; seed?: number } = {},
): WeeklyEntry {
  const rivals = options.rivals ?? 11;
  const sims = options.sims ?? 8000;
  const now = options.now ?? Date.now();
  const n = picks.length;
  const open = picks.map((p) => Date.parse(p.game.commenceTime) > now);
  const search = simulateField(picks, rivals, sims, options.seed ?? 6);
  const fav = picks.map(() => true);
  const points = picks.map((p) => p.points);
  let current = winShare(search, fav, points);

  for (let step = 0; step < 40; step++) {
    let bestMove: (() => void) | null = null;
    let bestWin = current.win + 0.5 / sims;
    const tryMove = (apply: () => void, undo: () => void) => {
      apply();
      const w = winShare(search, fav, points).win;
      if (w > bestWin) { bestWin = w; bestMove = apply; }
      undo();
    };
    for (let i = 0; i < n; i++) {
      if (!open[i]) continue;
      tryMove(() => { fav[i] = !fav[i]; }, () => { fav[i] = !fav[i]; });
      for (let j = i + 1; j < n; j++) {
        if (!open[j]) continue;
        const swap = () => { [points[i], points[j]] = [points[j], points[i]]; };
        tryMove(swap, swap);
      }
    }
    if (!bestMove) break;
    (bestMove as () => void)();
    current = winShare(search, fav, points);
  }

  const check = simulateField(picks, rivals, Math.max(sims, 12000), (options.seed ?? 6) + 1000);
  const win = winShare(check, fav, points).win;
  const plain = winShare(check, picks.map(() => true), picks.map((p) => p.points)).win;
  const expected = picks.reduce((sum, p, i) => sum + points[i] * (fav[i] ? p.chance : 1 - p.chance), 0);
  const plainExpected = picks.reduce((sum, p) => sum + p.points * p.chance, 0);
  return {
    picks: picks
      .map((p, i) => ({ ...p, underdog: !fav[i], entryPoints: points[i], entryTeam: fav[i] ? p.team : p.opponent }))
      .sort((a, b) => b.entryPoints - a.entryPoints),
    win,
    plain,
    cost: plainExpected - expected,
  };
}
