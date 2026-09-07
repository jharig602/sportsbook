import { NextResponse } from "next/server";

import { listSubscriptions, recordFailure } from "@/lib/push";

export const dynamic = "force-dynamic";

/**
 * Send a test notification to every subscribed device.
 *
 * Storing a subscription and actually delivering to it are different things — a
 * mismatched VAPID pair or a broken service-worker push handler both leave the
 * subscription looking perfectly healthy. Without this, the first proof that delivery
 * works would be a real alert failing to arrive, which is unfalsifiable at the moment
 * it matters.
 *
 * Unguarded by the dispatch secret on purpose: it only ever reaches devices that
 * deliberately subscribed through this app, which are the owner's own. The worst
 * someone can do with it is send the owner a notification saying it was a test.
 */
export async function POST() {
  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:alerts@example.com";

  if (!publicKey || !privateKey) {
    return NextResponse.json(
      { ok: false, error: "VAPID keys are not configured on the server." },
      { status: 503 },
    );
  }

  try {
    const subscriptions = await listSubscriptions();
    if (subscriptions.length === 0) {
      return NextResponse.json(
        { ok: false, error: "No device is subscribed yet." },
        { status: 409 },
      );
    }

    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(subject, publicKey, privateKey);

    const payload = JSON.stringify({
      title: "Line Tracker test",
      body: "Notifications are working. Real alerts look like this.",
      tag: "test-notification",
      renotify: true,
      url: "/movers",
    });

    let sent = 0;
    const failures: string[] = [];
    for (const subscription of subscriptions) {
      try {
        await webpush.sendNotification(
          {
            endpoint: subscription.endpoint,
            keys: { p256dh: subscription.p256dh, auth: subscription.auth },
          },
          payload,
        );
        sent += 1;
      } catch (error) {
        await recordFailure(subscription.endpoint);
        // Surfaced rather than swallowed: this endpoint exists to reveal exactly this.
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }

    return NextResponse.json({ ok: sent > 0, sent, subscribers: subscriptions.length, failures });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
