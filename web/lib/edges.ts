import { deVig, effectiveSpread, winProbabilityFromSpread, type MarginModel } from "./probability.ts";
import type { Game, League, Side } from "./types";

/**
 * Where the spread and the moneyline disagree, ranked — with the model's own
 * uncertainty attached to every row.
 *
 * The uncertainty is the point. The model is a sample estimate, so its output has a
 * standard error of roughly sqrt(p(1-p)/n); at 291 NFL games that is about 2.9
 * percentage points. An "edge" smaller than that is indistinguishable from the noise
 * in the estimate that produced it, and ranking a list by such numbers sorts by where
 * the model is most wrong rather than where the market is.
 *
 * That is not hypothetical. The largest edge this ever produced was 6.6 points on one
 * game; a single bug fix — reading a juiced spread literally instead of pricing it —
 * moved the same game, same prices, to 2.8. Rows inside the noise band are marked so
 * they cannot be mistaken for findings.
 */
export interface Edge {
  eventId: string;
  league: League;
  commenceTime: string;
  homeTeam: string | null;
  awayTeam: string | null;
  homeTeamId: string | null;
  awayTeamId: string | null;
  /** The side the model likes, if either. */
  side: Side;
  team: string | null;
  price: number;
  postedSpread: number;
  /** What the spread's own juice says the book really believes. */
  effectiveSpread: number;
  market: number;
  model: number;
  edgePoints: number;
  /** Standard error of the model estimate, in percentage points. */
  standardErrorPoints: number;
  /** True when the edge exceeds the model's own sampling noise. */
  outsideNoise: boolean;
  games: number;
}

export function standardErrorPoints(probability: number, games: number): number {
  if (games <= 0) return Infinity;
  return Math.sqrt((probability * (1 - probability)) / games) * 100;
}

export function buildEdges(
  games: Game[],
  models: Record<string, MarginModel>,
): Edge[] {
  const edges: Edge[] = [];

  for (const game of games) {
    const model = models[game.league];
    if (!model) continue;

    const homeSpread = game.spread.home?.line;
    const awaySpread = game.spread.away?.line;
    const homeMl = game.moneyline.home?.price;
    const awayMl = game.moneyline.away?.price;
    if (homeSpread === undefined || homeSpread === null) continue;
    if (homeMl === null || homeMl === undefined) continue;
    if (awayMl === null || awayMl === undefined) continue;
    if (awaySpread === undefined) continue;

    const spreadFair = deVig(game.spread.home?.price ?? null, game.spread.away?.price ?? null);
    const trueSpread = effectiveSpread(model, homeSpread, spreadFair?.a ?? null);

    const mlFair = deVig(homeMl, awayMl);
    if (!mlFair) continue;

    const modelHome = winProbabilityFromSpread(model, trueSpread, "home");
    if (modelHome === null || Number.isNaN(modelHome)) continue;

    // Report the side the model prefers; the other side is its mirror image.
    const homeEdge = (modelHome - mlFair.a) * 100;
    const side: Side = homeEdge >= 0 ? "home" : "away";
    const modelProbability = side === "home" ? modelHome : 1 - modelHome;
    const marketProbability = side === "home" ? mlFair.a : mlFair.b;
    const edgePoints = Math.abs(homeEdge);
    const error = standardErrorPoints(modelProbability, model.games);

    edges.push({
      eventId: game.eventId,
      league: game.league,
      commenceTime: game.commenceTime,
      homeTeam: game.homeTeam,
      awayTeam: game.awayTeam,
      homeTeamId: game.homeTeamId,
      awayTeamId: game.awayTeamId,
      side,
      team: side === "home" ? game.homeTeam : game.awayTeam,
      price: side === "home" ? homeMl : awayMl,
      postedSpread: homeSpread,
      effectiveSpread: trueSpread,
      market: marketProbability,
      model: modelProbability,
      edgePoints,
      standardErrorPoints: error,
      outsideNoise: edgePoints > error,
      games: model.games,
    });
  }

  return edges.sort((a, b) => b.edgePoints - a.edgePoints);
}
