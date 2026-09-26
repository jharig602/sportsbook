import { NextResponse } from "next/server";

import { listBets } from "@/lib/bets-db";
import { getData } from "@/lib/data";
import { refuseUnlessDispatcher } from "@/lib/dispatch-auth";
import { kickoffsToAnnounce } from "@/lib/kickoff-push";
import { HOUSE } from "@/lib/owner";
import { listSubscriptions, recordFailure } from "@/lib/push";
import type { Score } from "@/lib/settle";
import { kickoffPushesSent, recordKickoffPushesSent } from "@/lib/settings-db";

export const dynamic = "force-dynamic";

/**
 * A game you have money on is starting: one push per game.
 *
 * Called by `kickoff-watch.yml`, which sleeps until `next` and calls again. See
 * `kickoff-push.ts` for the rules.
 */
export async function POST(request: Request) {
  const denied = await refuseUnlessDispatcher(request);
  if (denied) return denied;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:alerts@example.com";
  if (!publicKey || !privateKey) {
    return new NextResponse("VAPID keys are not configured.", { status: 503 });
  }
  const dry = new URL(request.url).searchParams.get("dry") === "1";

  try {
    const [bets, results, sent, subscriptions] = await Promise.all([
      // The owner's ledger only: a guest's bets are theirs.
      listBets(HOUSE),
      getData().results(),
      kickoffPushesSent(),
      listSubscriptions(),
    ]);
    const scores = new Map<string, Score>(
      results.map((r) => [r.event_id, { home_score: r.home_score, away_score: r.away_score }]),
    );
    const { messages, next } = kickoffsToAnnounce(bets, scores, new Date(), sent);

    // Counts and a wait only: the watcher runs in GitHub Actions, whose logs are public
    // for this repository, and which games you have bet on is nobody's business.
    if (dry || messages.length === 0 || subscriptions.length === 0) {
      return NextResponse.json({
        sent: 0,
        announced: messages.length,
        next,
        ...(dry ? { previews: messages } : {}),
      });
    }

    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(subject, publicKey, privateKey);

    let delivered = 0;
    for (const message of messages) {
      const payload = JSON.stringify({
        title: message.title,
        body: message.body,
        tag: `kickoff-${message.eventId}`,
        url: `/game/${message.eventId}`,
      });
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await webpush.sendNotification(
              { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
              payload,
            );
            delivered += 1;
          } catch {
            await recordFailure(subscription.endpoint);
          }
        }),
      );
    }

    // Stamped only once something reached a device, so a failed send can retry on the
    // next call while the game is still inside its window.
    if (delivered > 0) await recordKickoffPushesSent(messages.map((m) => m.key));
    return NextResponse.json({ sent: delivered, announced: messages.length, next });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
