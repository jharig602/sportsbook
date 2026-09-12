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

export type Role = "owner" | "viewer" | null;

/**
 * What a viewer may open.
 *
 * The line is SHARED versus PERSONAL, not read versus write — which is a change from
 * how this started, and the reason is worth keeping.
 *
 * Everything about the MARKET is shared: one board, one consensus, one track record,
 * collected once at real cost and identical for everybody. A viewer reads all of it and
 * writes none of it. `/api/book-lines` is the sharpest case — it accepts a quote that
 * joins the consensus every price in the app is measured against, so a mistyped or
 * mischievous line there manufactures an edge that is not there, for everyone, and
 * nothing downstream could tell. Settings are shared too: they decide which books the
 * dispatcher considers reachable and when a phone buzzes.
 *
 * Everything about a PERSON is theirs alone. Their ledger is their own rows under their
 * own owner id, so they write freely there and it touches nobody else's numbers — two
 * people's bets in one tally would produce a win rate that describes neither of them.
 *
 * Survivor is the exception that is neither: it is excluded for strategy rather than
 * privacy. The objective the planner computes is P(last entrant standing), and its value
 * comes from NOT holding the same ticket as the field — measured at up to 1.43x par in a
 * 137-entry pool. Showing a rival the pick converts a differentiated entry into a shared
 * one for free, which is precisely what the solver spends its whole run avoiding. It
 * stays behind the owner passcode however many people use the rest of the app.
 */
const VIEWER_PAGES = [
  "/", "/shop", "/record", "/movers", "/edges", "/about", "/game", "/bets",
];

/**
 * The only routes a viewer may call. An allowlist rather than a blocklist, because the
 * failure directions are not symmetric: a forgotten entry here means a viewer sees a
 * page that does not load, which they will report. A forgotten entry on a blocklist
 * means a stranger writing to the consensus, which nobody would ever notice.
 */
const VIEWER_APIS = ["/api/bets", "/api/ledger"];

export function viewerAllowed(pathname: string): boolean {
  if (pathname.startsWith("/api/")) {
    return VIEWER_APIS.some(
      (api) => pathname === api || pathname.startsWith(`${api}/`),
    );
  }
  return VIEWER_PAGES.some(
    (page) => pathname === page || (page !== "/" && pathname.startsWith(`${page}/`)),
  );
}

/** Which passcode the cookie matches, if either. */
export function roleFor(
  cookie: string | undefined,
  ownerDigest: string,
  viewerDigest: string | null,
): Role {
  if (sameDigest(cookie, ownerDigest)) return "owner";
  if (viewerDigest && sameDigest(cookie, viewerDigest)) return "viewer";
  return null;
}
