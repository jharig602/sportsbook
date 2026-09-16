/**
 * Where a profit boost is worth the most, at one book, right now.
 *
 * Ranks every upcoming moneyline the book offers -- singles, and two-leg parlays across
 * different games -- by the boosted expected value of one maximum-size bet.
 *
 * The probability is the LOWER of two independent estimates: the other books' de-vigged
 * consensus, and the spread model. Proportional de-vig flatters underdogs (books load
 * their margin onto the longshot), and a boost multiplies whatever flattery goes in, so
 * the conservative reading is the honest one. A side with neither estimate is skipped
 * rather than priced off its own number, which would be circular.
 *
 * Everything the pricing touches is the app's own code -- quotesForGame, deVig,
 * winProbabilityFromSpread -- so this cannot disagree with the Shop page about a quote.
 *
 * Read-only. Prints team names and prices, which are public; nothing about the ledger.
 *
 * Env: DATABASE_URL (required), BOOST_BOOK (default FanDuel), BOOST_STAKE (default 25),
 * BOOST_SIZE (default 1 = 100%).
 */
import { DEFAULT_MAX_SPREAD, isBlowout } from "../lib/blowout";
import { quotesForGame, type BookLineRow } from "../lib/book-lines";
import { buildBoard } from "../lib/data";
import { formatKickoff } from "../lib/format";
import { deVig, winProbabilityFromSpread, type MarginModel } from "../lib/probability";
import { boostedEv, boostedPrice, parlayPrice } from "../lib/profit-boost";
import type { Game, Side } from "../lib/types";

/* eslint-disable @typescript-eslint/no-explicit-any */

const url = process.env.DATABASE_URL;
const BOOK = (process.env.BOOST_BOOK || "FanDuel").trim();
const STAKE = Number(process.env.BOOST_STAKE || 25);
const BOOST = Number(process.env.BOOST_SIZE || 1);
// How far ahead to look. Far enough for the weekend's slate, short enough that the
// prices are ones the book is actually still quoting.
const HORIZON_DAYS = 8;

if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(2);
}
if (!/^[A-Za-z0-9 .'-]{2,40}$/.test(BOOK) || !(STAKE > 0 && STAKE <= 1000) || !(BOOST > 0 && BOOST <= 5)) {
  console.error("Refused: BOOST_BOOK, BOOST_STAKE or BOOST_SIZE is out of range.");
  process.exit(2);
}

let db: any = null;
async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}

function normalise(raw: Record<string, unknown>): Record<string, unknown> {
  const row: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value instanceof Date) row[key] = value.toISOString();
    else if (typeof value === "string" && (key === "price" || key === "line")) row[key] = Number(value);
    else row[key] = value;
  }
  return row;
}

/** Same as the board's LATEST_QUOTES. */
const BOARD = `
WITH ranked AS (
    SELECT event_id, league, commence_time, home_team, away_team,
           home_team_id, away_team_id, market, side, line, price, observed_at,
           row_number() OVER (PARTITION BY event_id, market, side ORDER BY observed_at DESC) AS rn
      FROM odds_snapshots
     WHERE observation_kind = 'pregame_observation'
)
SELECT event_id, league, commence_time, home_team, away_team,
       home_team_id, away_team_id, market, side, line, price, observed_at
  FROM ranked WHERE rn = 1`;

/** Same as the Shop's LATEST_ALL: every book's latest quote from the last two days. */
const LINES = `
SELECT DISTINCT ON (b.event_id, b.book, b.market, b.side)
       b.quote_id, b.observed_at, b.league, b.event_id, b.book, b.market, b.side,
       b.line, b.price, b.source, b.note
  FROM book_lines b
 WHERE b.observed_at > NOW() - INTERVAL '48 hours'
 ORDER BY b.event_id, b.book, b.market, b.side, b.observed_at DESC`;

const MODELS = `SELECT league, games, mean, sd, lo, hi, pmf_json, buckets_json FROM margin_models`;

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface Single {
  game: Game;
  side: Side;
  team: string;
  opponent: string;
  price: number;
  market: number | null;
  books: number;
  model: number | null;
  p: number;
  basis: string;
  plain: number;
  boosted: number;
}

const signed = (n: number) => (n > 0 ? `+${n}` : String(n));
const pct = (n: number | null) => (n === null ? "  -  " : `${(n * 100).toFixed(1)}%`);
const money = (n: number) => `${n >= 0 ? "+" : "-"}$${Math.abs(n).toFixed(2)}`;

async function main(): Promise<number> {
  const { Pool } = await import("pg");
  db = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });

  const models: Record<string, MarginModel> = {};
  for (const row of await query<any>(MODELS)) {
    models[row.league] = {
      league: row.league, games: Number(row.games), mean: Number(row.mean), sd: Number(row.sd),
      lo: Number(row.lo), hi: Number(row.hi), pmf: JSON.parse(row.pmf_json),
      buckets: row.buckets_json ? JSON.parse(row.buckets_json) : null,
    } as MarginModel;
  }

  const games = buildBoard((await query<any>(BOARD)).map(normalise) as any);
  const stored = new Map<string, BookLineRow[]>();
  for (const raw of await query<any>(LINES)) {
    const row = normalise(raw) as unknown as BookLineRow;
    stored.set(row.event_id, [...(stored.get(row.event_id) ?? []), row]);
  }

  const now = new Date();
  const until = now.getTime() + HORIZON_DAYS * 86400000;
  const singles: Single[] = [];
  let gamesAtBook = 0;
  let skippedNoEstimate = 0;

  for (const game of games) {
    const kickoff = new Date(game.commenceTime).getTime();
    if (kickoff <= now.getTime() || kickoff > until) continue;
    const homeSpread = game.spread?.home?.line ?? null;
    if (isBlowout(homeSpread, DEFAULT_MAX_SPREAD)) continue;

    const quotes = quotesForGame(game, stored.get(game.eventId) ?? [], "DraftKings", now)
      .filter((q) => q.market === "moneyline" && !q.stale && q.price !== null);
    const mine = quotes.filter((q) => q.book === BOOK);
    if (mine.length === 0) continue;
    gamesAtBook += 1;

    for (const quote of mine) {
      const side = quote.side;
      const fairs = quotes
        .filter((q) => q.book !== BOOK && q.side === side && q.oppositePrice !== null)
        .map((q) => deVig(q.price, q.oppositePrice)?.a)
        .filter((v): v is number => typeof v === "number");
      const market = median(fairs);
      const model = models[game.league] && homeSpread !== null
        ? winProbabilityFromSpread(models[game.league], homeSpread, side)
        : null;

      // A single other book is one opinion, not a market.
      const usableMarket = fairs.length >= 2 ? market : null;
      const estimates = [usableMarket, model].filter((v): v is number => v !== null);
      if (estimates.length === 0) {
        skippedNoEstimate += 1;
        continue;
      }
      const p = Math.min(...estimates);
      const basis =
        usableMarket !== null && model !== null
          ? p === model ? "model (lower)" : "market (lower)"
          : usableMarket !== null ? "market only" : "model only";

      singles.push({
        game, side,
        team: (side === "home" ? game.homeTeam : game.awayTeam) ?? side,
        opponent: (side === "home" ? game.awayTeam : game.homeTeam) ?? "?",
        price: quote.price as number,
        market, books: fairs.length, model, p, basis,
        plain: STAKE * boostedEv(p, quote.price as number, 0),
        boosted: STAKE * boostedEv(p, quote.price as number, BOOST),
      });
    }
  }

  singles.sort((a, b) => b.boosted - a.boosted);

  console.log(`\n${BOOK}: ${gamesAtBook} upcoming games priced within ${HORIZON_DAYS} days; ` +
    `${singles.length} sides with an independent estimate, ${skippedNoEstimate} without (skipped).`);
  console.log(`Value of one $${STAKE} bet with a ${Math.round(BOOST * 100)}% profit boost. ` +
    `p = lower of market consensus and spread model.\n`);

  console.log("SINGLES");
  for (const s of singles.slice(0, 15)) {
    console.log(
      `${s.game.league.toUpperCase().padEnd(5)} ${formatKickoff(s.game.commenceTime).padEnd(16)} ` +
      `${`${s.team} ML`.padEnd(30)} vs ${s.opponent.padEnd(28)} ` +
      `${signed(s.price).padStart(6)} -> log ${signed(boostedPrice(s.price, BOOST)).padStart(6)}  ` +
      `p ${pct(s.p)} [mkt ${pct(s.market)} x${s.books}, model ${pct(s.model)}; ${s.basis}]  ` +
      `unboosted ${money(s.plain)}  BOOSTED ${money(s.boosted)}`,
    );
  }

  // Two legs on different games, treated as independent. Drawn from the best singles
  // only, because a leg that is poor alone does not become good by being paired.
  const pool = singles.slice(0, 20);
  const pairs: Array<{ a: Single; b: Single; price: number; p: number; boosted: number }> = [];
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      const a = pool[i];
      const b = pool[j];
      if (a.game.eventId === b.game.eventId) continue;
      const price = parlayPrice([a.price, b.price]);
      if (price > 200000) continue;
      const p = a.p * b.p;
      pairs.push({ a, b, price, p, boosted: STAKE * boostedEv(p, price, BOOST) });
    }
  }
  pairs.sort((x, y) => y.boosted - x.boosted);
  console.log("\nTWO-LEG PARLAYS (different games)");
  for (const pair of pairs.slice(0, 6)) {
    console.log(
      `${`${pair.a.team} ML + ${pair.b.team} ML`.padEnd(60)} ` +
      `${signed(pair.price).padStart(6)} -> log ${signed(boostedPrice(pair.price, BOOST)).padStart(6)}  ` +
      `p ${pct(pair.p)}  BOOSTED ${money(pair.boosted)}`,
    );
  }
  console.log("");
  return singles.length > 0 ? 0 : 3;
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  })
  .then(async (code) => {
    if (db) await db.end().catch(() => {});
    process.exit(code);
  });
