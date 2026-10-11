import { NextResponse } from "next/server";

import { getTax, setTax } from "@/lib/settings-db";

export const dynamic = "force-dynamic";

/**
 * The owner's tax setting: rate on winnings, and whether losses come off. Owner-only by
 * the middleware's allowlist (guests cannot reach /api routes not listed for them).
 */
export async function GET() {
  try {
    return NextResponse.json(await getTax());
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }
  try {
    return NextResponse.json(await setTax(body));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown error" }, { status: 500 });
  }
}
