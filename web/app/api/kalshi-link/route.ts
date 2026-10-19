import { NextResponse } from "next/server";

import { linkEvent } from "@/lib/kalshi-db";

export const dynamic = "force-dynamic";

const TICKER = /^KX[A-Z0-9]+-\d{2}[A-Z]{3}\d{2}[A-Z0-9]+$/;

/**
 * Link a Kalshi event to a board game by hand (Settings), for the games the alias table
 * and the name matcher refused. Owner-only by the middleware's allowlist. The collector
 * applies it on its next run and still refuses a link whose sides it cannot orient.
 */
export async function POST(request: Request) {
  let body: { eventTicker?: unknown; eventId?: unknown; league?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }
  const eventTicker = String(body.eventTicker ?? "");
  const eventId = String(body.eventId ?? "");
  const league = body.league === "nfl" || body.league === "ncaaf" ? body.league : null;
  if (!TICKER.test(eventTicker) || !/^\d+$/.test(eventId) || !league) {
    return NextResponse.json({ error: "Expected a Kalshi event ticker, a game id and a league." }, { status: 400 });
  }
  try {
    await linkEvent(eventTicker, eventId, league);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown error" }, { status: 500 });
  }
}
