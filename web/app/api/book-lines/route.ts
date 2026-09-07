import { NextResponse } from "next/server";

import { MANUAL_SOURCE, saveBookLine } from "@/lib/book-lines";
import type { Market, Side } from "@/lib/types";

export const dynamic = "force-dynamic";

const MARKETS = new Set(["spread", "total", "moneyline"]);
const SIDES = new Set(["home", "away", "over", "under"]);

/**
 * Record what another book is showing.
 *
 * Validated as strictly as a wager, for the same reason: this number becomes the
 * reference every comparison on the game is measured against. A mistyped line does not
 * fail loudly — it manufactures an edge that is not there, which is the one failure
 * mode this app is built to avoid.
 *
 * The feed's own book is refused by name. Accepting a hand-typed "DraftKings" row
 * would shadow the snapshot and leave the board comparing DraftKings against
 * DraftKings, whose gap is zero by construction.
 */
export async function POST(request: Request) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }

  const problems: string[] = [];
  const market = String(body.market ?? "");
  const side = String(body.side ?? "");
  const book = String(body.book ?? "").trim();
  const hasPrice = body.price !== null && body.price !== "" && body.price !== undefined;
  const price = hasPrice ? Number(body.price) : null;
  const line = body.line === null || body.line === "" || body.line === undefined
    ? null
    : Number(body.line);

  if (!body.event_id) problems.push("Pick a game.");
  if (!book) problems.push("Name the book this line came from.");
  if (book.toLowerCase() === "draftkings") {
    problems.push(
      "DraftKings already comes from the feed; entering it by hand would compare the book against itself.",
    );
  }
  if (book.length > 40) problems.push("Book name is too long.");
  if (!MARKETS.has(market)) problems.push("Market must be spread, total or moneyline.");
  if (!SIDES.has(side)) problems.push("Pick a side.");
  if (price !== null && (!Number.isFinite(price) || Math.abs(price) < 100)) {
    problems.push("Price must be American odds of at least +100 or -100.");
  }
  if (market !== "moneyline" && (line === null || !Number.isFinite(line))) {
    problems.push("A spread or total needs a line.");
  }
  if (market === "moneyline" && price === null) {
    problems.push("A moneyline is only a price, so the price is required.");
  }
  if (market === "total") {
    if (side !== "over" && side !== "under") problems.push("A total is quoted over or under.");
    if (line !== null && line <= 0) problems.push("A total is a positive number of points.");
  }
  if (market !== "total" && side !== "home" && side !== "away") {
    problems.push("A spread or moneyline is quoted on home or away.");
  }

  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
  }

  try {
    const quoteId = await saveBookLine({
      league: String(body.league ?? "ncaaf"),
      event_id: String(body.event_id),
      book,
      market: market as Market,
      side: side as Side,
      line: market === "moneyline" ? null : line,
      price,
      source: MANUAL_SOURCE,
      note: (body.note as string) || null,
    });
    return NextResponse.json({ ok: true, quote_id: quoteId }, { status: 201 });
  } catch (error) {
    console.error("could not save book line:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Could not save." },
      { status: 500 },
    );
  }
}
