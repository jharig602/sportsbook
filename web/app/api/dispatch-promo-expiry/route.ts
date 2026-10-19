import { NextResponse } from "next/server";

import { DEFAULT_MAX_SPREAD } from "@/lib/blowout";
import { allBookLines } from "@/lib/book-lines";
import { findBoosts } from "@/lib/boost-finder";
import { getData } from "@/lib/data";
import { refuseUnlessDispatcher } from "@/lib/dispatch-auth";
import { formatPrice } from "@/lib/format";
import { HOUSE } from "@/lib/owner";
import { duePromoReminders, promoReminderKey, timeLeft } from "@/lib/promo-expiry";
import { promoDue } from "@/lib/promo-window";
import { listPromos } from "@/lib/promos-db";
import { listSubscriptions, recordFailure } from "@/lib/push";
import { getFavourites, getTax, promoRemindersSent, recordPromoReminderSent } from "@/lib/settings-db";
import { DEFAULT_TAX } from "@/lib/tax";
import type { Promo } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * A promo token about to lapse unused: one push per token, in the day before it expires,
 * daytime only (promo-expiry.ts). For a profit boost or a bonus bet the message names the
 * best use on the board right now -- the same ranking as the Promos page's finders -- so
 * the push can be acted on without opening anything.
 *
 * Owner's promos only (`HOUSE`). The response lands in PUBLIC Actions logs, so it is
 * counts only; a manual dry run (?dry=1, needs the secret) returns the messages.
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
  if (!dry && promoDue(now) === null) {
    return NextResponse.json({ sent: 0, reason: "outside the daytime window" });
  }

  try {
    const [promos, sent, subscriptions] = await Promise.all([
      listPromos(HOUSE),
      promoRemindersSent(),
      listSubscriptions(),
    ]);
    const due = duePromoReminders(promos, now, sent);
    if (due.length === 0) return NextResponse.json({ sent: 0, due: 0 });

    // The board, once, only if a token can use it.
    const needsBoard = due.some((p) => p.type === "profit_boost" || p.type === "bonus_bet");
    const data = getData();
    const board = needsBoard
      ? await Promise.all([
          data.games(),
          allBookLines(),
          data.marginModels(),
          data.scoreModels().catch(() => ({})),
          getFavourites().catch(() => [] as string[]),
          getTax().catch(() => DEFAULT_TAX),
        ])
      : null;

    const bestUse = (promo: Promo): string => {
      if (!board) return "";
      const [games, lines, models, scoreModels, favourites, tax] = board;
      const bonus = promo.type === "bonus_bet";
      if (!bonus && promo.type !== "profit_boost") return "";
      const stake = bonus ? promo.bonus_face ?? 25 : promo.max_stake ?? 25;
      const { checked } = findBoosts(games, lines, models, scoreModels, {
        book: promo.book,
        boost: bonus ? 0 : promo.boost_pct ?? 0.5,
        stake,
        favourites,
        maxSpread: DEFAULT_MAX_SPREAD,
        tax,
        bonus,
      });
      const pick = checked.find((p) => p.afterTax > 0);
      if (!pick) return " Nothing on the board stands out for it right now.";
      return ` Best use now: ${pick.label} ${formatPrice(pick.price)}, worth about $${pick.afterTax.toFixed(2)} after tax.`;
    };

    const webpush = dry ? null : (await import("web-push")).default;
    webpush?.setVapidDetails(subject, publicKey, privateKey);
    const previews: unknown[] = [];
    let sentTotal = 0;
    let announced = 0;

    for (const promo of due) {
      const payload = JSON.stringify({
        title: `${promo.book}: ${promo.title} expires ${timeLeft(promo.expires_at, now)}`,
        body: `Unused tokens are the one promo that costs real money.${bestUse(promo)}`,
        tag: `promo-${promo.promo_id}`,
        renotify: true,
        url: promo.type === "bonus_bet" ? "/promos#bonus" : promo.type === "profit_boost" ? "/promos#boost" : "/promos",
      });
      if (dry || !webpush || subscriptions.length === 0) {
        if (dry) previews.push(JSON.parse(payload));
        continue;
      }
      let delivered = 0;
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
      // Stamped only once a device took it; a failed send must not spend the reminder.
      if (delivered > 0) {
        await recordPromoReminderSent(promoReminderKey(promo));
        announced += 1;
      }
      sentTotal += delivered;
    }

    return NextResponse.json({
      sent: sentTotal,
      due: due.length,
      announced,
      subscribers: subscriptions.length,
      ...(dry ? { previews } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : "unknown error" }, { status: 500 });
  }
}
