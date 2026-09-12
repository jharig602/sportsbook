import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { listBets, saveBet, saveParlay } from "@/lib/bets-db";
import { currentSession } from "@/lib/session";
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
  // Whose ledger this lands in, resolved before anything is validated. Middleware has
  // already decided the caller may write SOMEWHERE; this decides where, and it is the
  // only thing standing between two people's wagers ending up in one tally -- a merged
  // record would produce a win rate that describes neither of them and looks exactly
  // like one that describes you.
  const { ownerId } = await currentSession();
  if (!ownerId) {
    return NextResponse.json(
      { error: "No ledger is attached to this session." },
      { status: 401 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }

  // A parlay arrives as its legs plus one combined price, and is written atomically.
  // Validated leg by leg with the same rules a single bet gets, because each leg is
  // graded on its own and a leg with a bad line settles wrongly just as loudly.
  if (Array.isArray(body.legs)) {
    const legs = body.legs as Array<Record<string, unknown>>;
    const stake = Number(body.stake);
    const parlayPrice = Number(body.parlay_price);
    const problems: string[] = [];
    if (legs.length < 2) problems.push("A parlay needs at least two legs.");
    if (!Number.isFinite(stake) || stake <= 0) problems.push("Stake must be more than zero.");
    if (!Number.isFinite(parlayPrice) || Math.abs(parlayPrice) < 100) {
      problems.push("The combined price must be American odds of at least +100 or -100.");
    }
    const events = new Set(legs.map((l) => String(l.event_id ?? "")));
    if (events.size !== legs.length) {
      // Two legs on one game are correlated, and the book prices that ticket with its
      // own adjustment. Grading it by multiplying would be wrong in a way nothing here
      // could detect afterwards.
      problems.push("Two legs are on the same game; that is a same-game parlay and is priced differently.");
    }
    for (const [i, leg] of legs.entries()) {
      const market = String(leg.market ?? "");
      const side = String(leg.side ?? "");
      const price = Number(leg.price);
      const line = leg.line === null || leg.line === "" ? null : Number(leg.line);
      if (!leg.event_id) problems.push(`Leg ${i + 1}: pick a game.`);
      if (!MARKETS.has(market)) problems.push(`Leg ${i + 1}: bad market.`);
      if (!SIDES.has(side)) problems.push(`Leg ${i + 1}: bad side.`);
      if (!Number.isFinite(price) || Math.abs(price) < 100) problems.push(`Leg ${i + 1}: bad price.`);
      if (market !== "moneyline" && (line === null || !Number.isFinite(line))) {
        problems.push(`Leg ${i + 1}: a spread or total needs a line.`);
      }
    }
    if (problems.length > 0) {
      return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
    }

    const parlayId = randomUUID();
    const placedAt = new Date().toISOString();
    const rows: Bet[] = legs.map((leg) => ({
      bet_id: randomUUID(),
      placed_at: placedAt,
      league: String(leg.league ?? "ncaaf"),
      event_id: String(leg.event_id),
      home_team: (leg.home_team as string) ?? null,
      away_team: (leg.away_team as string) ?? null,
      commence_time: (leg.commence_time as string) ?? null,
      market: String(leg.market) as Bet["market"],
      side: String(leg.side) as Bet["side"],
      line: leg.market === "moneyline" ? null : Number(leg.line),
      price: Number(leg.price),
      // Repeated on every leg; the tally counts it once per ticket.
      stake,
      book: String(body.book ?? "BetMGM"),
      model_probability: null,
      market_probability: null,
      rule_version_id: null,
      note: (body.note as string) ?? null,
      bonus: body.bonus === true,
      supersedes: null,
      parlay_id: parlayId,
      parlay_price: parlayPrice,
    }));

    try {
      await saveParlay(ownerId, rows);
      return NextResponse.json({ ok: true, parlay_id: parlayId, legs: rows.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return NextResponse.json({ error: `Could not save: ${message}` }, { status: 500 });
    }
  }

  const voiding = body.voided === true;

  /**
   * Cash-out: the ticket was sold back before the whistle.
   *
   * Arrives as a correction, which is exactly what it is -- the original row records
   * what was struck and stays; this one records that it ended early and at what price.
   * A cash-out below the stake is legitimate (cutting a loss), so the only bar is that
   * it is a real, non-negative number.
   */
  let cashout: number | null = null;
  const cashoutProblems: string[] = [];
  if (body.cashout !== undefined && body.cashout !== null && body.cashout !== "") {
    const amount = Number(body.cashout);
    if (!Number.isFinite(amount) || amount < 0) {
      cashoutProblems.push("A cash-out must be a number of dollars, and not negative.");
    } else {
      cashout = amount;
    }
  }

  const problems: string[] = [...cashoutProblems];
  const market = String(body.market ?? "");
  const side = String(body.side ?? "");
  const price = Number(body.price);
  const stake = Number(body.stake);
  const line = body.line === null || body.line === "" ? null : Number(body.line);

  // A void names the row it removes and copies the rest for the record. It is not a
  // bet, so it is not held to a bet's rules -- but it must still name something real,
  // which the supersedes check below enforces.
  if (voiding && !body.supersedes) problems.push("A void must name the bet it removes.");
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

  // A correction must name a bet that exists IN THIS LEDGER. Accepting an unknown id
  // would write a row that supersedes nothing, leaving BOTH versions standing and the
  // record counting the wager twice -- the opposite of what was asked for, and silent.
  //
  // Scoping the lookup to the caller's own rows is also what stops a correction being a
  // way to reach across ledgers: a void is a write that removes somebody's bet, and
  // without this it would remove anybody's.
  let corrects: string | null = null;
  if (body.supersedes !== undefined && body.supersedes !== null && body.supersedes !== "") {
    corrects = String(body.supersedes);
    try {
      const known = await listBets(ownerId);
      const target = known.find((b) => b.bet_id === corrects);
      if (!target) problems.push("The bet being corrected was not found.");
      else if (target.supersedes === corrects) problems.push("A bet cannot correct itself.");
    } catch {
      problems.push("Could not check the bet being corrected.");
    }
  }

  // When it was actually struck, defaulting to now.
  //
  // Worth accepting rather than always stamping the clock, because a bet logged the
  // next morning is still yesterday's bet -- and the promotion's day counter is built
  // from these dates. Stamping "now" on a backfilled row would quietly merge two
  // qualifying days into one and report the promotion as further behind than it is.
  //
  // Bounded in both directions: the future is not a time a bet was struck, and anything
  // older than the season is a typo rather than a memory.
  let placedAt = new Date().toISOString();
  if (body.placed_at !== undefined && body.placed_at !== null && body.placed_at !== "") {
    const when = new Date(String(body.placed_at));
    const age = Date.now() - when.getTime();
    if (Number.isNaN(when.getTime())) problems.push("placed_at is not a date.");
    else if (age < -60 * 60 * 1000) problems.push("placed_at is in the future.");
    else if (age > 180 * 24 * 60 * 60 * 1000) problems.push("placed_at is more than 180 days ago.");
    else placedAt = when.toISOString();
  }

  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
  }

  const bet: Bet = {
    bet_id: randomUUID(),
    placed_at: placedAt,
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
    // A promotional bet: the stake is the book's, so losing it costs nothing.
    bonus: body.bonus === true,
    supersedes: corrects,
    voided: voiding,
    cashout,
  };

  try {
    await saveBet(ownerId, bet);
    return NextResponse.json({ ok: true, bet_id: bet.bet_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: `Could not save: ${message}` }, { status: 500 });
  }
}
