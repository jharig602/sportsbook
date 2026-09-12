import { NextResponse } from "next/server";

import { issueTransfer } from "@/lib/ledger-db";
import { HOUSE } from "@/lib/owner";
import { currentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Hand out a code that moves this ledger to another device.
 *
 * Refused for the owner, and the message says why rather than just saying no: the
 * passcode already works on a phone, so a code would be a second and weaker way into
 * the same rows. There is no version of that trade worth making.
 */
export async function POST() {
  const { ownerId } = await currentSession();
  if (!ownerId) {
    return NextResponse.json({ error: "No ledger is attached to this session." }, { status: 401 });
  }
  if (ownerId === HOUSE) {
    return NextResponse.json(
      {
        error:
          "Your own ledger moves with the passcode — open the app on the other device " +
          "and type it. A transfer code would be a second way in, and a weaker one.",
      },
      { status: 400 },
    );
  }
  try {
    return NextResponse.json({ ok: true, ...(await issueTransfer(ownerId)) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: `Could not make a code: ${message}` }, { status: 500 });
  }
}
