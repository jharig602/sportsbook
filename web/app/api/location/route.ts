import { NextResponse } from "next/server";

import { getLocation, setLocation } from "@/lib/settings-db";

export const dynamic = "force-dynamic";

/**
 * The owner's state (Settings). Owner-only by the middleware's allowlist. It decides
 * whether Kalshi flags that buy on Kalshi may be shown (kalshi.ts).
 */
export async function GET() {
  try {
    return NextResponse.json({ state: await getLocation() });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown error" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: { state?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }
  try {
    return NextResponse.json({ state: await setLocation(body.state) });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown error" }, { status: 400 });
  }
}
