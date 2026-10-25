import { authServerMetadata, OPEN_CORS, publicOrigin } from "@/lib/oauth";

export const dynamic = "force-dynamic";

/** RFC 8414 authorization server metadata, for the connector's sign-in (oauth.ts). */
export function GET(request: Request) {
  return Response.json(authServerMetadata(publicOrigin(request)), {
    headers: { ...OPEN_CORS, "Cache-Control": "max-age=3600" },
  });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: OPEN_CORS });
}
