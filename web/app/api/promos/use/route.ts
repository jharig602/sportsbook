import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { listPromos, recordUse, setPromoStatus } from "@/lib/promos-db";
import { currentSession } from "@/lib/session";
import type { PromoUse } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Record that a promo was spent, and on what.
 *
 * The expectation at placement is stored as it stood, never recomputed later. Comparing
 * summed expectations against what actually came back is the only honest check on the
 * bonus-conversion assumption every one of these formulas leans on — and recomputing it
 * from today's numbers would be marking our own homework.
 *
 * Marking a promo used and writing the use are one transaction. A use whose promo still
 * reads "available" would keep counting toward the expiring total for days, which is
 * exactly the leak this feature exists to close.
 */
export async function POST(request: Request) {
  const { ownerId } = await currentSession();
  if (!ownerId) {
    return NextResponse.json({ error: "No ledger is attached to this session." }, { status: 401 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }

  // "Used it elsewhere" with no details still closes the token out. Demanding a stake
  // and a price for that would leave it sitting in the dashboard instead.
  const promoId = String(body.promo_id ?? "");
  if (!promoId) return NextResponse.json({ error: "Name the promo." }, { status: 400 });

  const mine = await listPromos(ownerId).catch(() => []);
  if (!mine.some((p) => p.promo_id === promoId)) {
    // Scoped to this ledger, so one visitor cannot close out another's token.
    return NextResponse.json({ error: "That promo is not in this ledger." }, { status: 404 });
  }

  if (body.detailsOnly === true || body.stake === undefined || body.stake === null || body.stake === "") {
    const ok = await setPromoStatus(ownerId, promoId, "used");
    return NextResponse.json({ ok, recorded: false });
  }

  const problems: string[] = [];
  const stake = Number(body.stake);
  if (!Number.isFinite(stake) || stake <= 0 || stake > 1_000_000) problems.push("Stake must be more than zero.");
  const price = Number(body.odds_american);
  if (!Number.isFinite(price) || Math.abs(price) < 100) {
    problems.push("Price must be American odds of at least +100 or -100.");
  }
  const legs = body.legs === undefined || body.legs === null || body.legs === "" ? 1 : Number(body.legs);
  if (!Number.isFinite(legs) || legs < 1 || legs > 20) problems.push("Legs must be between 1 and 20.");
  const fair = body.fair_prob === undefined || body.fair_prob === null || body.fair_prob === "" ? null : Number(body.fair_prob);
  if (fair !== null && (!Number.isFinite(fair) || fair <= 0 || fair >= 1)) {
    problems.push("Fair probability must sit between 0 and 1.");
  }
  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
  }

  const ev = Number(body.ev_at_placement);
  const use: PromoUse = {
    use_id: randomUUID(),
    promo_id: promoId,
    placed_at: new Date().toISOString(),
    stake,
    odds_american: Math.round(price),
    legs: Math.round(legs),
    bet_id: typeof body.bet_id === "string" && body.bet_id.length > 0 ? body.bet_id : null,
    fair_prob: fair,
    ev_at_placement: Number.isFinite(ev) ? ev : null,
    settled_at: null,
    result: null,
    returned_cash: null,
    returned_bonus: null,
  };

  try {
    await recordUse(ownerId, use);
    return NextResponse.json({ ok: true, recorded: true, use });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: `Could not save: ${message}` }, { status: 500 });
  }
}
