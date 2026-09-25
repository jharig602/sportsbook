import { NextResponse } from "next/server";

import { recentUnlockFailures, recordUnlockFailure } from "@/lib/settings-db";
import { digest, sameDigest, UNLOCK_COOKIE } from "@/lib/unlock";
import { hashSource, lockoutFor, sourceOf, waitText } from "@/lib/unlock-limit";

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

  // Checked before the guess is even compared. A locked-out source that still had its
  // guess evaluated could keep learning from a success; the limit has to stop the
  // guessing, not just the reporting of it. See unlock-limit.ts.
  const source = await hashSource(sourceOf(request.headers));
  const recent = await recentUnlockFailures();
  if (recent === null) {
    // The check could not be made. Refusing is the safe answer: a limit that turns off
    // whenever the database is unreachable is one an attacker only has to wait out.
    return NextResponse.json(
      { error: "Can't check that right now. Try again in a minute." },
      { status: 503, headers: { "Retry-After": "60" } },
    );
  }
  const lock = lockoutFor(recent, source, new Date());
  if (lock.locked) {
    return NextResponse.json(
      { error: `Too many attempts. Try again in ${waitText(lock.retryAfterSeconds)}.` },
      { status: 429, headers: { "Retry-After": String(lock.retryAfterSeconds) } },
    );
  }

  let body: { passcode?: unknown };
  try {
    body = await request.json();
  } catch {
    await recordUnlockFailure(source).catch(() => undefined);
    return NextResponse.json({ error: "Incorrect passcode." }, { status: 401 });
  }
  const given = String(body.passcode ?? "");
  const viewer = process.env.APP_VIEWER_PASSCODE;

  // Compared as fixed-length digests, in constant time. A plain `===` on the passcodes
  // themselves stops at the first differing character, which in principle leaks how much
  // of a guess was right through how long the answer took.
  const givenDigest = await digest(given);
  const isOwner = sameDigest(givenDigest, await digest(expected));
  const isViewer = !isOwner && !!viewer && sameDigest(givenDigest, await digest(viewer));
  // Either passcode is accepted; which one decides what the cookie unlocks.
  const matched = isOwner ? expected : isViewer ? viewer : null;
  if (!matched) {
    await recordUnlockFailure(source).catch(() => undefined);
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
