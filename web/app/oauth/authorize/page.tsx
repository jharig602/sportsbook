import { headers } from "next/headers";

import { ConnectorConsent } from "@/components/ConnectorConsent";
import { Banner, Card, PageHeader } from "@/components/ui";
import { loopbackAllowed, parseAuthorize } from "@/lib/oauth";
import { findClient } from "@/lib/oauth-db";
import { currentSession } from "@/lib/session";

export const dynamic = "force-dynamic";

/**
 * Where Claude sends you to approve the connector.
 *
 * Behind the passcode like every page: arriving signed out goes through /unlock and comes
 * back here with the query intact. A guest passcode is bounced by middleware before this
 * renders, and refused again by the approve route, so only the owner can ever connect.
 */
export default async function AuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const params: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    const one = Array.isArray(value) ? value[0] : value;
    if (typeof one === "string") params[key] = one;
  }
  const head = await headers();
  const host = head.get("x-forwarded-host") ?? head.get("host") ?? "";
  const proto = head.get("x-forwarded-proto") ?? "https";
  const origin = `${proto.split(",")[0]}://${host.split(",")[0]}`;

  const session = await currentSession();
  const allowLoopback = loopbackAllowed();
  const parsed = parseAuthorize(params, `${origin}/api/mcp`, allowLoopback);
  const client = parsed.ok ? await findClient(parsed.request.clientId, allowLoopback).catch(() => null) : null;
  const problem =
    session.role !== "owner"
      ? "Only the owner passcode can connect Claude."
      : !parsed.ok
        ? parsed.error
        : !client || !client.redirect_uris.includes(parsed.request.redirectUri)
          ? "This connection request is not from a client registered here. Start again from Claude."
          : null;

  const redirectHost = parsed.ok ? new URL(parsed.request.redirectUri).host : null;
  return (
    <>
      <PageHeader title="Connect Claude" subtitle="Let Claude read Dissent from your chats" />
      {problem ? (
        <Banner tone="error">{problem}</Banner>
      ) : (
        <Card className="px-3.5 py-3">
          <p className="text-[13px] leading-relaxed text-slate-300">
            <span className="font-medium text-slate-100">{client?.client_name ?? "A client"}</span> wants
            read-only access to Dissent: the shop, boost and bonus-bet finders, game pages, your
            open bets and record, promos and survivor picks.
          </p>
          <p className="mt-2 text-[12px] leading-relaxed text-slate-500">
            It cannot log bets, change promos or touch settings. Access lasts an hour at a time
            and renews for up to 30 days; disconnect any time in Settings. The approval goes back
            to <span className="text-slate-300">{redirectHost}</span>.
          </p>
          <ConnectorConsent params={params} />
        </Card>
      )}
    </>
  );
}
