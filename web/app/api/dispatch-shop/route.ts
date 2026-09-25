import { NextResponse } from "next/server";

import { refuseUnlessDispatcher } from "@/lib/dispatch-auth";

import { allBookLines } from "@/lib/book-lines";
import { buildBoardShop } from "@/lib/board-shop";
import { getData } from "@/lib/data";
import { listSubscriptions, recordFailure } from "@/lib/push";
import { getMyBooks, notifiedOffers, recordNotified } from "@/lib/settings-db";
import { selectAlerts, shopNotification, notificationRecord } from "@/lib/shop-alerts";
import { recordLineCensus } from "@/lib/census";
import { activeRuleVersion, recordShopPicks } from "@/lib/shop-picks";

export const dynamic = "force-dynamic";

/**
 * Push a notification when a cross-book gap at one of your books clears the vig.
 *
 * Called by the collector after each poll. Guarded by the same shared secret as the
 * line-move dispatcher, because this too makes the phone buzz and must not be
 * triggerable by anyone who finds the URL.
 *
 * The bar is set in `shop-alerts.ts` and is deliberately higher than the bar for
 * showing a row on a page: a page is read when you choose to read it, a notification
 * interrupts. Every offer already sent is recorded, so the same one never buzzes
 * twice and only a materially better version of it buzzes again.
 *
 * It is also where every positive edge is written down as a falsifiable prediction,
 * because this is the only place the real board is computed on a schedule rather than
 * when somebody opens a page. Recording runs BEFORE any notification concern and does
 * not depend on one: the measurement must not switch itself off because the push keys
 * are missing, which is how the cross-book rule went a whole season ungraded.
 */
export async function POST(request: Request) {
  const denied = await refuseUnlessDispatcher(request);
  if (denied) return denied;

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:alerts@example.com";

  try {
    const data = getData();
    const [games, models, lines, myBooks, alreadySent, subscriptions, ruleVersion] =
      await Promise.all([
        data.games(),
        data.marginModels(),
        allBookLines(),
        getMyBooks(),
        notifiedOffers(),
        listSubscriptions(),
        activeRuleVersion(),
      ]);

    const shop = buildBoardShop(games, lines, models);

    // Every row the rule calls profitable, not just the ones loud enough to notify.
    // The notification bar measures the notification bar; this measures the rule.
    const recorded = ruleVersion
      ? await recordShopPicks(shop.positive, ruleVersion).catch(() => null)
      : null;

    // And every line it could compare at all, including the ones it says not to bet.
    //
    // The picks above are written the first moment an edge turns positive, which selects
    // for the estimate being noisy-high -- such a sample underperforms its own estimate
    // even when the rule is sound, and from inside it there is no way to tell how much of
    // the shortfall is the selection. The census has no such filter, so the negative rows
    // are what make the positive ones interpretable.
    const censused = ruleVersion
      ? await recordLineCensus(shop.rows, ruleVersion).catch(() => null)
      : null;

    // Only now does anything depend on push being configured.
    if (!publicKey || !privateKey) {
      return NextResponse.json(
        { sent: 0, recorded: recorded?.written ?? 0, censused: censused?.written ?? 0,
          note: "VAPID keys are not configured." },
        { status: 200 },
      );
    }

    const picked = selectAlerts(shop.rows, myBooks, alreadySent);

    if (picked.length === 0) {
      return NextResponse.json({
        sent: 0,
        candidates: 0,
        books: myBooks.length,
        recorded: recorded?.written ?? 0,
        censused: censused?.written ?? 0,
        positive: shop.positive.length,
      });
    }

    // Nothing is recorded as notified when there is nobody to notify: the offer is
    // still live, and stamping it now would mean the first device to subscribe never
    // hears about it.
    if (subscriptions.length === 0) {
      return NextResponse.json({
        sent: 0,
        candidates: picked.length,
        subscribers: 0,
        recorded: recorded?.written ?? 0,
        note: "nothing recorded as sent; these will notify once a device subscribes",
      });
    }

    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(subject, publicKey, privateKey);

    // A cap, because a notification you scroll past is one you learn to ignore. The
    // rest stay unrecorded and will be picked up on the next poll if still live.
    const batch = picked.slice(0, 5);
    let sent = 0;
    const delivered: typeof batch = [];

    for (const decision of batch) {
      const payload = JSON.stringify(shopNotification(decision));
      let anyDelivered = false;
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
            anyDelivered = true;
          } catch {
            await recordFailure(subscription.endpoint);
          }
        }),
      );
      // Only an offer that actually reached a device counts as told. Recording a
      // failed send would suppress the retry and lose the alert silently.
      if (anyDelivered) delivered.push(decision);
    }

    await recordNotified(delivered.map(notificationRecord));

    return NextResponse.json({
      sent,
      candidates: picked.length,
      notified: delivered.length,
      subscribers: subscriptions.length,
      books: myBooks.length,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return new NextResponse(`Shop dispatch failed: ${message}`, { status: 500 });
  }
}
