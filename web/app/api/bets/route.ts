import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { saveBet } from "@/lib/bets-db";
import type { Bet } from "@/lib/settle";

export const dynamic = "force-dynamic";

const MARKETS = new Set(["spread", "total", "moneyline"]);
const SIDES = new Set(["home", "away", "over", "under"]);

/**
 * Record a wager.
 *
 * Validation is strict and the errors say what is wrong, because a bet silently
 * rejected or silently mangled is worse than one refused: the whole point of the
 * ledger is that what it holds matches what was actually placed.
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
  const price = Number(body.price);
  const stake = Number(body.stake);
  const line = body.line === null || body.line === "" ? null : Number(body.line);

  if (!body.event_id) problems.push("Pick a game.");
  if (!MARKETS.has(market)) problems.push("Market must be spread, total or moneyline.");
  if (!SIDES.has(side)) problems.push("Pick a side.");
  if (!Number.isFinite(price) || Math.abs(price) < 100) {
    problems.push("Price must be American odds of at least +100 or -100.");
  }
  if (!Number.isFinite(stake) || stake <= 0) problems.push("Stake must be more than zero.");
  if (market !== "moneyline" && (line === null || !Number.isFinite(line))) {
    problems.push("A spread or total needs a line.");
  }
  // A spread's side must be a team and a total's must be over/under; crossing them
  // would settle against the wrong question entirely.
  if (market === "total" && side !== "over" && side !== "under") {
    problems.push("A total is bet over or under.");
  }
  if (market !== "total" && side !== "home" && side !== "away") {
    problems.push("A spread or moneyline is bet on home or away.");
  }

  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
  }

  const bet: Bet = {
    bet_id: randomUUID(),
    placed_at: new Date().toISOString(),
    league: String(body.league ?? "ncaaf"),
    event_id: String(body.event_id),
    home_team: (body.home_team as string) ?? null,
    away_team: (body.away_team as string) ?? null,
    commence_time: (body.commence_time as string) ?? null,
    market: market as Bet["market"],
    side: side as Bet["side"],
    line: market === "moneyline" ? null : line,
    price,
    stake,
    book: String(body.book ?? "BetMGM"),
    model_probability: Number.isFinite(Number(body.model_probability))
      ? Number(body.model_probability)
      : null,
    market_probability: Number.isFinite(Number(body.market_probability))
      ? Number(body.market_probability)
      : null,
    rule_version_id: (body.rule_version_id as string) ?? null,
    note: (body.note as string) ?? null,
  };

  try {
    await saveBet(bet);
    return NextResponse.json({ ok: true, bet_id: bet.bet_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: `Could not save: ${message}` }, { status: 500 });
  }
}
