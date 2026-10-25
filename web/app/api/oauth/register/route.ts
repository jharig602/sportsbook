import { loopbackAllowed, OPEN_CORS, oauthError, readBody, redirectAllowed } from "@/lib/oauth";
import { recentRegistrations, registerClient } from "@/lib/oauth-db";

export const dynamic = "force-dynamic";

/**
 * Dynamic client registration (RFC 7591), open as the spec requires.
 *
 * Registering grants nothing: a client can only send the owner to the consent page, and
 * only to have the code returned to Claude's own callback. So the endpoint checks the
 * redirect URIs and caps the rate, and that is all it needs to do.
 */
export async function POST(request: Request) {
  const body = await readBody(request);
  let uris: unknown;
  try {
    uris = JSON.parse(body.redirect_uris ?? "[]");
  } catch {
    uris = null;
  }
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 5) {
    return oauthError("invalid_redirect_uri", "redirect_uris must list one to five addresses.");
  }
  const allowLoopback = loopbackAllowed();
  if (!uris.every((u) => typeof u === "string" && redirectAllowed(u, allowLoopback))) {
    return oauthError("invalid_redirect_uri", "Only Claude's own callback can receive codes from this server.");
  }
  const method = body.token_endpoint_auth_method;
  if (method && method !== "none") {
    return oauthError("invalid_client_metadata", "Only public clients (token_endpoint_auth_method none) are supported.");
  }
  if ((await recentRegistrations()) >= 30) {
    return oauthError("temporarily_unavailable", "Too many registrations; try again later.", 429);
  }
  const client = await registerClient(body.client_name ?? null, uris as string[]);
  return Response.json(
    {
      client_id: client.client_id,
      client_id_issued_at: Math.floor(Date.now() / 1000),
      client_name: client.client_name ?? undefined,
      redirect_uris: client.redirect_uris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
    { status: 201, headers: { ...OPEN_CORS, "Cache-Control": "no-store" } },
  );
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: OPEN_CORS });
}
