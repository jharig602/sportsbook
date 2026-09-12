import { NextResponse } from "next/server";

import { getFavourites, setFavourites } from "@/lib/settings-db";

export const dynamic = "force-dynamic";

/** Teams backed every week regardless of the board. */
export async function GET() {
  try {
    return NextResponse.json({ teams: await getFavourites() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: { teams?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Body is not valid JSON." }, { status: 400 });
  }
  if (!Array.isArray(body.teams)) {
    return NextResponse.json({ error: "teams must be an array." }, { status: 400 });
  }
  try {
    // setFavourites validates and clamps; anything malformed is dropped, not stored.
    return NextResponse.json({ teams: await setFavourites(body.teams as string[]) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
