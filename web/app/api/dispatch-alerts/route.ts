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
/**
 * Tolerate the ways a secret gets mangled on its way into an environment variable:
 * a trailing newline from the clipboard, surrounding quotes, or the whole
 * `NAME=value` line pasted into the value box. Each produces a silent 401 that looks
 * identical to a genuinely wrong secret, and the workflow logs it without failing —
 * so notifications would just never arrive, with nothing obviously broken.
 */
function normaliseSecret(raw: string | undefined | null): string | null {
  if (!raw) return null;
  let value = raw.trim();
  if (value.startsWith("ALERT_DISPATCH_SECRET=")) {
    value = value.slice("ALERT_DISPATCH_SECRET=".length).trim();
  }
  if (value.length >= 2 && value[0] === value.at(-1) && (value[0] === '"' || value[0] === "'")) {
    value = value.slice(1, -1).trim();
  }
  return value || null;
}

export async function POST(request: Request) {
  const secret = normaliseSecret(process.env.ALERT_DISPATCH_SECRET);
  if (!secret) {
    return new NextResponse("ALERT_DISPATCH_SECRET is not configured.", { status: 503 });
  }

  const header = request.headers.get("authorization") ?? "";
  const presented = normaliseSecret(
    header.toLowerCase().startsWith("bearer ") ? header.slice(7) : header,
  );
  if (presented !== secret) {
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
