import { NextResponse } from "next/server";

import { getPools, setPools } from "@/lib/settings-db";

export const dynamic = "force-dynamic";

/** Survivor entries, and which teams each has already spent. */
export async function GET() {
  try {
    return NextResponse.json({ pools: await getPools() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: { pools?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }
  if (!Array.isArray(body.pools)) {
    return NextResponse.json({ error: "pools must be an array." }, { status: 400 });
  }
  try {
    // setPools validates and clamps; a malformed entry is dropped, not stored.
    return NextResponse.json({ pools: await setPools(body.pools as never) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
