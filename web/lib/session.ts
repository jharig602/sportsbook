/**
 * Who is asking, and whose ledger they get.
 *
 * One function, called by the layout and by every route that touches personal data, so
 * the nav, the page and the API can never disagree about what a visitor may open or
 * whose rows they are looking at. Three places each deciding it independently is how a
 * page renders a tab that then refuses to load.
 *
 * Server-side only: it reads `next/headers`. Middleware has its own path because it runs
 * before any of this and holds the request directly — it is also where the visitor
 * identifier is minted, so by the time anything here runs the cookie exists.
 */
import { cookies } from "next/headers";

import { HOUSE, OWNER_COOKIE, ownerIdFor } from "./owner";
import { digest, roleFor, UNLOCK_COOKIE, type Role } from "./unlock";

export interface Session {
  role: Role;
  /** The ledger to read and write. Null only when nobody is signed in at all. */
  ownerId: string | null;
}

export async function currentSession(): Promise<Session> {
  // No passcode configured means the app is deliberately open -- see middleware -- and
  // the single visitor it was built for is the owner. The header says so in red.
  const passcode = process.env.APP_PASSCODE;
  if (!passcode) return { role: "owner", ownerId: HOUSE };

  const jar = await cookies();
  const viewerCode = process.env.APP_VIEWER_PASSCODE;
  const role = roleFor(
    jar.get(UNLOCK_COOKIE)?.value,
    await digest(passcode),
    viewerCode ? await digest(viewerCode) : null,
  );
  return { role, ownerId: ownerIdFor(role, jar.get(OWNER_COOKIE)?.value) };
}
