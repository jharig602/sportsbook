/**
 * A single passcode in front of the whole app.
 *
 * The write endpoints are called from your own browser — logging a bet, marking a
 * survivor pick, typing a second book's line — so they cannot be guarded by a bearer
 * secret the way the dispatchers are. A secret the browser has to send is a secret in
 * the JavaScript bundle, which is to say not a secret.
 *
 * So: one passcode, one cookie, checked in middleware before anything runs.
 *
 * The exposure this closes is not hypothetical and does not depend on the repository
 * being public. The site is already reachable, and `/api/book-lines` accepts a quote
 * that joins the consensus every other price is measured against — its own docstring
 * says a mistyped line "manufactures an edge that is not there, which is the one
 * failure mode this app is built to avoid". Anyone who guessed the path could do that.
 * Making the source public would only have saved them the guessing.
 *
 * The cookie holds a SHA-256 of the passcode rather than the passcode. Someone who does
 * not know it cannot produce the digest, and the cookie is httpOnly so a script on the
 * page cannot read it back out. Not a session system — there is one user, and rotating
 * the passcode invalidates every cookie at once, which is the only revocation needed.
 */

export const UNLOCK_COOKIE = "dissent_unlock";

/** Web Crypto rather than node:crypto, because middleware runs on the Edge runtime. */
export async function digest(passcode: string): Promise<string> {
  const bytes = new TextEncoder().encode(`dissent:${passcode}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Constant-time comparison.
 *
 * Both values are hex digests of a fixed length, so a plain `===` would leak how many
 * leading characters matched through timing. The cost of doing it properly is nothing.
 */
export function sameDigest(a: string | undefined, b: string): boolean {
  if (!a || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Paths that must stay reachable without the cookie.
 *
 * The dispatchers carry their own bearer secret and are called by GitHub Actions, which
 * has no cookie and never will. The VAPID public key is meant to be public. The unlock
 * route obviously cannot require being unlocked.
 */
export function isOpenPath(pathname: string): boolean {
  return (
    pathname === "/unlock" ||
    pathname === "/api/unlock" ||
    pathname.startsWith("/api/dispatch-") ||
    pathname === "/api/push/key" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/sw.js" ||
    pathname === "/icon.svg" ||
    pathname === "/offline.html"
  );
}
