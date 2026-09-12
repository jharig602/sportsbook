import { NextResponse, type NextRequest } from "next/server";

import { digest, isOpenPath, roleFor, UNLOCK_COOKIE, viewerAllowed } from "@/lib/unlock";

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
 */
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
    if (viewerAllowed(pathname)) return NextResponse.next();
    // Not "locked" — they are let in, just not here. Sending them to the passcode form
    // would imply a better passcode exists for them, which it does not.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Read-only." }, { status: 403 });
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
