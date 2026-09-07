import { NextResponse } from "next/server";

/** The VAPID *public* key is meant to be handed to clients; the private key never is. */
export async function GET() {
  return NextResponse.json({ publicKey: process.env.VAPID_PUBLIC_KEY ?? null });
}
