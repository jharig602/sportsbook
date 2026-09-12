import { NextResponse } from "next/server";

import { claimTransfer, ledgerSize } from "@/lib/ledger-db";
import {
  HOUSE,
  normalizeTransferCode,
  OWNER_COOKIE,
  OWNER_COOKIE_MAX_AGE,
} from "@/lib/owner";
import { currentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Take over the ledger a code names.
 *
 * Refused for the owner in the other direction too: claiming would swap my own season
 * for somebody else's on the strength of eight typed characters, and my ledger is not
 * addressable by identifier precisely so that cannot happen. The passcode decides who
 * the owner is; nothing typed into a form gets to change that.
 *
 * A malformed code is rejected here rather than looked up, so the message can say "that
 * is not a code" instead of "no such code" — which reads as an expiry and sends people
 * back to generate another one that will fail the same way.
 */
export async function POST(request: Request) {
  const { ownerId } = await currentSession();
  if (ownerId === HOUSE) {
    return NextResponse.json(
      { error: "You are signed in as the owner; this would replace your own ledger." },
      { status: 400 },
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }

  const code = normalizeTransferCode(String(body.code ?? ""));
  if (!code) {
    return NextResponse.json(
      { error: "That is not a transfer code — they are eight letters and digits." },
      { status: 400 },
    );
  }

  try {
    const claimed = await claimTransfer(code);
    if (!claimed) {
      // One message for "wrong" and for "expired", deliberately. Distinguishing them
      // tells someone guessing which half of the space to keep guessing in, and tells
      // the person who mistyped nothing they can act on differently.
      return NextResponse.json(
        { error: "That code is not valid any more. Codes last fifteen minutes and one use." },
        { status: 404 },
      );
    }
    const size = await ledgerSize(claimed).catch(() => 0);
    const response = NextResponse.json({ ok: true, bets: size });
    response.cookies.set(OWNER_COOKIE, claimed, {
      httpOnly: true,
      sameSite: "lax",
      secure: true,
      path: "/",
      maxAge: OWNER_COOKIE_MAX_AGE,
    });
    return response;
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: `Could not claim: ${message}` }, { status: 500 });
  }
}
