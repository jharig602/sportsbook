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
  if (String(body.passcode ?? "") !== expected) {
    return NextResponse.json({ error: "Incorrect passcode." }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  response.cookies.set(UNLOCK_COOKIE, await digest(expected), {
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
