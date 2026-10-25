import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { parseParlay, parseSingle } from "@/lib/bet-input";
import { listBets, saveBet, saveParlay } from "@/lib/bets-db";
import { currentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Record a wager.
 *
 * The rules a bet must meet live in `bet-input.ts`, shared with the Claude connector's
 * `log_bet`, so a ticket refused here cannot arrive another way.
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
  if (Array.isArray(body.legs)) {
    const { problems, rows } = parseParlay(body, randomUUID);
    if (problems.length > 0) {
      return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
    }
    try {
      await saveParlay(ownerId, rows);
      return NextResponse.json({ ok: true, parlay_id: rows[0].parlay_id, legs: rows.length });
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      return NextResponse.json({ error: `Could not save: ${message}` }, { status: 500 });
    }
  }

  const { problems, bet, corrects } = parseSingle(body, randomUUID);

  // A correction must name a bet that exists IN THIS LEDGER. Accepting an unknown id
  // would write a row that supersedes nothing, leaving BOTH versions standing and the
  // record counting the wager twice -- the opposite of what was asked for, and silent.
  //
  // Scoping the lookup to the caller's own rows is also what stops a correction being a
  // way to reach across ledgers: a void is a write that removes somebody's bet, and
  // without this it would remove anybody's.
  if (corrects !== null) {
    try {
      const known = await listBets(ownerId);
      const target = known.find((b) => b.bet_id === corrects);
      if (!target) problems.push("The bet being corrected was not found.");
      else if (target.supersedes === corrects) problems.push("A bet cannot correct itself.");
    } catch {
      problems.push("Could not check the bet being corrected.");
    }
  }

  if (problems.length > 0 || !bet) {
    return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
  }

  try {
    await saveBet(ownerId, bet);
    return NextResponse.json({ ok: true, bet_id: bet.bet_id });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: `Could not save: ${message}` }, { status: 500 });
  }
}
