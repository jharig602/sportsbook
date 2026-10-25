import { OPEN_CORS, oauthError, pkceMatches, readBody } from "@/lib/oauth";
import { consumeCode, issueTokens, rotateRefresh } from "@/lib/oauth-db";

export const dynamic = "force-dynamic";

function tokens(issued: { access_token: string; refresh_token: string; expires_in: number; scope: string }) {
  return Response.json(
    { ...issued, token_type: "Bearer" },
    { headers: { ...OPEN_CORS, "Cache-Control": "no-store", Pragma: "no-cache" } },
  );
}

/**
 * The token endpoint: a code (with its PKCE verifier) or a refresh token for a new pair.
 *
 * A code is spent before it is checked, so a wrong verifier burns it: an attacker holding
 * a stolen code gets one guess, and the real client simply starts the sign-in again.
 */
export async function POST(request: Request) {
  const body = await readBody(request);
  const clientId = body.client_id;
  if (!clientId) return oauthError("invalid_client", "client_id is required.", 401);

  if (body.grant_type === "authorization_code") {
    if (!body.code || !body.code_verifier || !body.redirect_uri) {
      return oauthError("invalid_request", "code, code_verifier and redirect_uri are required.");
    }
    const code = await consumeCode(body.code);
    if (
      !code ||
      code.client_id !== clientId ||
      code.redirect_uri !== body.redirect_uri ||
      !(await pkceMatches(body.code_verifier, code.code_challenge))
    ) {
      return oauthError("invalid_grant", "That code is invalid, expired or already used.");
    }
    return tokens(await issueTokens(clientId, code.scope));
  }

  if (body.grant_type === "refresh_token") {
    if (!body.refresh_token) return oauthError("invalid_request", "refresh_token is required.");
    const rotated = await rotateRefresh(body.refresh_token, clientId);
    if (rotated === "reused") {
      return oauthError("invalid_grant", "That refresh token was already used; sign in again.");
    }
    if (!rotated) return oauthError("invalid_grant", "That refresh token is invalid or expired.");
    return tokens(rotated);
  }

  return oauthError("unsupported_grant_type", "Use authorization_code or refresh_token.");
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: OPEN_CORS });
}
