import { NextResponse } from "next/server";

import { refuseUnlessDispatcher } from "@/lib/dispatch-auth";

import { dailyBet } from "@/lib/daily-bet-plan";
import { HOUSE } from "@/lib/owner";
import { centralDate, promoDue } from "@/lib/promo-window";
import { listSubscriptions, recordFailure } from "@/lib/push";
import { dailySentOn, recordDailySent } from "@/lib/settings-db";

export const dynamic = "force-dynamic";

/**
 * The bet of the day, pushed once a day -- and only when there is one.
 *
 * Replaces the promotion reminder, which fired every day because its bet was
 * compulsory. This one is not, so a day with nothing that clears the edge sends
 * nothing: a notification that arrives daily regardless is one you stop reading.
 *
 * Same once-a-day mechanics the reminder earned the hard way: GitHub delivers a handful
 * of runs a day at arbitrary minutes, so the endpoint decides, and remembers the Central
 * date it last sent. Every run offers; the first one inside the window with a real bet
 * takes it. A day that has no bet at 8am is left open, so one that appears at noon
 * still goes out.
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
  const params = new URL(request.url).searchParams;
  const dry = params.get("dry") === "1";
  const forced = params.get("force") === "1";

  const now = new Date();
  const due = forced ? centralDate(now) : promoDue(now);
  if (!dry && due === null) {
    return NextResponse.json({ sent: 0, reason: "outside the daily window" });
  }
  if (!dry && !forced && (await dailySentOn()) === due) {
    return NextResponse.json({ sent: 0, reason: "already sent today", date: due });
  }

  try {
    // The owner's ledger: this runs from cron, with no request and so no cookie.
    const [view, subscriptions] = await Promise.all([dailyBet(HOUSE), listSubscriptions()]);
    const candidate = view.pick;
    if (!candidate) {
      // Deliberately not stamped: the board can change later in the day.
      return NextResponse.json({ sent: 0, reason: view.reason, considered: view.considered });
    }

    const { row, p, roi } = candidate;
    const who =
      row.side === "home" ? row.homeTeam : row.side === "away" ? row.awayTeam : row.side === "over" ? "Over" : "Under";
    const number =
      row.market === "moneyline" || row.line === null
        ? " ML"
        : ` ${row.market === "spread" && row.line > 0 ? "+" : ""}${row.line}`;
    const price = row.price === null ? "" : ` ${row.price > 0 ? "+" : ""}${row.price}`;
    // The parlay rides along in the same notification: one decision, one buzz.
    const parlay = view.parlay;
    const parlayText = parlay
      ? `  ·  Parlay: ${parlay.legs
          .map((leg) =>
            leg.row.side === "home" ? leg.row.homeTeam : leg.row.side === "away" ? leg.row.awayTeam : leg.row.side,
          )
          .join(" + ")} ${parlay.price > 0 ? "+" : ""}${parlay.price} (~${Math.round(parlay.p * 100)}%)`
      : "";
    const payload = JSON.stringify({
      title: "Bet of the day",
      body:
        `${who}${number}${price} at ${row.book} — wins ~${Math.round(p * 100)}%, ` +
        `+${(roi * 100).toFixed(1)}% expected.${parlayText}`,
      tag: "bet-of-the-day",
      renotify: true,
      url: "/shop",
    });

    if (dry || subscriptions.length === 0) {
      return NextResponse.json({ sent: 0, dry, pick: candidate, subscribers: subscriptions.length });
    }

    const webpush = (await import("web-push")).default;
    webpush.setVapidDetails(subject, publicKey, privateKey);
    let sent = 0;
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
          await recordFailure(subscription.endpoint);
        }
      }),
    );

    // Stamped only once a device actually took it; a failed send must not burn the day.
    if (sent > 0 && !forced && due !== null) await recordDailySent(due);
    return NextResponse.json({ sent, date: due, pick: candidate });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return new NextResponse(`Daily dispatch failed: ${message}`, { status: 500 });
  }
}
