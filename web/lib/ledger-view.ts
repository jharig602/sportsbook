/**
 * The ledger as the Bets page reads it: graded tickets, hedges, the open-ticket summary
 * (fair chance, hold value, live chance once a game is under way) and the record by type.
 *
 * Moved out of the page verbatim so the Claude connector (mcp-tools.ts) answers "what is
 * open and what is it worth" with exactly the numbers the page shows -- two copies of
 * this would drift, and a cash-out decision made on the wrong one costs money.
 */
import type { BookLineRow } from "./book-lines";
import { hedgeBestCase, type Hedge } from "./hedge";
import type { ScoreModel } from "./joint-score";
import { fairAt } from "./kalshi";
import { kalshiHistory } from "./kalshi-db";
import { liveGamesFor } from "./live-scores";
import { liveChance, scoreLine, type LiveGame } from "./live-value";
import { fairChance, openSummary } from "./open-summary";
import { ledgerSections } from "./ordering";
import type { MarginModel } from "./probability";
import { recordByType } from "./record-by-type";
import { activeBets, decimalOdds, tally, type Bet, type GradedRow, type Score } from "./settle";
import { yearTax, type TaxSetting } from "./tax";
import type { Game, GameResult } from "./types";

/** Kalshi's fair chance for this side when the bet was logged and at kickoff. */
export type KalshiClv = { atBet: number | null; atStart: number | null };

export interface LedgerInput {
  games: Game[];
  results: GameResult[];
  models: Record<string, MarginModel>;
  lines: Map<string, BookLineRow[]>;
  bets: Bet[];
  tax: TaxSetting;
  /** Loaded only when a game with money on it is under way. */
  scoreModels: () => Promise<Record<string, ScoreModel>>;
}

export async function ledgerView(input: LedgerInput) {
  const { games, results, models, lines, bets, tax } = input;
  const data = { scoreModels: input.scoreModels };
  const scores = new Map<string, Score>(
    results.map((r) => [r.event_id, { home_score: r.home_score, away_score: r.away_score }]),
  );
  // Corrected rows are replaced by their corrections before anything is counted.
  // Counting both would book the same wager twice, which is the failure a correction
  // is supposed to prevent.
  const standing = activeBets(bets);
  // Legs by ticket, so a parlay row can list what it is made of.
  const parlayLegs = new Map<string, Bet[]>();
  for (const bet of standing) {
    if (!bet.parlay_id) continue;
    parlayLegs.set(bet.parlay_id, [...(parlayLegs.get(bet.parlay_id) ?? []), bet]);
  }
  const corrections = bets.length - standing.length;
  const { rows, totals, hedges } = tally(standing, scores);
  // Kalshi when each single moneyline bet was logged and at its kickoff (kalshi.ts).
  const mlSingles = rows.filter((r) => r.market === "moneyline" && !r.parlay_id && (r.side === "home" || r.side === "away"));
  const kalshiSnaps = await kalshiHistory([...new Set(mlSingles.map((r) => r.event_id))]).catch(() => new Map());
  const kalshiClv = new Map<string, KalshiClv>();
  for (const r of mlSingles) {
    const snaps = kalshiSnaps.get(r.event_id);
    if (!snaps) continue;
    const side = r.side as "home" | "away";
    kalshiClv.set(r.bet_id, {
      atBet: fairAt(snaps, side, r.placed_at),
      atStart: r.commence_time ? fairAt(snaps, side, r.commence_time) : null,
    });
  }

  // Live, then soonest kickoff, then won, lost and the rest. See ordering.ts.
  // A hedge is shown as ONE card, as it is counted: its first bet stands in for the
  // position (net money, net outcome) and the rest are folded into it. See hedge.ts.
  const hedgeOf = new Map<string, Hedge>();
  for (const h of hedges) for (const leg of h.legs) hedgeOf.set(leg.bet_id, h);
  const display: GradedRow[] = [];
  for (const row of rows) {
    const h = hedgeOf.get(row.bet_id);
    if (!h) display.push(row);
    else if (h.legs[0].bet_id === row.bet_id) {
      display.push({ ...row, bet_id: h.id, outcome: h.outcome, profit: h.profit, stake: h.stake, cashout: null });
    }
  }
  const hedgeById = new Map(hedges.map((h) => [h.id, h]));
  const sections = ledgerSections(display, parlayLegs);
  // The record by kind of ticket (record-by-type.ts).
  const byType = recordByType(rows, parlayLegs);

  // What is riding on the open tickets, priced against the other books. See open-summary.ts.
  const gamesById = new Map(games.map((g) => [g.eventId, g]));
  // Games under way with money on them get their live score -- one cached ESPN request
  // per league, and only when there is such a game. See live-scores.ts.
  const nowMs = Date.now();
  const startedLegs = standing.filter(
    (b) => b.commence_time && Date.parse(b.commence_time) <= nowMs && !scores.has(b.event_id),
  );
  const [liveByEvent, scoreModels] = startedLegs.length
    ? await Promise.all([
        liveGamesFor(startedLegs.map((b) => ({ eventId: b.event_id, league: b.league }))),
        data.scoreModels().catch(() => ({})),
      ])
    : [new Map<string, LiveGame>(), {} as Record<string, ScoreModel>];
  // Why a started game could not be priced live, for the row to say rather than guess.
  const whyNotLive = (bet: Bet): string => {
    if (liveByEvent.size === 0) return "ESPN's live scores could not be read";
    const game = liveByEvent.get(bet.event_id);
    if (!game) return "ESPN has no live score for this game";
    if (game.state === "pre") return "ESPN does not show it as kicked off yet";
    if (!gamesById.get(bet.event_id)) return "its pregame line is not on the board";
    if (!(scoreModels as Record<string, ScoreModel>)[bet.league]) return "no fitted score model for the league";
    return "this bet type cannot be priced live";
  };
  const liveChanceOf = (bet: Bet): number | null => {
    const game = liveByEvent.get(bet.event_id);
    const board = gamesById.get(bet.event_id);
    if (!game || game.state === "pre" || !board) return null;
    return liveChance(
      bet,
      game,
      { homeSpread: board.spread?.home?.line ?? null, total: board.total?.over?.line ?? null },
      (scoreModels as Record<string, ScoreModel>)[bet.league],
    );
  };
  const open = openSummary(
    rows,
    parlayLegs,
    (bet) =>
      liveChanceOf(bet) ??
      fairChance(bet, gamesById.get(bet.event_id), lines.get(bet.event_id) ?? [], models[bet.league] ?? null),
    scores,
    tax,
  );
  // This year's estimated tax from the settled tickets (tax.ts). Owner's setting.
  const taxYear = yearTax(rows, tax, new Date().getUTCFullYear());
  // The score to show beside a ticket: every started leg must have been priced live, or
  // the figure is partly pregame and is labelled as such instead.
  const liveLabel = (row: GradedRow): string | null => {
    const legs = row.parlay_id ? parlayLegs.get(row.parlay_id) ?? [row] : [row];
    const started = legs.filter((b) => b.commence_time && Date.parse(b.commence_time) <= nowMs && !scores.has(b.event_id));
    if (started.length === 0) return null;
    if (started.some((b) => liveChanceOf(b) === null)) return null;
    return started
      .map((b) => scoreLine(liveByEvent.get(b.event_id)!, { away: b.away_team, home: b.home_team }))
      .join(" | ");
  };
  const staleReason = (row: GradedRow): string | null => {
    const legs = row.parlay_id ? parlayLegs.get(row.parlay_id) ?? [row] : [row];
    const miss = legs.find(
      (b) => b.commence_time && Date.parse(b.commence_time) <= nowMs && !scores.has(b.event_id) && liveChanceOf(b) === null,
    );
    return miss ? whyNotLive(miss) : null;
  };

  // "If all win" adds every ticket's winnings; for a hedge only one side can win, so
  // swap its legs' sum for its best case.
  let ifAllWin = open.ifAllWin;
  for (const h of hedges) {
    if (h.outcome !== "open") continue;
    const sum = h.legs.reduce((acc, leg) => {
      const d = decimalOdds(leg.price);
      return acc + (d === null ? 0 : leg.stake * (d - 1));
    }, 0);
    ifAllWin += hedgeBestCase(h.legs) - sum;
  }

  return {
    scores, standing, parlayLegs, corrections, rows, totals, hedges, kalshiClv, hedgeOf, display, hedgeById, sections, byType, gamesById, nowMs, startedLegs, liveByEvent, scoreModels, whyNotLive, liveChanceOf, open, taxYear, liveLabel, staleReason, ifAllWin,
  };
}

export type LedgerView = Awaited<ReturnType<typeof ledgerView>>;
export type { Hedge, GradedRow };
