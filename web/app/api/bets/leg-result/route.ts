import { NextResponse } from "next/server";

import { recordLegResult } from "@/lib/bets-db";
import { currentSession } from "@/lib/session";
import type { LegResult } from "@/lib/settle";

export const dynamic = "force-dynamic";

const RESULTS = new Set<LegResult>(["won", "lost", "push", "void"]);

/**
 * How a player-prop leg ended, tapped on the Bets page. Written to `leg_results` (a new
 * row; the latest counts), never onto the bet. Scoped to the caller's own ledger: the
 * write is refused unless the leg is a prop that belongs to it.
 */
export async function POST(request: Request) {
  const { ownerId } = await currentSession();
  if (!ownerId) return NextResponse.json({ error: "No ledger is attached to this session." }, { status: 401 });
  let body: { bet_id?: unknown; result?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }
  const betId = String(body.bet_id ?? "");
  const result = String(body.result ?? "") as LegResult;
  if (!betId || !RESULTS.has(result)) {
    return NextResponse.json({ error: "Expected a bet_id and a result of won, lost, push or void." }, { status: 400 });
  }
  try {
    await recordLegResult(ownerId, betId, result);
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown error" }, { status: 400 });
  }
}
