import { NextResponse } from "next/server";

import { connectorStatus, revokeAll } from "@/lib/oauth-db";
import { currentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * The Claude connector from Settings: its status, and disconnecting it. Owner only --
 * middleware already keeps guests out, and this checks again.
 */
async function ownerOnly(): Promise<NextResponse | null> {
  const session = await currentSession();
  return session.role === "owner"
    ? null
    : NextResponse.json({ error: "Only the owner manages the connector." }, { status: 403 });
}

export async function GET() {
  const denied = await ownerOnly();
  if (denied) return denied;
  return NextResponse.json(await connectorStatus());
}

/** Revoke every token: Claude has to be approved again before it reads anything. */
export async function DELETE() {
  const denied = await ownerOnly();
  if (denied) return denied;
  const revoked = await revokeAll();
  return NextResponse.json({ revoked });
}
