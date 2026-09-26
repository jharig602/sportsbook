/**
 * What a bet is worth mid-game, from the score, the clock and the pregame line.
 *
 * The final margin is what is already on the board plus what the rest of the game adds.
 * The rest of the game is modelled as a proportional slice of the pregame expectation:
 * with a fraction `f` of the clock left, it is expected to add `f` of the pregame margin
 * (and of the pregame total), scattered with `sqrt(f)` of the full game's spread -- the
 * way a sum of independent scoring drives scales. That is the standard in-game model
 * (Stern, 1994), and at kickoff it reduces exactly to the pregame number, which the
 * tests hold it to.
 *
 * What it does not know: possession, field position, injuries, weather, a team that has
 * stopped trying. Late in a close game those decide it, and a book's live line will be
 * sharper than this. It is a fair yardstick for a cash-out offer, not a live odds feed.
 *
 * Starting point: the Board's lines, which are the last PREGAME quotes -- the collector
 * stops polling a game before kickoff (`odds_poller.eligible`), so they cannot have
 * drifted with the score. Scatter: the fitted `score_models` for the league.
 */
import type { ScoreModel } from "./joint-score";
import { normalCdf } from "./probability";
import type { Bet } from "./settle";

export interface LiveGame {
  eventId: string;
  state: "pre" | "in" | "post";
  /** 1-4 regulation, 5+ overtime. */
  period: number;
  /** Seconds left in the period. */
  clockSeconds: number;
  homeScore: number;
  awayScore: number;
  /** ESPN's own short status, e.g. "8:12 - 3rd" or "Halftime". */
  detail: string;
  homeAbbr: string;
  awayAbbr: string;
}

const QUARTER = 900;
const REGULATION = 4 * QUARTER;

/** Share of the game still to play: 1 before kickoff, 0 at the final whistle. */
export function fractionLeft(game: LiveGame): number {
  if (game.state === "post") return 0;
  if (game.state === "pre") return 1;
  const period = Math.max(1, game.period);
  const clock = Math.max(0, Math.min(QUARTER, game.clockSeconds));
  // Overtime: whatever is on its clock. College overtime has no clock, so a minute's
  // worth of scatter stands in for "a possession or two each".
  if (period > 4) return Math.max(60, clock) / REGULATION;
  return ((4 - period) * QUARTER + clock) / REGULATION;
}

/** The pregame numbers the rest of the game is scaled from. */
export interface Pregame {
  /** Home spread, negative when home is favoured. */
  homeSpread: number | null;
  total: number | null;
}

/**
 * The chance this bet wins from here. Null for what it cannot price: a team total, a
 * missing pregame line, a league with no fitted model.
 */
export function liveChance(
  bet: Bet,
  game: LiveGame,
  pregame: Pregame,
  model: ScoreModel | null | undefined,
): number | null {
  if (!model || game.state === "pre") return null;
  if (bet.market === "total" && bet.team) return null;
  const f = fractionLeft(game);
  const margin = game.homeScore - game.awayScore;
  const points = game.homeScore + game.awayScore;

  // P(X > c) and P(X < c) for a score, with the half-point continuity correction on a
  // whole-number line (a whole number can land exactly and push).
  const dist = (current: number, pregameMean: number, sd: number) => {
    const mean = current + f * pregameMean;
    const spread = Math.max(0.5, sd * Math.sqrt(f));
    return {
      above: (c: number) => 1 - normalCdf(((Number.isInteger(c) ? c + 0.5 : c) - mean) / spread),
      below: (c: number) => normalCdf(((Number.isInteger(c) ? c - 0.5 : c) - mean) / spread),
    };
  };

  if (bet.market === "total") {
    if (pregame.total === null || bet.line === null) return null;
    const t = dist(points, pregame.total + model.totalMean, model.totalSd);
    return bet.side === "over" ? t.above(bet.line) : t.below(bet.line);
  }

  if (pregame.homeSpread === null) return null;
  const m = dist(margin, -pregame.homeSpread + model.marginMean, model.marginSd);
  if (bet.market === "moneyline") return bet.side === "home" ? m.above(0) : m.below(0);
  if (bet.line === null) return null;
  // The line is quoted for the side bet: home covers when margin > -line; away covers
  // when -margin > -line, i.e. margin < line.
  return bet.side === "home" ? m.above(-bet.line) : m.below(bet.line);
}

/** "DET 17-10 NYJ · 8:12 - 3rd", for the bet row. */
export function scoreLine(game: LiveGame): string {
  return `${game.awayAbbr} ${game.awayScore}–${game.homeScore} ${game.homeAbbr} · ${game.detail}`;
}
