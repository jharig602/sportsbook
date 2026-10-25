import { OPEN_CORS, readBody } from "@/lib/oauth";
import { revokeToken } from "@/lib/oauth-db";

export const dynamic = "force-dynamic";

/** RFC 7009 revocation: a client giving back its own token. Always 200, per the spec. */
export async function POST(request: Request) {
  const body = await readBody(request);
  if (body.token) await revokeToken(body.token).catch(() => undefined);
  return new Response(null, { status: 200, headers: { ...OPEN_CORS, "Cache-Control": "no-store" } });
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: OPEN_CORS });
}
