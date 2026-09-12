/**
 * The passcode gate.
 *
 * Runs before every route, including the API. Without it `/api/bets` and
 * `/api/book-lines` accept writes from anyone who knows the path — and one of those
 * feeds the consensus that every edge on the board is measured against.
 *
 * When APP_PASSCODE is unset the app stays open rather than locking you out of your own
 * data, but it says so on every page. Failing open silently is the pattern this project
 * exists to avoid; failing open loudly is a deliberate, visible state you can fix.
 *
 * It also mints the visitor identifier that makes a ledger personal, because this is the
 * first code to see a request and the only place that can set a cookie the same render
 * will then read. Minting it later would show a viewer an empty ledger once before their
 * own appeared -- and an empty ledger is indistinguishable from a lost one.
 */

import { NextResponse, type NextRequest } from "next/server";

import { newOwnerId, OWNER_COOKIE, OWNER_COOKIE_MAX_AGE, validOwnerId } from "@/lib/owner";
import { digest, isOpenPath, roleFor, UNLOCK_COOKIE, viewerAllowed } from "@/lib/unlock";

/**
 * Continue, ensuring the visitor carries an identifier.
 *
 * A fresh one is written onto the FORWARDED REQUEST as well as the response, so the very
 * render that triggered the mint already sees it. Setting it only on the response would
 * leave this page rendering as "no ledger" and the next one as theirs, which looks
 * exactly like a ledger that was there and went.
 */
function proceed(request: NextRequest): NextResponse {
  const existing = request.cookies.get(OWNER_COOKIE)?.value;
  if (validOwnerId(existing)) return NextResponse.next();

  const minted = newOwnerId();
  const headers = new Headers(request.headers);
  request.cookies.set(OWNER_COOKIE, minted);
  headers.set("cookie", request.cookies.toString());
  const response = NextResponse.next({ request: { headers } });
  response.cookies.set(OWNER_COOKIE, minted, {
    httpOnly: true,
    sameSite: "lax",
    secure: true,
    path: "/",
    maxAge: OWNER_COOKIE_MAX_AGE,
  });
  return response;
}
/** Decide the role, then let it through, bounce it, or lock it out. */
export async function middleware(request: NextRequest) {
  const passcode = process.env.APP_PASSCODE;
  if (!passcode) return NextResponse.next();

  const { pathname } = request.nextUrl;
  if (isOpenPath(pathname)) return NextResponse.next();

  const viewerCode = process.env.APP_VIEWER_PASSCODE;
  const role = roleFor(
    request.cookies.get(UNLOCK_COOKIE)?.value,
    await digest(passcode),
    viewerCode ? await digest(viewerCode) : null,
  );

  if (role === "owner") return NextResponse.next();
  if (role === "viewer") {
    if (viewerAllowed(pathname)) return proceed(request);
    // Not "locked" — they are let in, just not here. Sending them to the passcode form
    // would imply a better passcode exists for them, which it does not.
    if (pathname.startsWith("/api/")) {
      // Not "read-only" -- they write their own ledger freely. This route touches
      // something shared: the consensus, the settings the dispatcher reads, or my phone.
      return NextResponse.json(
        { error: "That one is shared, so it stays with the owner." },
        { status: 403 },
      );
    }
    const home = request.nextUrl.clone();
    home.pathname = "/";
    home.search = "";
    return NextResponse.redirect(home);
  }

  // An API call gets a status it can act on; a page gets sent to the passcode form.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Locked." }, { status: 401 });
  }
  const url = request.nextUrl.clone();
  url.pathname = "/unlock";
  url.search = `?from=${encodeURIComponent(pathname)}`;
  return NextResponse.redirect(url);
}

export const config = {
  // Everything except Next's own assets and the favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
