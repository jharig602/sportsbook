/**
 * Getting from "that one" to a logged bet without retyping it.
 *
 * Every number the form needs is already on the screen you were looking at when you
 * decided — the game, the market, the side, the book's line and price, and for the
 * promotion the stake and whether it is a bonus. Making you find the game again in a
 * list and copy the numbers across by hand is where the ledger picks up mistakes: the
 * wrong side, a line from a different book, a bonus bet recorded as cash.
 *
 * So a link carries them, and the form opens already filled in. The numbers remain a
 * starting point and stay editable, for the same reason the form always said so: what
 * matters is the price you actually got, and the board can be a minute stale.
 */
import type { Game, Market, Side } from "./types";

export interface BetPrefill {
  eventId: string;
  market?: Market;
  side?: Side;
  line?: number | null;
  price?: number | null;
  book?: string;
  stake?: number;
  bonus?: boolean;
}

const MARKETS = new Set<Market>(["spread", "total", "moneyline"]);

/** The sides a market can actually be bet on. Crossing them settles the wrong question. */
function sideFits(market: Market, side: Side): boolean {
  return market === "total" ? side === "over" || side === "under" : side === "home" || side === "away";
}

export function betHref(prefill: BetPrefill): string {
  const params = new URLSearchParams();
  params.set("event", prefill.eventId);
  if (prefill.market) params.set("market", prefill.market);
  if (prefill.side) params.set("side", prefill.side);
  if (prefill.line !== undefined && prefill.line !== null && prefill.market !== "moneyline") {
    params.set("line", String(prefill.line));
  }
  if (prefill.price !== undefined && prefill.price !== null) params.set("price", String(prefill.price));
  if (prefill.book) params.set("book", prefill.book);
  if (prefill.stake !== undefined) params.set("stake", String(prefill.stake));
  if (prefill.bonus) params.set("bonus", "1");
  // The anchor lands on the form rather than the top of a long ledger.
  return `/bets?${params.toString()}#log`;
}

type Params = Record<string, string | string[] | undefined>;

function one(params: Params, key: string): string | undefined {
  const value = params[key];
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Read a prefill back out of the URL, keeping only what is well-formed.
 *
 * A URL is typed input from anywhere, so each field is checked on its own and dropped
 * if it does not fit — a bad price should not throw away a good game, and a side that
 * does not belong to the market must not survive to be logged. Nothing here is trusted
 * further than the form: the API validates every field again on save.
 */
export function parseBetPrefill(params: Params): BetPrefill | null {
  const eventId = one(params, "event");
  if (!eventId || !/^[A-Za-z0-9_.:-]{1,64}$/.test(eventId)) return null;
  const out: BetPrefill = { eventId };

  const market = one(params, "market") as Market | undefined;
  if (market && MARKETS.has(market)) out.market = market;

  const side = one(params, "side") as Side | undefined;
  if (side && out.market && sideFits(out.market, side)) out.side = side;

  const line = Number(one(params, "line"));
  if (one(params, "line") !== undefined && Number.isFinite(line) && Math.abs(line) <= 200 && out.market !== "moneyline") {
    out.line = line;
  }

  const price = Number(one(params, "price"));
  if (Number.isFinite(price) && Math.abs(price) >= 100 && Math.abs(price) <= 100000) out.price = price;

  const book = one(params, "book");
  if (book && book.trim().length > 0 && book.length <= 40) out.book = book.trim();

  const stake = Number(one(params, "stake"));
  if (Number.isFinite(stake) && stake > 0 && stake <= 100000) out.stake = stake;

  if (one(params, "bonus") === "1") out.bonus = true;
  return out;
}

/**
 * Games whose team names contain every word typed, in any order.
 *
 * Words rather than one substring so "cle jax" finds Cleveland at Jacksonville and
 * "colgate" finds Colgate however ESPN spells the mascot. Case and punctuation are
 * ignored because nobody types "Hawai'i" on a phone.
 */
export function searchGames<T extends Pick<Game, "homeTeam" | "awayTeam">>(games: T[], query: string): T[] {
  const words = normalise(query).split(" ").filter(Boolean);
  if (words.length === 0) return games;
  return games.filter((game) => {
    const haystack = normalise(`${game.awayTeam ?? ""} ${game.homeTeam ?? ""}`);
    return words.every((word) => haystack.includes(word));
  });
}

function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    // Apostrophes join rather than split: "Hawai'i" must read as "hawaii", which is what
    // anyone types. Turning it into a space made "hawai i" and matched nothing.
    .replace(/['’ʻ`]/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
