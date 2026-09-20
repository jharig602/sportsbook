import { randomUUID } from "node:crypto";

import { NextResponse } from "next/server";

import { deletePromo, listPromos, savePromo } from "@/lib/promos-db";
import { currentSession } from "@/lib/session";
import type { Promo } from "@/lib/types";

export const dynamic = "force-dynamic";

const TYPES = new Set([
  "stake_back", "profit_boost", "odds_boost", "bonus_bet", "deposit_match",
]);

/**
 * Promo terms, typed in by hand.
 *
 * Validated field by field, and a field that does not apply to the type is stored null
 * rather than zero. A zero cap reads as "no refund" and a zero boost as "no boost",
 * which are real terms someone could have entered -- so guessing one here would change
 * what a promo is worth while looking exactly like a term that was typed.
 */
function money(value: unknown, max = 1_000_000): number | null {
  const n = Number(value);
  return value === undefined || value === null || value === "" || !Number.isFinite(n) || n < 0 || n > max
    ? null
    : n;
}

function americanPrice(value: unknown): number | null {
  const n = Number(value);
  if (value === undefined || value === null || value === "") return null;
  if (!Number.isFinite(n) || Math.abs(n) < 100 || Math.abs(n) > 1_000_000) return null;
  return Math.round(n);
}

function when(value: unknown): string | null {
  if (typeof value !== "string" || value === "") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function tags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim().slice(0, 60)).filter(Boolean).slice(0, 20);
}

export async function GET() {
  const { ownerId } = await currentSession();
  if (!ownerId) {
    return NextResponse.json({ error: "No ledger is attached to this session." }, { status: 401 });
  }
  try {
    return NextResponse.json({ promos: await listPromos(ownerId) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

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

  const problems: string[] = [];
  const type = String(body.type ?? "");
  if (!TYPES.has(type)) problems.push("Pick a promo type.");
  const book = String(body.book ?? "").trim();
  if (book.length === 0 || book.length > 40) problems.push("Name the book.");
  const title = String(body.title ?? "").trim();
  if (title.length === 0 || title.length > 120) problems.push("Give it a title, as the book words it.");

  // The one term with no sensible default. Everything else can be left blank and simply
  // widens the answer; without an expiry the dashboard cannot do the one job it has.
  const expires = when(body.expires_at);
  if (!expires) problems.push("An expiry is required — it is what the dashboard sorts on.");

  const boostRaw = Number(body.boost_pct);
  const boost =
    body.boost_pct === undefined || body.boost_pct === null || body.boost_pct === ""
      ? null
      : Number.isFinite(boostRaw) && boostRaw > 0 && boostRaw <= 10
        ? boostRaw
        : null;
  if (type === "profit_boost" && boost === null) {
    problems.push("A profit boost needs its percentage (0.5 for 50%).");
  }
  if (type === "stake_back" && money(body.cap_refund) === null) {
    problems.push("A stake-back needs its refund cap.");
  }
  if (type === "deposit_match" && money(body.deposit_bonus) === null) {
    problems.push("A deposit match needs the bonus amount.");
  }
  if (type === "odds_boost" && americanPrice(body.boosted_price) === null) {
    problems.push("An odds boost needs the boosted price.");
  }
  if (type === "bonus_bet" && money(body.bonus_face) === null) {
    problems.push("A bonus bet needs its face value.");
  }

  if (problems.length > 0) {
    return NextResponse.json({ error: problems.join(" ") }, { status: 400 });
  }

  const legs = Number(body.min_legs);
  const rollover = Number(body.rollover_multiple);
  const promo: Promo = {
    promo_id: typeof body.promo_id === "string" && body.promo_id.length > 0 ? body.promo_id : randomUUID(),
    book,
    type: type as Promo["type"],
    title,
    claimed_at: when(body.claimed_at),
    expires_at: expires as string,
    cap_refund: money(body.cap_refund),
    max_stake: money(body.max_stake),
    boost_pct: boost,
    bonus_face: money(body.bonus_face),
    boosted_price: americanPrice(body.boosted_price),
    base_price: americanPrice(body.base_price),
    deposit_bonus: money(body.deposit_bonus),
    rollover_multiple: Number.isFinite(rollover) && rollover > 0 && rollover <= 100 ? rollover : null,
    min_odds_american: americanPrice(body.min_odds_american),
    min_legs: Number.isFinite(legs) && legs >= 1 && legs <= 20 ? Math.round(legs) : null,
    eligible_markets: tags(body.eligible_markets),
    eligible_from: when(body.eligible_from),
    eligible_to: when(body.eligible_to),
    excluded: tags(body.excluded),
    stackable: body.stackable === true,
    status: body.status === "used" ? "used" : "available",
    created_at: new Date().toISOString(),
  };

  try {
    await savePromo(ownerId, promo);
    return NextResponse.json({ ok: true, promo });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: `Could not save: ${message}` }, { status: 500 });
  }
}

export async function DELETE(request: Request) {
  const { ownerId } = await currentSession();
  if (!ownerId) {
    return NextResponse.json({ error: "No ledger is attached to this session." }, { status: 401 });
  }
  let body: { promo_id?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }
  const id = String(body.promo_id ?? "");
  if (!id) return NextResponse.json({ error: "Name the promo to remove." }, { status: 400 });
  try {
    const removed = await deletePromo(ownerId, id);
    return NextResponse.json({ ok: removed });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
