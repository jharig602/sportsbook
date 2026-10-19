/**
 * Kalshi, read-only: one more fair-price reference, and the flags it makes possible.
 *
 * The collector (`collector/kalshi.py`) does the fetching, matching and flag-finding and
 * writes pregame snapshots to `exchange_quotes` and flags to `exchange_flags`. This
 * module turns those rows into what the pages show, and decides who may see what.
 *
 * Three uses:
 *
 * - **A reference in every comparison.** A deep, tight Kalshi market's midpoint joins
 *   the book-lines rows as a no-vig "Kalshi" quote marked `reference`, so the line shop,
 *   boost finder, confidence chances and same-game parlays all count it among the other
 *   books -- and nothing ever offers it as a place to bet.
 * - **Flag 1, stale book.** A sportsbook whose no-vig chance sits well under Kalshi's.
 *   The bet is at the sportsbook, so everyone sees it.
 * - **Flags 2 and 3** buy on Kalshi, which is barred in Michigan (preliminary injunction,
 *   2026-09-01). They are always computed and stored; `kalshiFlagsVisible` decides from
 *   the config's `blockedStates` whether a viewer may see them. While blocked they are a
 *   shadow log. Removing a state from the config turns them on with no code change.
 *
 * Settings, thresholds and team codes are data: `web/config/kalshi.json` and
 * `kalshi-aliases.json`, read by both the collector and this module.
 */
import config from "../config/kalshi.json";
import type { BookLineRow } from "./book-lines";
import type { League } from "./types";

export const KALSHI_BOOK = "Kalshi";

export interface KalshiConfig {
  blockedStates: string[];
  thin: { maxSpreadDollars: number; minDepthContracts: number };
  fee: { takerCoefficient: number };
  flags: { staleBookPoints: number; kalshiValuePoints: number; arbMarginPoints: number };
}

export const KALSHI_CONFIG: KalshiConfig = config as KalshiConfig;

/** One team's contract as last seen before kickoff (`exchange_quotes`). */
export interface KalshiSnapshot {
  eventId: string;
  league: League;
  side: "home" | "away";
  marketTicker: string;
  observedAt: string;
  yesBid: number | null;
  yesAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  lastPrice: number | null;
  thin: boolean;
}

export interface KalshiGame {
  home: KalshiSnapshot;
  away: KalshiSnapshot;
}

export type FlagKind = "stale_book" | "kalshi_value" | "arb";

export interface KalshiFlag {
  flagId: string;
  observedAt: string;
  league: League;
  eventId: string;
  commenceTime: string | null;
  kind: FlagKind;
  side: "home" | "away";
  book: string | null;
  bookPrice: number | null;
  bookFair: number | null;
  kalshiFair: number;
  kalshiCost: number | null;
  consensus: number | null;
  edgePoints: number;
  books: number;
}

/** Flags 2 and 3 involve buying on Kalshi; only these are gated by state. */
export const GATED_KINDS: FlagKind[] = ["kalshi_value", "arb"];

/**
 * May this viewer see flags that buy on Kalshi? Only when their state is known and not
 * on the blocked list. An unknown state is treated as blocked: showing a Michigan
 * resident a bet they cannot legally make is the failure to avoid, and "we did not know
 * where you were" is not a reason to show it.
 */
export function kalshiFlagsVisible(state: string | null | undefined, cfg: KalshiConfig = KALSHI_CONFIG): boolean {
  if (!state) return false;
  return !cfg.blockedStates.map((s) => s.toUpperCase()).includes(state.toUpperCase());
}

/** The flags a viewer may see: stale-book always, the rest only where Kalshi is legal. */
export function visibleFlags<T extends { kind: FlagKind }>(
  flags: T[],
  state: string | null | undefined,
  cfg: KalshiConfig = KALSHI_CONFIG,
): T[] {
  const open = kalshiFlagsVisible(state, cfg);
  return flags.filter((f) => open || !GATED_KINDS.includes(f.kind));
}

export function isThin(s: { yesBid: number | null; yesAsk: number | null; bidSize: number | null; askSize: number | null }, cfg: KalshiConfig = KALSHI_CONFIG): boolean {
  if (s.yesBid === null || s.yesAsk === null) return true;
  if (s.yesAsk - s.yesBid > cfg.thin.maxSpreadDollars + 1e-9) return true;
  return Math.min(s.bidSize ?? 0, s.askSize ?? 0) < cfg.thin.minDepthContracts;
}

/** Home's fair chance: the two mirrored midpoints, averaged. Null when either is unquoted. */
export function kalshiFair(game: KalshiGame): number | null {
  const { home, away } = game;
  if (home.yesBid === null || home.yesAsk === null || away.yesBid === null || away.yesAsk === null) return null;
  const homeMid = (home.yesBid + home.yesAsk) / 2;
  const awayMid = (away.yesBid + away.yesAsk) / 2;
  return (homeMid + (1 - awayMid)) / 2;
}

/** One contract bought at the ask, with Kalshi's taker fee: coefficient x p x (1 - p). */
export function effectiveAsk(ask: number | null, cfg: KalshiConfig = KALSHI_CONFIG): number | null {
  if (ask === null || !(ask > 0 && ask < 1)) return null;
  return ask + cfg.fee.takerCoefficient * ask * (1 - ask);
}

/** A cost in dollars per $1 payout, as an American price: $0.577 is about -137. */
export function costToAmerican(cost: number | null): number | null {
  if (cost === null || !(cost > 0 && cost < 1)) return null;
  const american = cost >= 0.5 ? (-100 * cost) / (1 - cost) : (100 * (1 - cost)) / cost;
  const rounded = Math.round(american);
  // A fair coin rounds to -100 or +100, never into the -99..99 gap no price can occupy.
  if (rounded > -100 && rounded < 100) return cost >= 0.5 ? -100 : 100;
  return rounded;
}

/**
 * Kalshi as book-lines rows: its fair midpoint for each side as a no-vig American price,
 * marked `reference` so comparisons count it and nothing offers it as a bet. Only deep,
 * tight markets qualify -- a thin book says what one trader wants, not what the market
 * thinks.
 */
export function referenceRows(game: KalshiGame, cfg: KalshiConfig = KALSHI_CONFIG): BookLineRow[] {
  if (isThin(game.home, cfg) || isThin(game.away, cfg)) return [];
  const fair = kalshiFair(game);
  if (fair === null) return [];
  const observedAt = game.home.observedAt < game.away.observedAt ? game.home.observedAt : game.away.observedAt;
  return (["home", "away"] as const).map((side) => ({
    quote_id: `kalshi:${game[side].marketTicker}:${observedAt}`,
    observed_at: observedAt,
    league: game.home.league,
    event_id: game.home.eventId,
    book: KALSHI_BOOK,
    market: "moneyline",
    side,
    line: null,
    price: costToAmerican(side === "home" ? fair : 1 - fair),
    source: "kalshi",
    note: "Kalshi midpoint, no vig: a reference, not a place to bet",
    reference: true,
  }));
}

/** Pair a game's two latest snapshots, or null when one side is missing. */
export function pairSnapshots(rows: KalshiSnapshot[]): Map<string, KalshiGame> {
  const byEvent = new Map<string, Partial<KalshiGame>>();
  for (const row of rows) {
    const game = byEvent.get(row.eventId) ?? {};
    game[row.side] = row;
    byEvent.set(row.eventId, game);
  }
  const out = new Map<string, KalshiGame>();
  for (const [eventId, game] of byEvent) {
    if (game.home && game.away) out.set(eventId, { home: game.home, away: game.away });
  }
  return out;
}

/**
 * What a gated flag would have paid, for the shadow log. Per $1 of payout:
 * - kalshi_value: bought one contract at `kalshiCost`; it pays $1 if the side won.
 * - arb: both legs sized to pay $1 whichever side wins, so the result is locked in at
 *   `edgePoints` cents and does not depend on the score (a tie aside).
 */
export function shadowProfit(flag: Pick<KalshiFlag, "kind" | "kalshiCost" | "edgePoints">, sideWon: boolean | null): number | null {
  if (flag.kind === "arb") return flag.edgePoints / 100;
  if (flag.kind === "kalshi_value") {
    if (sideWon === null || flag.kalshiCost === null) return null;
    return (sideWon ? 1 : 0) - flag.kalshiCost;
  }
  return null;
}

/**
 * A side's Kalshi fair chance as it stood at `at`: the latest snapshot of each contract
 * at or before then, or null when there is none or the market was thin. Bets are
 * append-only, so Kalshi's price at bet time and at kickoff is derived from the snapshot
 * history rather than stored on the bet.
 */
export function fairAt(snapshots: KalshiSnapshot[], side: "home" | "away", at: string, cfg: KalshiConfig = KALSHI_CONFIG): number | null {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return null;
  const latest: Partial<KalshiGame> = {};
  for (const s of snapshots) {
    if (Date.parse(s.observedAt) > t) continue;
    const prior = latest[s.side];
    if (!prior || prior.observedAt < s.observedAt) latest[s.side] = s;
  }
  if (!latest.home || !latest.away) return null;
  const game = { home: latest.home, away: latest.away };
  if (isThin(game.home, cfg) || isThin(game.away, cfg)) return null;
  const fair = kalshiFair(game);
  return fair === null ? null : side === "home" ? fair : 1 - fair;
}
