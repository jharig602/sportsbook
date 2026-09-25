/**
 * The one check every cron endpoint makes: is this really the collector calling?
 *
 * The `/api/dispatch-*` routes are open to the internet on purpose -- GitHub Actions has
 * no cookie -- and each is guarded by a bearer secret instead. Five of them each carried
 * their own copy of this check, which is five places for it to drift, and every copy
 * compared the secret with `!==`: a comparison that stops at the first differing
 * character, and so in principle leaks through timing how much of a guess was right.
 *
 * Here once, compared in constant time. Both sides are hashed to fixed-length digests
 * first, so even the lengths cannot differ.
 *
 * Any new route under `/api/dispatch-` is public by the middleware's rule and MUST call
 * this before doing anything else.
 */
import { NextResponse } from "next/server";

import { sameDigest } from "./unlock";

/**
 * Tolerate the ways a secret gets mangled on its way into an environment variable:
 * a trailing newline from the clipboard, surrounding quotes, or the whole
 * `NAME=value` line pasted into the value box. Each produces a silent 401 that looks
 * identical to a genuinely wrong secret, and the workflow logs it without failing --
 * so notifications would just never arrive, with nothing obviously broken.
 */
export function normaliseSecret(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value.startsWith("ALERT_DISPATCH_SECRET=")) {
    value = value.slice("ALERT_DISPATCH_SECRET=".length).trim();
  }
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
    value = value.slice(1, -1).trim();
  }
  return value || null;
}

async function sha256(value: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`dispatch:${value}`),
  );
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * A refusal to return, or null when the caller is the collector.
 *
 * Used as `const denied = await refuseUnlessDispatcher(request); if (denied) return denied;`
 * so the check is the first thing each route does and cannot be skipped by an early
 * branch above it.
 */
export async function refuseUnlessDispatcher(request: Request): Promise<NextResponse | null> {
  const secret = normaliseSecret(process.env.ALERT_DISPATCH_SECRET);
  if (!secret) {
    return new NextResponse("ALERT_DISPATCH_SECRET is not configured.", { status: 503 });
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = normaliseSecret(
    header.toLowerCase().startsWith("bearer ") ? header.slice(7) : header,
  );
  if (!presented || !sameDigest(await sha256(presented), await sha256(secret))) {
    return new NextResponse("Unauthorized.", { status: 401 });
  }
  return null;
}
