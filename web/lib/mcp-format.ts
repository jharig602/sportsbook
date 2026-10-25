/**
 * Small pure helpers for the Claude connector's answers (mcp-tools.ts): how old a price
 * is, which day a game is on, which book a typed name means, and how a typed percentage
 * is read. Kept apart so each rule is tested without a database.
 */
import type { BookLineRow } from "./book-lines";
import { decimalOdds } from "./settle";
import type { Game, League, Market, Side } from "./types";

/** Older than this and a price is flagged: lines move several points in minutes near kickoff. */
export const STALE_MINUTES = 10;
export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 25;

export function asOf(iso: string | null | undefined, now: Date): { as_of: string | null; stale: boolean } {
  if (!iso) return { as_of: null, stale: true };
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return { as_of: null, stale: true };
  return { as_of: new Date(at).toISOString(), stale: now.getTime() - at > STALE_MINUTES * 60_000 };
}

/** A kickoff's date in Eastern time, YYYY-MM-DD: the day the slate is printed under. */
export function easternDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/** Today's date in Eastern time. */
export function easternToday(now: Date): string {
  return easternDate(now.toISOString());
}

/** "today", "tomorrow" or YYYY-MM-DD, as an Eastern date; null when it is not one of those. */
export function parseDate(input: string | undefined, now: Date): string | null | "bad" {
  if (!input) return null;
  const text = input.trim().toLowerCase();
  if (text === "today") return easternToday(now);
  if (text === "tomorrow") return easternToday(new Date(now.getTime() + 86_400_000));
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "bad";
}

/** NFL or college football; null when not given, "bad" when it is neither. */
export function parseLeague(sport: string | undefined): League | null | "bad" {
  if (!sport) return null;
  const s = sport.trim().toLowerCase();
  if (s === "nfl") return "nfl";
  if (["ncaaf", "cfb", "college", "college football", "ncaa"].includes(s)) return "ncaaf";
  return "bad";
}

function key(book: string): string {
  return book.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The book a typed name means: exact once normalised, else the one it is a prefix of. */
export function resolveBook(input: string, books: string[]): string | null {
  const want = key(input);
  if (!want) return null;
  const exact = books.find((b) => key(b) === want);
  if (exact) return exact;
  const partial = books.filter((b) => key(b).startsWith(want) || want.startsWith(key(b)));
  return partial.length === 1 ? partial[0] : null;
}

/**
 * A boost or tax rate typed either way: 30 means 30%, and so does 0.3. Values of 1 or
 * less are read as a fraction (1 = 100%), anything larger as a percentage. Null when it
 * is not a usable number.
 */
export function fraction(value: number | undefined | null): number | null {
  if (value === undefined || value === null || !Number.isFinite(value) || value < 0) return null;
  return value <= 1 ? value : value / 100;
}

/** Whether `price` meets a token's minimum odds: at least as long, in decimal terms. */
export function meetsMinOdds(price: number | null, minOdds: number | undefined): boolean {
  if (minOdds === undefined || minOdds === null) return true;
  const have = decimalOdds(price);
  const need = decimalOdds(minOdds);
  if (have === null || need === null) return false;
  return have >= need - 1e-9;
}

export function round(value: number | null | undefined, places: number): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) return null;
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

export function money(value: number): string {
  const sign = value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

export function american(price: number | null | undefined): string {
  if (price === null || price === undefined) return "n/a";
  return price > 0 ? `+${price}` : String(price);
}

/** "Detroit Lions", "Over", or the raw side when the team is unknown. */
export function sideName(side: Side, game: { homeTeam: string | null; awayTeam: string | null }): string {
  if (side === "home") return game.homeTeam ?? "Home";
  if (side === "away") return game.awayTeam ?? "Away";
  return side === "over" ? "Over" : side === "under" ? "Under" : side;
}

/** "Detroit Lions -2.5", "Over 47.5", "Detroit Lions ML". */
export function betName(
  market: Market,
  side: Side,
  line: number | null,
  game: { homeTeam: string | null; awayTeam: string | null },
): string {
  const who = sideName(side, game);
  if (market === "moneyline") return `${who} ML`;
  if (line === null) return who;
  if (market === "spread") return `${who} ${line > 0 ? "+" : ""}${line}`;
  return `${who} ${line}`;
}

/**
 * When a quote was seen. DraftKings comes from the board snapshot (book-lines.ts folds it
 * in), so its time is the game's; every other book's is its own stored row.
 */
export function quoteSeenAt(
  game: Pick<Game, "lastObserved">,
  stored: BookLineRow[],
  book: string,
  market: Market,
  side: Side,
): string | null {
  if (book === "DraftKings") return game.lastObserved ?? null;
  const row = stored.find((r) => r.book === book && r.market === market && r.side === side);
  return row?.observed_at ?? null;
}

/** "3 min ago", "2.1 h ago": how old the newest price in an answer is. */
export function ageText(iso: string | null, now: Date): string {
  if (!iso) return "unknown age";
  const minutes = (now.getTime() - Date.parse(iso)) / 60_000;
  if (minutes < 1) return "just now";
  if (minutes < 90) return `${Math.round(minutes)} min ago`;
  return `${(minutes / 60).toFixed(1)} h ago`;
}

/** Of the rows' as_of stamps: the newest, and how many are stale. */
export function freshnessLine(rows: Array<{ as_of: string | null; stale: boolean }>, now: Date): string {
  if (rows.length === 0) return "";
  const stamps = rows.map((r) => r.as_of).filter((v): v is string => v !== null).sort();
  const newest = stamps[stamps.length - 1] ?? null;
  const stale = rows.filter((r) => r.stale).length;
  return stale === 0
    ? `All prices under ${STALE_MINUTES} min old.`
    : `${stale} of ${rows.length} prices are over ${STALE_MINUTES} min old (newest ${ageText(newest, now)}); confirm at the book before betting.`;
}

export function clampLimit(limit: number | undefined): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}
