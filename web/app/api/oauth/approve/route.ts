import { NextResponse } from "next/server";

import { callbackUrl, grantedScope, loopbackAllowed, parseAuthorize, publicOrigin } from "@/lib/oauth";
import { createCode, findClient } from "@/lib/oauth-db";
import { currentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The owner's decision on the consent page. The only place a code is ever minted.
 *
 * Behind the passcode gate (middleware), and checked again here: owner only, and only from
 * this site's own page -- the Origin must be ours, so another site cannot post an
 * approval with the owner's cookie riding along (the cookie is SameSite=Lax as well).
 * Every parameter is validated again rather than trusted from the page.
 */
export async function POST(request: Request) {
  const session = await currentSession();
  if (session.role !== "owner") {
    return NextResponse.json({ error: "Only the owner can connect Claude." }, { status: 403 });
  }
  const origin = publicOrigin(request);
  if (request.headers.get("origin") !== origin) {
    return NextResponse.json({ error: "Approve from the Dissent page itself." }, { status: 403 });
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Bad request." }, { status: 400 });
  }
  const params: Record<string, string | undefined> = {};
  for (const key of ["client_id", "redirect_uri", "code_challenge", "code_challenge_method", "state", "scope", "resource"]) {
    if (typeof body[key] === "string") params[key] = body[key] as string;
  }
  params.response_type = "code";

  const allowLoopback = loopbackAllowed();
  const parsed = parseAuthorize(params, `${origin}/api/mcp`, allowLoopback);
  if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 });
  const { request: auth } = parsed;
  const client = await findClient(auth.clientId, allowLoopback);
  if (!client || !client.redirect_uris.includes(auth.redirectUri)) {
    return NextResponse.json({ error: "Unknown client or redirect." }, { status: 400 });
  }

  if (body.decision !== "approve") {
    return NextResponse.json({
      redirect: callbackUrl(auth.redirectUri, { error: "access_denied" }, auth.state, origin),
    });
  }
  // Logging is granted only when the owner ticked it on this page, never because the
  // client asked for it.
  const code = await createCode(auth.clientId, auth.redirectUri, auth.codeChallenge, grantedScope(body.allow_logging === true));
  return NextResponse.json({ redirect: callbackUrl(auth.redirectUri, { code }, auth.state, origin) });
}
