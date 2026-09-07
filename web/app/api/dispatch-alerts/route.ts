import { NextResponse } from "next/server";

import {
  alertNotification,
  listSubscriptions,
  markNotified,
  pendingAlerts,
  recordFailure,
} from "@/lib/push";

export const dynamic = "force-dynamic";

/**
 * Called by the collector after a poll. Sends one push per un-notified alert above the
 * strength floor, then stamps them so they are never sent twice.
 *
 * Guarded by a shared secret: this endpoint causes the user's phone to buzz, so it must
 * not be triggerable by anyone who finds the URL.
 */
export async function POST(request: Request) {
  const secret = process.env.ALERT_DISPATCH_SECRET;
  if (!secret) {
    return new NextResponse("ALERT_DISPATCH_SECRET is not configured.", { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new NextResponse("Unauthorized.", { status: 401 });
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:alerts@example.com";
  if (!publicKey || !privateKey) {
    return new NextResponse("VAPID keys are not configured.", { status: 503 });
  }

  const minStrength = Number(process.env.ALERT_MIN_STRENGTH ?? 60);

  try {
    const [alerts, subscriptions] = await Promise.all([
      pendingAlerts(minStrength),
      listSubscriptions(),
    ]);

    if (alerts.length === 0 || subscriptions.length === 0) {
      // Still stamp the alerts: with nobody subscribed there is no one to notify, and
      // leaving them pending would deliver a stale backlog the moment a device signs up.
      await markNotified(alerts.map((a) => a.alert_id));
      return NextResponse.json({
        sent: 0,
        alerts: alerts.length,
        subscribers: subscriptions.length,
      });
    }

    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(subject, publicKey, privateKey);

    let sent = 0;
    for (const alert of alerts) {
      const payload = JSON.stringify(alertNotification(alert));
      await Promise.all(
        subscriptions.map(async (subscription) => {
          try {
            await webpush.sendNotification(
              {
                endpoint: subscription.endpoint,
                keys: { p256dh: subscription.p256dh, auth: subscription.auth },
              },
              payload,
            );
            sent += 1;
          } catch {
            // A dead endpoint should not fail the batch; five strikes drops it.
            await recordFailure(subscription.endpoint);
          }
        }),
      );
    }

    await markNotified(alerts.map((a) => a.alert_id));
    return NextResponse.json({
      sent,
      alerts: alerts.length,
      subscribers: subscriptions.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return new NextResponse(`Dispatch failed: ${message}`, { status: 500 });
  }
}
