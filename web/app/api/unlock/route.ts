import { NextResponse } from "next/server";

import { digest, UNLOCK_COOKIE } from "@/lib/unlock";

export const dynamic = "force-dynamic";

/**
 * Exchange the passcode for the cookie.
 *
 * Deliberately gives no hint about what was wrong. "Incorrect passcode" and nothing
 * else: a message distinguishing "too short" from "wrong" is a message that helps
 * someone guess.
 */
export async function POST(request: Request) {
  const expected = process.env.APP_PASSCODE;
  if (!expected) {
    return NextResponse.json({ error: "No passcode is configured." }, { status: 503 });
  }

  let body: { passcode?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Incorrect passcode." }, { status: 401 });
  }
  const given = String(body.passcode ?? "");
  const viewer = process.env.APP_VIEWER_PASSCODE;
  // Either passcode is accepted; which one decides what the cookie unlocks.
  const matched = given === expected ? expected : viewer && given === viewer ? viewer : null;
  if (matched === null) {
    return NextResponse.json({ error: "Incorrect passcode." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true, role: matched === expected ? "owner" : "viewer" });
  response.cookies.set(UNLOCK_COOKIE, await digest(matched), {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    // Long, because this is a phone you keep. Rotating APP_PASSCODE revokes every
    // cookie at once, which is the only revocation a one-person app needs.
    maxAge: 60 * 60 * 24 * 365,
  });
  return response;
}
