import { generateProtectedResourceMetadata } from "mcp-handler";

import { OPEN_CORS, publicOrigin, SCOPE } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/**
 * RFC 9728 protected resource metadata: tells Claude that /api/mcp is guarded and which
 * server issues its tokens (this app). Served at the root and at the path-suffixed form
 * (/.well-known/oauth-protected-resource/api/mcp) that newer clients try first.
 */
export function GET(request: Request) {
  const origin = publicOrigin(request);
  const metadata = generateProtectedResourceMetadata({
    authServerUrls: [origin],
    resourceUrl: `${origin}/api/mcp`,
    additionalMetadata: {
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "Dissent",
    },
  });
  return Response.json(metadata, { headers: { ...OPEN_CORS, "Cache-Control": "max-age=3600" } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: OPEN_CORS });
}
