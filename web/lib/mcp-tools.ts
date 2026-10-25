/**
 * The Claude connector's eight read-only tools (dissent-mcp-connector-spec.md).
 *
 * Each one calls the same functions the app's pages call -- the Shop's `buildBoardShop`,
 * the Promos page's `findBoosts`, the Bets page's `ledgerView`, the Survivor page's
 * planner -- so an answer in chat is the number on the screen, not a second opinion.
 * Nothing here writes anything.
 *
 * Every answer is a short summary plus compact rows (top 10 by default), every price
 * carries `as_of` and `stale` (over 10 minutes old), and offshore books are left out of
 * what is RECOMMENDED unless asked for -- they still count in every consensus, as on the
 * Shop page.
 */
import { DEFAULT_MAX_SPREAD, withoutBlowouts } from "./blowout";
import { buildBoardShop, type BoardEdge } from "./board-shop";
import { allBookLines, quotesForGame, type BookLineRow } from "./book-lines";
import { isOffshore } from "./book-links";
import { findBoosts, type BoostPick } from "./boost-finder";
import { listBets, recordLegResult, saveBet, saveParlay } from "./bets-db";
import { getData } from "./data";
import { databaseUrl } from "./env";
import type { ScoreModel } from "./joint-score";
import { kalshiFair } from "./kalshi";
import { kalshiGames } from "./kalshi-db";
import { ledgerView } from "./ledger-view";
import {
  american,
  asOf,
  betName,
  clampLimit,
  easternDate,
  fraction,
  freshnessLine,
  meetsMinOdds,
  money,
  parseDate,
  parseLeague,
  quoteSeenAt,
  resolveBook,
  round,
  sideName,
} from "./mcp-format";
import { HOUSE } from "./owner";
import { fieldState, poolLabel } from "./pools";
import { buildPoolWinPlans, crowdingFrom } from "./pool-win";
import { deVig, impliedProbability, lineProbability, type MarginModel } from "./probability";
import { listPromos, listUses, recordUse } from "./promos-db";
import type { WriteDeps } from "./mcp-write";
import { legLabel } from "./result-push";
import { currentNflWeek, pickPopularity, seasonGames, seasonOpener } from "./season-db";
import { activeBets, recordResult, type Bet, type GradedRow } from "./settle";
import { getFavourites, getPools, getTax } from "./settings-db";
import { shopAll } from "./shop";
import { buildPlan } from "./survivor";
import { entryOdds, openWeeks, weekZero } from "./survivor-view";
import { boostNeeded, bonusValue, DEFAULT_TAX, type TaxSetting } from "./tax";
import type { Game, Market, Promo, Side } from "./types";

export interface ToolAnswer {
  summary: string;
  data: unknown;
}

/** A problem with what was asked, said back plainly (not an outage). */
export class ToolInputError extends Error {}

/* ------------------------------------------------------------------ shared reads */

// Odds reads are cached for 45 seconds per warm instance (the spec asks for 30-60): a
// chat that calls three tools in a row should not run the board query three times.
const TTL_MS = 45_000;
const memo = new Map<string, { at: number; value: Promise<unknown> }>();
function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = memo.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value as Promise<T>;
  const value = load();
  memo.set(key, { at: Date.now(), value });
  value.catch(() => memo.delete(key));
  return value;
}

export interface Market_ {
  games: Game[];
  lines: Map<string, BookLineRow[]>;
  models: Record<string, MarginModel>;
  scoreModels: Record<string, ScoreModel>;
  lastRun: string | null;
}

function marketData(): Promise<Market_> {
  return cached("market", async () => {
    const data = getData();
    const pg = data.backend === "postgres";
    const [games, lines, models, scoreModels, freshness] = await Promise.all([
      data.games(),
      pg ? allBookLines().catch(() => new Map<string, BookLineRow[]>()) : Promise.resolve(new Map<string, BookLineRow[]>()),
      data.marginModels(),
      data.scoreModels().catch(() => ({}) as Record<string, ScoreModel>),
      data.freshness().catch(() => null),
    ]);
    return { games, lines, models, scoreModels, lastRun: freshness?.lastRun ?? null };
  });
}

/** Preloaded reads, for tests: the tools otherwise load these themselves. */
export interface ToolDeps {
  market?: Market_;
  settings?: { tax: TaxSetting; favourites: string[] };
  openEvents?: Set<string>;
}

function settings() {
  return cached("settings", async () => {
    const pg = getData().backend === "postgres";
    const [tax, favourites] = await Promise.all([
      pg ? getTax().catch(() => DEFAULT_TAX) : Promise.resolve(DEFAULT_TAX),
      pg ? getFavourites().catch(() => [] as string[]) : Promise.resolve([] as string[]),
    ]);
    return { tax, favourites };
  });
}

/** Books quoting anything right now: the stored ones plus DraftKings, which is the board. */
function booksIn(lines: Map<string, BookLineRow[]>): string[] {
  const books = new Set<string>(["DraftKings"]);
  for (const rows of lines.values()) for (const r of rows) if (!r.reference) books.add(r.book);
  return [...books].sort();
}

function pickBook(input: string, lines: Map<string, BookLineRow[]>): string {
  const books = booksIn(lines);
  const book = resolveBook(input, books);
  if (!book) {
    throw new ToolInputError(
      `No prices from "${input}" right now. Books with prices: ${books.filter((b) => !isOffshore(b)).join(", ")}.`,
    );
  }
  return book;
}

function filters(input: { sport?: string; date?: string }, now: Date) {
  const league = parseLeague(input.sport);
  if (league === "bad") throw new ToolInputError(`Sport must be NFL or NCAAF (college), not "${input.sport}".`);
  const date = parseDate(input.date, now);
  if (date === "bad") throw new ToolInputError(`Date must be today, tomorrow or YYYY-MM-DD, not "${input.date}".`);
  return {
    league,
    date,
    keep: (g: { league: string; commenceTime: string }) =>
      (!league || g.league === league) && (!date || easternDate(g.commenceTime) === date),
  };
}

function taxFrom(setting: TaxSetting, override: number | undefined): TaxSetting {
  const rate = fraction(override);
  if (rate === null) return setting;
  if (rate > 0.6) throw new ToolInputError("A tax rate over 60% is not one anybody pays.");
  return { ...setting, rate, state: Math.min(setting.state ?? 0, rate) };
}

const pct = (v: number) => `${Math.round(v * 1000) / 10}%`;

/* ------------------------------------------------------------------ 1. get_shop */

export interface ShopInput {
  book?: string;
  sport?: string;
  date?: string;
  market?: Market;
  min_edge_pct?: number;
  min_books?: number;
  include_offshore?: boolean;
  limit?: number;
}

export async function getShop(input: ShopInput, now = new Date(), deps: ToolDeps = {}): Promise<ToolAnswer> {
  const { games, lines, models } = deps.market ?? (await marketData());
  const f = filters(input, now);
  const book = input.book ? pickBook(input.book, lines) : null;
  const minBooks = input.min_books ?? 6;
  const limit = clampLimit(input.limit);

  const shop = buildBoardShop(games, lines, models, now);
  const { kept, removed: blowouts } = withoutBlowouts(shop.rows, DEFAULT_MAX_SPREAD);
  const gamesById = new Map(games.map((g) => [g.eventId, g]));

  let rows: BoardEdge[] = kept.filter(
    (r) =>
      f.keep(r) &&
      (!input.market || r.market === input.market) &&
      (!book || r.book === book) &&
      (input.include_offshore || book !== null || !isOffshore(r.book)),
  );
  const thin = rows.filter((r) => r.booksCompared < minBooks).length;
  rows = rows.filter((r) => r.booksCompared >= minBooks);
  if (input.min_edge_pct !== undefined) {
    rows = rows.filter((r) => r.expectedRoi !== null && r.expectedRoi * 100 >= input.min_edge_pct!);
  }
  const positive = rows.filter((r) => (r.expectedRoi ?? -1) > 0).length;

  const out = rows.slice(0, limit).map((r) => {
    const game = gamesById.get(r.eventId);
    const seen = game ? quoteSeenAt(game, lines.get(r.eventId) ?? [], r.book, r.market, r.side) : null;
    return {
      game: `${r.awayTeam} @ ${r.homeTeam}`,
      game_id: r.eventId,
      league: r.league,
      kickoff: r.commenceTime,
      book: r.book,
      bet: betName(r.market, r.side, r.line, { homeTeam: r.homeTeam, awayTeam: r.awayTeam }),
      market: r.market,
      price: r.price,
      consensus_line: r.consensusLine,
      consensus_prob: round(r.consensusProbability, 4),
      fair_prob: round(r.fairProbability, 4),
      edge_pct: round(r.expectedRoi === null ? null : r.expectedRoi * 100, 1),
      edge_points: round(r.edgePoints, 2),
      books_compared: r.booksCompared,
      ...asOf(seen, now),
    };
  });

  const where = book ? ` at ${book}` : input.include_offshore ? "" : " at licensed books";
  const lines_: string[] = [];
  if (out.length === 0) {
    lines_.push(`Nothing matches${where}${thin ? ` with ${minBooks}+ books to compare against (${thin} thinner rows left out)` : ""}.`);
  } else {
    const best = out[0];
    lines_.push(
      `${positive} of ${rows.length} lines beat the vig${where}. Best: ${best.book} ${best.bet} ${american(best.price)} (${best.game}), ` +
        `${best.edge_pct !== null && best.edge_pct > 0 ? "+" : ""}${best.edge_pct}% expected return against ${best.books_compared} books.`,
    );
    if (positive === 0) lines_.push("Nothing clears the vig; a book matching consensus sits near -4.5%.");
    lines_.push(freshnessLine(out, now));
    if (thin) lines_.push(`${thin} rows compared against fewer than ${minBooks} books were left out (mostly noise).`);
  }
  if (blowouts) lines_.push(`${blowouts} rows on games of ${DEFAULT_MAX_SPREAD}+ points are hidden, as on the Shop page.`);
  return { summary: lines_.join(" "), data: { rows: out, matching: rows.length, beat_the_vig: positive } };
}

/* ------------------------------------------------------------------ 2/3. boost and bonus finders */

function boostRows(picks: BoostPick[], lines: Map<string, BookLineRow[]>, games: Map<string, Game>, book: string, now: Date) {
  return picks.map((p) => {
    const game = games.get(p.eventId);
    const seen = game ? quoteSeenAt(game, lines.get(p.eventId) ?? [], book, p.market, p.side) : null;
    return { pick: p, ...asOf(seen, now) };
  });
}

export interface BoostInput {
  book: string;
  boost_pct: number;
  max_wager: number;
  min_odds?: number;
  sport?: string;
  date?: string;
  bet_types?: Array<"moneyline" | "total">;
  tax_rate?: number;
  limit?: number;
}

export async function findBoostSpots(input: BoostInput, now = new Date(), deps: ToolDeps = {}): Promise<ToolAnswer> {
  const [{ games, lines, models, scoreModels }, s] = await Promise.all([deps.market ?? marketData(), deps.settings ?? settings()]);
  const book = pickBook(input.book, lines);
  const boost = fraction(input.boost_pct);
  if (boost === null || boost <= 0 || boost > 3) throw new ToolInputError("boost_pct must be the boost size, e.g. 30 for a 30% profit boost.");
  if (!(input.max_wager > 0 && input.max_wager <= 10_000)) throw new ToolInputError("max_wager must be the token's maximum stake in dollars.");
  const tax = taxFrom(s.tax, input.tax_rate);
  const f = filters(input, now);
  const limit = clampLimit(input.limit);

  const found = findBoosts(games, lines, models, scoreModels, {
    book,
    boost,
    stake: input.max_wager,
    favourites: s.favourites,
    maxSpread: DEFAULT_MAX_SPREAD,
    tax,
  });
  const eligible = found.checked.filter(
    (p) => f.keep(p) && meetsMinOdds(p.price, input.min_odds) && (!input.bet_types?.length || input.bet_types.includes(p.market)),
  );
  const rows = boostRows(eligible.slice(0, limit), lines, new Map(games.map((g) => [g.eventId, g])), book, now).map(({ pick: p, ...stamp }) => ({
    game: p.game,
    game_id: p.eventId,
    league: p.league,
    kickoff: p.commenceTime,
    bet: p.label,
    price: p.price,
    boosted_price: p.logPrice,
    fair_prob: round(p.win, 4),
    push_prob: p.push ? round(p.push, 4) : undefined,
    basis: p.basis,
    ev_unboosted: round(p.plain, 2),
    ev_before_tax: round(p.boosted, 2),
    ev_after_tax: round(p.afterTax, 2),
    clears: p.afterTax > 0,
    ...stamp,
  }));

  const clearing = eligible.filter((p) => p.afterTax > 0).length;
  const parts: string[] = [];
  if (rows.length === 0) {
    parts.push(`No ${book} moneyline or total in the next 8 days fits those terms (${found.gamesAtBook} games priced there).`);
  } else if (clearing === 0) {
    const best = rows[0];
    parts.push(
      `A ${pct(boost)} boost at ${book} doesn't beat ${pct(tax.rate)} tax on any fairly priced line right now. ` +
        `Closest: ${best.bet} ${american(best.price)} (${best.game}), ${money(best.ev_after_tax ?? 0)} after tax on ${money(input.max_wager)}.`,
    );
  } else {
    const best = rows[0];
    parts.push(
      `${clearing} line${clearing === 1 ? "" : "s"} clear a ${pct(boost)} boost at ${book} after ${pct(tax.rate)} tax. ` +
        `Best: ${best.bet} ${american(best.price)} → ${american(best.boosted_price)} (${best.game}), ` +
        `${money(best.ev_after_tax ?? 0)} expected after tax on ${money(input.max_wager)}.`,
    );
  }
  parts.push(freshnessLine(rows, now));
  if (found.unchecked.length) parts.push(`${found.unchecked.length} lines with too few other books to check were left out.`);
  parts.push("Moneylines and game totals only; fair chance is the more cautious of the other books and the model.");
  return {
    summary: parts.filter(Boolean).join(" "),
    data: { book, boost_pct: round(boost * 100, 1), max_wager: input.max_wager, tax_rate_pct: round(tax.rate * 100, 2), rows },
  };
}

export interface BonusInput {
  book: string;
  amount: number;
  min_odds?: number;
  sport?: string;
  date?: string;
  exclude_games_with_open_bets?: boolean;
  limit?: number;
}

/** Games the owner already holds an open ticket on. */
async function openEventIds(): Promise<Set<string>> {
  if (!databaseUrl()) return new Set();
  const [bets, results] = await Promise.all([listBets(HOUSE), getData().results()]);
  const final = new Set(results.map((r) => r.event_id));
  return new Set(activeBets(bets).filter((b) => !final.has(b.event_id) && b.cashout == null).map((b) => b.event_id));
}

export async function findBonusBetSpots(input: BonusInput, now = new Date(), deps: ToolDeps = {}): Promise<ToolAnswer> {
  const [{ games, lines, models, scoreModels }, s] = await Promise.all([deps.market ?? marketData(), deps.settings ?? settings()]);
  const book = pickBook(input.book, lines);
  if (!(input.amount > 0 && input.amount <= 10_000)) throw new ToolInputError("amount must be the bonus bet's face value in dollars.");
  const f = filters(input, now);
  const limit = clampLimit(input.limit);
  const skip = input.exclude_games_with_open_bets === false
    ? new Set<string>()
    : deps.openEvents ?? (await openEventIds().catch(() => new Set<string>()));

  const found = findBoosts(games, lines, models, scoreModels, {
    book,
    boost: 0,
    stake: input.amount,
    favourites: s.favourites,
    maxSpread: DEFAULT_MAX_SPREAD,
    tax: s.tax,
    bonus: true,
  });
  const eligible = found.checked.filter((p) => f.keep(p) && meetsMinOdds(p.price, input.min_odds) && !skip.has(p.eventId));
  const skipped = found.checked.filter((p) => skip.has(p.eventId)).length;
  const rows = boostRows(eligible.slice(0, limit), lines, new Map(games.map((g) => [g.eventId, g])), book, now).map(({ pick: p, ...stamp }) => ({
    game: p.game,
    game_id: p.eventId,
    league: p.league,
    kickoff: p.commenceTime,
    bet: p.label,
    price: p.price,
    fair_prob: round(p.win, 4),
    basis: p.basis,
    value_before_tax: round(p.boosted, 2),
    value_after_tax: round(p.afterTax, 2),
    conversion_pct: round((p.afterTax / input.amount) * 100, 1),
    ...stamp,
  }));

  const parts: string[] = [];
  if (rows.length === 0) {
    parts.push(`No ${book} moneyline or total fits${skipped ? ` (${skipped} lines on games you already have money on were skipped)` : ""}.`);
  } else {
    const best = rows[0];
    parts.push(
      `Best use of a ${money(input.amount)} bonus bet at ${book}: ${best.bet} ${american(best.price)} (${best.game}), ` +
        `worth about ${money(best.value_after_tax ?? 0)} after ${pct(s.tax.rate)} tax (${best.conversion_pct}% of face).`,
    );
    if (skipped) parts.push(`${skipped} lines on games with open bets were skipped.`);
  }
  parts.push(freshnessLine(rows, now));
  return { summary: parts.filter(Boolean).join(" "), data: { book, amount: input.amount, rows } };
}

/* ------------------------------------------------------------------ 4. get_game */

function normaliseTeam(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
}

/** Games a typed team name could mean, soonest first; exact id wins outright. */
export function matchGames(games: Game[], query: string | undefined, gameId: string | undefined, now: Date): Game[] {
  if (gameId) return games.filter((g) => g.eventId === gameId);
  if (!query) return [];
  const q = normaliseTeam(query);
  if (!q) return [];
  const words = q.split(" ");
  const recent = now.getTime() - 6 * 3_600_000;
  return games
    .filter((g) => Date.parse(g.commenceTime) > recent)
    .filter((g) =>
      [g.homeTeam, g.awayTeam].some((team) => {
        const t = normaliseTeam(team ?? "");
        return t.includes(q) || words.every((w) => t.split(" ").includes(w));
      }),
    )
    .sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime));
}

export async function getGame(
  input: { query?: string; game_id?: string; include_offshore?: boolean },
  now = new Date(),
  deps: ToolDeps = {},
): Promise<ToolAnswer> {
  if (!input.query && !input.game_id) throw new ToolInputError("Give a team name (query) or a game_id.");
  const [{ games, lines, models }, s] = await Promise.all([deps.market ?? marketData(), deps.settings ?? settings()]);
  const matches = matchGames(games, input.query, input.game_id, now);
  const game = matches[0];
  if (!game) throw new ToolInputError(`No upcoming game matches "${input.query ?? input.game_id}".`);

  const data = getData();
  const pg = data.backend === "postgres";
  const [history, kalshi] = await Promise.all([
    data.history(game.eventId).catch(() => []),
    pg ? kalshiGames(game.eventId).catch(() => new Map()) : Promise.resolve(new Map()),
  ]);
  const stored = lines.get(game.eventId) ?? [];
  const model = models[game.league] ?? null;
  const quotes = quotesForGame(game, stored, "DraftKings", now);
  const show = (book: string) => input.include_offshore || !isOffshore(book);

  // Every book's line, with its hold where both sides are quoted.
  const books = quotes
    .filter((q) => !q.reference && show(q.book))
    .map((q) => {
      const hold =
        q.price !== null && q.oppositePrice != null
          ? (impliedProbability(q.price) ?? 0) + (impliedProbability(q.oppositePrice) ?? 0) - 1
          : null;
      return {
        book: q.book,
        bet: betName(q.market, q.side, q.line, game),
        market: q.market,
        price: q.price,
        hold_pct: round(hold === null ? null : hold * 100, 2),
        ...asOf(q.observedAt, now),
        ...(q.stale ? { excluded_from_consensus: true } : {}),
      };
    });

  // The board's (DraftKings) view of each side: market and model probability, the gap,
  // the opening line, and what it takes after tax.
  const homeSpread = game.spread?.home?.line ?? null;
  const homeCover = deVig(game.spread?.home?.price ?? null, game.spread?.away?.price ?? null)?.a ?? null;
  const sides: unknown[] = [];
  for (const market of ["spread", "total", "moneyline"] as Market[]) {
    const quotesHere = game[market] ?? {};
    for (const [side, quote] of Object.entries(quotesHere) as [Side, { line: number | null; price: number | null }][]) {
      if (!quote || quote.price === null) continue;
      const other = Object.entries(quotesHere).find(([s2]) => s2 !== side)?.[1] as { price: number | null } | undefined;
      const p = lineProbability(market, side, quote.price, other?.price ?? null, homeSpread, model, homeCover);
      const series = history.filter((h) => h.market === market && h.side === side);
      const opening = series[0];
      const estimates = [p.market, p.model].filter((v): v is number => v !== null);
      const cautious = estimates.length ? Math.min(...estimates) : null;
      const need = cautious !== null ? boostNeeded(cautious, quote.price, s.tax) : null;
      const bonus = cautious !== null ? bonusValue(cautious, quote.price, s.tax) : null;
      sides.push({
        bet: betName(market, side, quote.line, game),
        price: quote.price,
        market_prob: round(p.market, 4),
        model_prob: round(p.model, 4),
        gap_points: round(p.edgePoints, 2),
        opened: opening ? betName(market, side, opening.line, game) + ` ${american(opening.price)}` : null,
        boost_needed_after_tax_pct: need === null ? null : need === 0 ? 0 : Math.ceil(need * 100),
        bonus_bet_value_per_10: bonus === null ? null : round(10 * bonus, 2),
      });
    }
  }

  // Where a book disagrees with the rest of the field, best first.
  const shop = shopAll(quotes, model)
    .filter((r) => !r.stale && r.booksCompared > 0 && show(r.book) && r.expectedRoi !== null)
    .sort((a, b) => (b.expectedRoi ?? 0) - (a.expectedRoi ?? 0))
    .slice(0, 10)
    .map((r) => ({
      book: r.book,
      bet: betName(r.market, r.side, r.line, game),
      price: r.price,
      fair_prob: round(r.fairProbability, 4),
      edge_pct: round((r.expectedRoi ?? 0) * 100, 1),
      books_compared: r.booksCompared,
    }));

  const k = kalshi.get(game.eventId);
  const kalshiHome = k ? kalshiFair(k) : null;
  const dk = asOf(game.lastObserved, now);
  const out = {
    game: `${game.awayTeam} @ ${game.homeTeam}`,
    game_id: game.eventId,
    league: game.league,
    kickoff: game.commenceTime,
    board_as_of: dk.as_of,
    board_stale: dk.stale,
    sides,
    books,
    best_prices: shop,
    kalshi_home_fair: round(kalshiHome, 4),
    tax_rate_pct: round(s.tax.rate * 100, 2),
    model_basis: model
      ? {
          league: game.league,
          fitted_on_games: model.games,
          note: `The spread-to-win model for ${game.league === "nfl" ? "the NFL" : "college"} is fitted on ${model.games} ${game.league.toUpperCase()} games of its own league.`,
        }
      : { league: game.league, note: "No fitted model for this league; model probabilities are absent." },
    other_matches: matches.slice(1, 4).map((g) => ({ game: `${g.awayTeam} @ ${g.homeTeam}`, game_id: g.eventId, kickoff: g.commenceTime })),
  };

  const spread = game.spread?.home?.line;
  const total = game.total?.over?.line;
  const summary = [
    `${out.game}, ${new Date(game.commenceTime).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" })} ET.`,
    spread !== undefined && spread !== null ? `Board: ${game.homeTeam} ${spread > 0 ? "+" : ""}${spread}` + (total ? `, total ${total}.` : ".") : "",
    shop[0] && (shop[0].edge_pct ?? 0) > 0 ? `Best price: ${shop[0].book} ${shop[0].bet} ${american(shop[0].price)}, +${shop[0].edge_pct}%.` : "No book beats the vig on this game.",
    `Board prices ${dk.stale ? "are over 10 min old" : "are fresh"}.`,
    matches.length > 1 ? `${matches.length - 1} other game(s) also match; see other_matches.` : "",
  ].filter(Boolean).join(" ");
  return { summary, data: out };
}

/* ------------------------------------------------------------------ 5/6. ledger */

async function ledger() {
  if (!databaseUrl()) throw new ToolInputError("No database is configured, so there is no ledger to read.");
  const [{ games, lines, models }, s, bets, uses, promos] = await Promise.all([
    marketData(),
    settings(),
    listBets(HOUSE),
    listUses(HOUSE).catch(() => []),
    listPromos(HOUSE).catch(() => [] as Promo[]),
  ]);
  const data = getData();
  const results = await data.results();
  const view = await ledgerView({ games, results, models, lines, bets, tax: s.tax, scoreModels: () => data.scoreModels() });
  const promoById = new Map(promos.map((p) => [p.promo_id, p]));
  const promoOf = new Map<string, Promo>();
  for (const use of uses) {
    const promo = use.bet_id ? promoById.get(use.promo_id) : undefined;
    if (use.bet_id && promo) promoOf.set(use.bet_id, promo);
  }
  // A correction (a cash-out, an edit) is a new row with a new bet_id; the promo was used
  // on the ticket, so it follows the chain to whichever row now stands for it.
  for (let changed = true; changed; ) {
    changed = false;
    for (const bet of bets) {
      const promo = bet.supersedes ? promoOf.get(bet.supersedes) : undefined;
      if (promo && !promoOf.has(bet.bet_id)) {
        promoOf.set(bet.bet_id, promo);
        changed = true;
      }
    }
  }
  return { view, promoOf, tax: s.tax };
}

function ticketLabel(row: GradedRow, legs: Bet[] | undefined): string {
  if (row.parlay_id && legs && legs.length > 1) return `${legs.length}-leg parlay: ${legs.map(legLabel).join(" + ")}`;
  return legLabel(row);
}

export async function getOpenBets(input: { status?: "open" | "settled"; limit?: number }, now = new Date()): Promise<ToolAnswer> {
  const { view, promoOf, tax } = await ledger();
  const limit = clampLimit(input.limit ?? (input.status === "settled" ? 10 : 25));
  const { rows, parlayLegs, open, hedgeOf, liveLabel, staleReason, scores, ifAllWin } = view;

  if (input.status === "settled") {
    const settled = rows
      .filter((r) => r.outcome !== "open")
      .sort((a, b) => Date.parse(b.commence_time ?? b.placed_at) - Date.parse(a.commence_time ?? a.placed_at))
      .slice(0, limit)
      .map((r) => ({
        bet: ticketLabel(r, r.parlay_id ? parlayLegs.get(r.parlay_id) : undefined),
        game: `${r.away_team} @ ${r.home_team}`,
        book: r.book,
        stake: r.stake,
        price: r.parlay_price ?? r.price,
        bonus: !!r.bonus,
        outcome: r.outcome,
        profit: round(r.profit, 2),
      }));
    return { summary: `Last ${settled.length} settled tickets.`, data: { rows: settled } };
  }

  const openRows = rows.filter((r) => r.outcome === "open");
  const out = openRows.slice(0, limit).map((r) => {
    const legs = r.parlay_id ? parlayLegs.get(r.parlay_id) : undefined;
    const hold = open.hold.get(r.bet_id);
    const promo = promoOf.get(r.bet_id);
    const started = !!r.commence_time && Date.parse(r.commence_time) <= now.getTime();
    return {
      ticket_id: r.bet_id,
      bet: ticketLabel(r, legs),
      game: legs && legs.length > 1 ? undefined : `${r.away_team} @ ${r.home_team}`,
      kickoff: r.commence_time,
      book: r.book,
      stake: r.stake,
      price: r.parlay_price ?? r.price,
      bonus_bet: !!r.bonus,
      promo: promo
        ? { type: promo.type, boost_pct: promo.boost_pct, base_price: promo.base_price, title: promo.title }
        : undefined,
      legs:
        legs && legs.length > 1
          ? legs.map((leg) => ({
              leg: legLabel(leg),
              game: `${leg.away_team} @ ${leg.home_team}`,
              price: leg.price,
              status: scores.has(leg.event_id) || leg.prop_result ? "decided" : "pending",
            }))
          : undefined,
      win_prob: hold ? round(hold.chance, 4) : null,
      hold_value: hold ? round(hold.value, 2) : null,
      priced_live: hold?.started ?? false,
      started,
      live: liveLabel(r),
      not_live_because: started ? staleReason(r) : null,
      hedge_group: hedgeOf.get(r.bet_id)?.id ?? null,
    };
  });

  const expected = tax.rate > 0 ? open.expectedAfterTax : open.expected;
  const summary =
    open.tickets === 0
      ? "No open bets."
      : `${open.tickets} open ticket${open.tickets === 1 ? "" : "s"}: ${money(open.atStake)} of your money in play` +
        (open.bonusStake ? ` plus ${money(open.bonusStake)} in bonus bets` : "") +
        `. If all win: ${money(ifAllWin)}. Expected${tax.rate > 0 ? " after tax" : ""}: ${money(expected)}` +
        (open.unpriced ? ` (${open.unpriced} unpriced, counted at break-even)` : "") +
        ". hold_value is what holding is worth in cash at the fair chance: a cash-out offer below it is the book keeping the difference.";
  return {
    summary,
    data: {
      tickets: open.tickets,
      at_stake: round(open.atStake, 2),
      bonus_stake: round(open.bonusStake, 2),
      if_all_win: round(ifAllWin, 2),
      expected: round(expected, 2),
      rows: out,
    },
  };
}

type GroupBy = "book" | "sport" | "promo_type" | "ticket_type";

export async function getRecord(input: { since?: string; group_by?: GroupBy }, now = new Date()): Promise<ToolAnswer> {
  const { view, promoOf } = await ledger();
  const since = parseDate(input.since, now);
  if (since === "bad") throw new ToolInputError("since must be YYYY-MM-DD.");
  const { rows, parlayLegs, totals } = view;
  const settled = rows.filter(
    (r) => r.outcome !== "open" && (!since || easternDate(r.commence_time ?? r.placed_at) >= since),
  );

  const promoType = (r: GradedRow) => promoOf.get(r.bet_id)?.type ?? (r.bonus ? "bonus_bet" : "none");
  const ticketType = (r: GradedRow) => {
    if (!r.parlay_id) return "single";
    const legs = parlayLegs.get(r.parlay_id) ?? [];
    return new Set(legs.map((l) => l.event_id)).size < legs.length ? "same_game_parlay" : "parlay";
  };
  const groupOf = (r: GradedRow): string =>
    input.group_by === "book" ? r.book
      : input.group_by === "sport" ? r.league.toUpperCase()
        : input.group_by === "promo_type" ? promoType(r)
          : input.group_by === "ticket_type" ? ticketType(r)
            : "all";

  // EV at placement: the consensus chance recorded when the bet was logged, on singles
  // that have one. Realized is what those same tickets made, so the two compare.
  const evOf = (r: GradedRow): number | null => {
    if (r.parlay_id || r.market_probability === null || r.price === null) return null;
    const p = r.market_probability;
    // Rows corrected in the app before 2026-10-25 stored a missing probability as 0.
    if (!(p > 0.001 && p < 0.999)) return null;
    const d = r.price > 0 ? 1 + r.price / 100 : 1 + 100 / -r.price;
    return p * r.stake * (d - 1) - (1 - p) * (r.bonus ? 0 : r.stake);
  };

  const groups = new Map<string, GradedRow[]>();
  for (const r of settled) groups.set(groupOf(r), [...(groups.get(groupOf(r)) ?? []), r]);
  const summarise = (list: GradedRow[]) => {
    const counted = list.map((r) => ({ r, result: recordResult(r) }));
    const risked = list.filter((r) => !r.bonus).reduce((a, r) => a + r.stake, 0);
    const profit = list.reduce((a, r) => a + r.profit, 0);
    const withEv = list.map((r) => ({ r, ev: evOf(r) })).filter((x) => x.ev !== null);
    const promo = list.filter((r) => promoType(r) !== "none");
    return {
      tickets: list.length,
      won: counted.filter((c) => c.result === "won").length,
      lost: counted.filter((c) => c.result === "lost").length,
      push: counted.filter((c) => c.result === "push").length,
      cashed_out: list.filter((r) => r.outcome === "cashed").length,
      staked: round(risked, 2),
      profit: round(profit, 2),
      roi_pct: risked > 0 ? round((profit / risked) * 100, 1) : null,
      promo_profit: round(promo.reduce((a, r) => a + r.profit, 0), 2),
      pick_profit: round(list.filter((r) => promoType(r) === "none").reduce((a, r) => a + r.profit, 0), 2),
      ev_at_placement: withEv.length ? round(withEv.reduce((a, x) => a + (x.ev ?? 0), 0), 2) : null,
      realized_on_same: withEv.length ? round(withEv.reduce((a, x) => a + x.r.profit, 0), 2) : null,
      priced_at_placement: withEv.length,
    };
  };

  const all = summarise(settled);
  const byGroup = input.group_by
    ? [...groups.entries()].map(([group, list]) => ({ group, ...summarise(list) })).sort((a, b) => (b.profit ?? 0) - (a.profit ?? 0))
    : undefined;
  const summary =
    `${all.tickets} settled tickets${since ? ` since ${since}` : ""}: ${all.won}-${all.lost}${all.push ? `-${all.push}` : ""}, ` +
    `${money(all.profit ?? 0)} on ${money(all.staked ?? 0)} risked` +
    (all.roi_pct !== null ? ` (${all.roi_pct > 0 ? "+" : ""}${all.roi_pct}%)` : "") +
    `. Promos made ${money(all.promo_profit ?? 0)}, picks ${money(all.pick_profit ?? 0)}.` +
    (all.ev_at_placement !== null
      ? ` On the ${all.priced_at_placement} singles priced when logged, expected ${money(all.ev_at_placement)} vs ${money(all.realized_on_same ?? 0)} realized.`
      : "") +
    ` ${totals.open} still open.`;
  return { summary, data: { ...all, open: totals.open, groups: byGroup } };
}

/** What the write tools (mcp-write.ts) read and write: the owner's ledger and promos. */
export async function loadWriteDeps(): Promise<WriteDeps> {
  if (!databaseUrl()) throw new ToolInputError("No database is configured, so there is no ledger to write.");
  const [{ games, lines, models }, bets, promos, results] = await Promise.all([
    marketData(),
    listBets(HOUSE),
    listPromos(HOUSE).catch(() => [] as Promo[]),
    getData().results(),
  ]);
  return {
    games,
    lines,
    models,
    bets,
    promos,
    finals: new Set(results.map((r) => r.event_id)),
    saveBet: (bet) => saveBet(HOUSE, bet),
    saveParlay: (rows) => saveParlay(HOUSE, rows),
    recordUse: (use) => recordUse(HOUSE, use),
    recordLegResult: (betId, result) => recordLegResult(HOUSE, betId, result, "manual"),
    holdValue: async (ticketId) => {
      const { view } = await ledger();
      const hold = view.open.hold.get(ticketId);
      return hold ? { chance: hold.chance, value: hold.value } : null;
    },
  };
}

/* ------------------------------------------------------------------ 7. get_promos */

export async function getPromos(_input: Record<string, never>, now = new Date()): Promise<ToolAnswer> {
  if (!databaseUrl()) throw new ToolInputError("No database is configured, so there are no promos to read.");
  const promos = (await listPromos(HOUSE))
    .filter((p) => p.status === "available" && Date.parse(p.expires_at) > now.getTime())
    .sort((a, b) => Date.parse(a.expires_at) - Date.parse(b.expires_at));
  const rows = promos.slice(0, 25).map((p) => ({
    promo_id: p.promo_id,
    book: p.book,
    type: p.type,
    title: p.title,
    expires_at: p.expires_at,
    hours_left: round((Date.parse(p.expires_at) - now.getTime()) / 3_600_000, 1),
    boost_pct: p.boost_pct ?? undefined,
    max_stake: p.max_stake ?? undefined,
    bonus_face: p.bonus_face ?? undefined,
    cap_refund: p.cap_refund ?? undefined,
    min_odds: p.min_odds_american ?? undefined,
    min_legs: p.min_legs ?? undefined,
    eligible_markets: p.eligible_markets.length ? p.eligible_markets : undefined,
    excluded: p.excluded.length ? p.excluded : undefined,
    deposit_bonus: p.deposit_bonus ?? undefined,
    rollover: p.rollover_multiple ?? undefined,
    stackable: p.stackable || undefined,
  }));
  const bonus = new Map<string, number>();
  for (const p of promos) if (p.type === "bonus_bet" && p.bonus_face) bonus.set(p.book, (bonus.get(p.book) ?? 0) + p.bonus_face);
  const soon = rows[0];
  const summary =
    rows.length === 0
      ? "No live promos recorded."
      : `${rows.length} live promo${rows.length === 1 ? "" : "s"}. Next to expire: ${soon.book} ${soon.title} in ${soon.hours_left} h.` +
        (bonus.size ? ` Bonus bets on hand: ${[...bonus.entries()].map(([b, v]) => `${b} ${money(v)}`).join(", ")}.` : "");
  return { summary, data: { rows, bonus_balances: Object.fromEntries(bonus) } };
}

/* ------------------------------------------------------------------ 8. get_survivor */

export async function getSurvivor(input: { pool?: string }, now = new Date()): Promise<ToolAnswer> {
  const data = getData();
  if (data.backend !== "postgres") throw new ToolInputError("Survivor needs the database.");
  const [models, games, board, opener, pools, results] = await Promise.all([
    data.marginModels(),
    seasonGames("nfl"),
    data.games(),
    seasonOpener("nfl"),
    getPools(),
    data.results().catch(() => []),
  ]);
  const nflWeek = await currentNflWeek();
  const popularity = await pickPopularity(nflWeek).catch(() => ({}));

  const weeks = openWeeks(games, models.nfl ?? null, opener, now);
  const priced = weeks.filter((w) => w.candidates.length > 0).length;
  const horizonWeeks = weeks.slice(0, priced);
  const crowdTeam = buildPlan(horizonWeeks, priced).greedyPicks[0]?.team ?? null;
  const measured = crowdingFrom(popularity, crowdTeam);
  const finals = new Map(results.map((r) => [r.event_id, r]));
  const openerCandidates = horizonWeeks.find((w) => w.candidates.length > 0)?.candidates ?? [];
  const week0 = weekZero(board, finals, models.nfl ?? null, openerCandidates, now.getTime());
  const plans = buildPoolWinPlans(horizonWeeks, pools, {
    crowding: measured ?? 0,
    popularity,
    crowdingMeasured: measured !== null,
    week0,
  });

  const want = input.pool?.trim().toLowerCase();
  const entries = plans
    .map((plan, i) => ({ plan, i, name: poolLabel(pools[i], i, pools) }))
    .filter((e) => !want || e.name.toLowerCase().includes(want));
  if (entries.length === 0) {
    throw new ToolInputError(`No entry named "${input.pool}". Entries: ${pools.map((p, i) => poolLabel(p, i, pools)).join(", ")}.`);
  }

  const out = entries.map(({ plan, i, name }) => {
    const pool = pools[i];
    const state = fieldState(pool);
    const { odds } = entryOdds({ pool: plan.pool, plan: plan.plan });
    const first = plan.plan.picks[0];
    const pick = first?.pick ?? null;
    const at = (k: number) => (odds.alive.length ? round(odds.alive[Math.min(k, odds.alive.length) - 1], 4) : null);
    return {
      entry: name,
      week: first?.week ?? null,
      pick: pick ? { team: pick.team, opponent: pick.opponent, home: pick.home, win_prob: round(pick.winProbability, 4), kickoff: pick.commenceTime } : null,
      picked_by_pct: round((plan.ranking[0]?.share ?? null) === null ? null : (plan.ranking[0].share as number) * 100, 1),
      contrarian_instead_of: plan.insteadOf ? { team: plan.insteadOf.team, win_prob: round(plan.insteadOf.winProbability, 4) } : null,
      alternatives: plan.ranking.slice(1, 4).map((r) => ({
        team: r.candidate.team,
        win_prob: round(r.candidate.winProbability, 4),
        picked_by_pct: r.share === null ? null : round(r.share * 100, 1),
        pool_win: round(r.poolWin, 4),
      })),
      kept_off: plan.keptOff.length ? plan.keptOff : undefined,
      used: pool.used,
      losses_taken: state.myLosses,
      lives_left: state.livesLeft,
      field_alive: state.entrants,
      survive_this_week: at(1),
      survive_4_weeks: at(4),
      survive_season: round(odds.survival, 4),
      pool_win: round(plan.poolWin, 4),
      likely_end_week: odds.likelyEndWeek,
      plan: plan.plan.picks.slice(0, 6).map((p) => ({ week: p.week, team: p.pick?.team ?? null, win_prob: round(p.pick?.winProbability, 3) })),
    };
  });

  const summary = out
    .map((e) =>
      e.pick
        ? `${e.entry}: week ${e.week} ${e.pick.team} over ${e.pick.opponent} (${pct(e.pick.win_prob ?? 0)} to win` +
          (e.picked_by_pct !== null ? `, ${e.picked_by_pct}% of the field on them` : "") +
          `). ${e.lives_left} spare li${e.lives_left === 1 ? "fe" : "ves"}, ${pct(e.survive_season ?? 0)} to survive the season, ${pct(e.pool_win ?? 0)} to take the pool.`
        : `${e.entry}: no pick available.`,
    )
    .join(" ");
  return { summary: `${summary} Picks lock Sunday 11am ET.`, data: { entries: out, crowding_measured: measured !== null } };
}

/** Sides, for the zod schemas in the route. */
export const MARKETS = ["moneyline", "spread", "total"] as const;
export { sideName };
