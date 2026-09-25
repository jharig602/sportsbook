import { NextResponse } from "next/server";

import { listBets } from "@/lib/bets-db";
import { getData } from "@/lib/data";
import { refuseUnlessDispatcher } from "@/lib/dispatch-auth";
import { HOUSE } from "@/lib/owner";
import { listSubscriptions, recordFailure } from "@/lib/push";
import { quietHours, resultsToAnnounce, SUMMARY_OVER, summarise } from "@/lib/result-push";
import type { Score } from "@/lib/settle";
import { recordResultPushesSent, resultPushesSent } from "@/lib/settings-db";

export const dynamic = "force-dynamic";

/**
 * Won, lost or pushed: one notification per ticket once its game is final.
 *
 * Runs after the collector has captured final scores, reads the owner's ledger only, and
 * remembers what it has announced. See `result-push.ts` for the rules.
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

  const now = new Date();
  // Held, not dropped: nothing is stamped, so the first run after 8 AM carries it.
  if (!dry && quietHours(now)) {
    return NextResponse.json({ sent: 0, reason: "overnight; held until morning" });
  }

  try {
    const [bets, results, sent, subscriptions] = await Promise.all([
      // The owner's ledger only. A guest's bets are theirs, and announcing them to the
      // owner's phone would be a leak dressed as a feature.
      listBets(HOUSE),
      getData().results(),
      resultPushesSent(),
      listSubscriptions(),
    ]);

    const scores = new Map<string, Score>(
      results.map((r) => [r.event_id, { home_score: r.home_score, away_score: r.away_score }]),
    );
    const messages = resultsToAnnounce(bets, scores, now, sent);
    // Counts only in the response: the collector prints it into GitHub Actions logs,
    // which are public for this repository, and what you won or lost is nobody's business.
    if (messages.length === 0) return NextResponse.json({ sent: 0, announced: 0 });

    // Several results at once become one summary rather than a pile of buzzes.
    const payloads =
      messages.length > SUMMARY_OVER
        ? [{ ...summarise(messages), tag: "results-summary", url: "/bets" }]
        : messages.map((m) => ({
            title: m.title,
            body: m.body,
            tag: `result-${m.key}`,
            url: "/bets",
          }));

    if (dry || subscriptions.length === 0) {
      return NextResponse.json({
        sent: 0,
        announced: messages.length,
        subscribers: subscriptions.length,
        ...(dry ? { previews: payloads } : {}),
      });
    }

    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(subject, publicKey, privateKey);

    let delivered = 0;
    for (const payload of payloads) {
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
              },
              JSON.stringify({ ...payload, renotify: true }),
            );
            delivered += 1;
          } catch {
            await recordFailure(subscription.endpoint);
          }
        }),
      );
    }

    // Stamped only once something reached a device; a failed send must not lose a result.
    if (delivered > 0) await recordResultPushesSent(messages.map((m) => m.key));
    return NextResponse.json({ sent: delivered, announced: messages.length });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
