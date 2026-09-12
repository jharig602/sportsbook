import { NextResponse } from "next/server";

import { listBets } from "@/lib/bets-db";
import { qualifyingDates } from "@/lib/promo";
import { promoToday } from "@/lib/promo-plan";
import { promoDue, centralDate } from "@/lib/promo-window";
import { listSubscriptions, recordFailure } from "@/lib/push";
import { promoSentOn, recordPromoSent } from "@/lib/settings-db";

export const dynamic = "force-dynamic";


/**
 * The daily qualifying bet, and where to put the bonus it earns.
 *
 * This promotion inverts the usual question. Everywhere else the app asks "is there a
 * bet worth making" and answers no. Here six bets WILL be placed regardless, because
 * not placing them forfeits the bonus -- so the question is what the cheapest way to
 * satisfy it is, and the answer is routinely a negative number that is still correct
 * to act on.
 *
 * Both halves go in one notification. Splitting them would mean two buzzes a day for
 * one decision, and the bonus is the entire reason the $5 is being staked.
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

function priceLabel(price: number): string {
  return price > 0 ? `+${price}` : String(price);
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
  if (presented !== secret) return new NextResponse("Unauthorized.", { status: 401 });

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:alerts@example.com";
  if (!publicKey || !privateKey) {
    return new NextResponse("VAPID keys are not configured.", { status: 503 });
  }
  const params = new URL(request.url).searchParams;
  const dry = params.get("dry") === "1";
  const forced = params.get("force") === "1";

  // Once a day, decided here rather than by which minute a cron happened to fire.
  //
  // The step used to gate on the Central hour being 08 or 09, so it needed a scheduled
  // run to land in a two-hour slot. Over five days of real runs not one did: GitHub
  // delivers three to five a day at arbitrary minutes against the ~48 the weekend cron
  // asks for. The reminder had never once fired on its own.
  const now = new Date();
  const due = forced ? centralDate(now) : promoDue(now);
  if (!dry && due === null) {
    return NextResponse.json({ sent: 0, reason: "outside the reminder window" });
  }
  if (!dry && !forced && (await promoSentOn()) === due) {
    return NextResponse.json({ sent: 0, reason: "already sent today", date: due });
  }

  try {
    const [promo, subscriptions] = await Promise.all([promoToday(), listSubscriptions()]);
    const { qualifier, bonus, progress: done, worth: total } = promo;
    const { book: BOOK, stake: STAKE, face: BONUS_FACE } = promo;
    const DAYS = done.required;
    const logged = qualifyingDates(await listBets().catch(() => []), BOOK, STAKE);
    // `today` means "the next day still to qualify", so once today's bet is logged the
    // label runs a day ahead of itself and reads as tomorrow's reminder arriving early.
    // There is nothing to remind about either way: the bet is placed.
    const alreadyPlaced = due !== null && logged.includes(due);

    const parts: string[] = [];
    if (qualifier.pick) {
      const p = qualifier.pick;
      const line = p.line === null ? "" : ` ${p.line > 0 ? "+" : ""}${p.line}`;
      const team = p.side === "home" ? p.homeTeam : p.side === "away" ? p.awayTeam : p.side;
      parts.push(
        `$${STAKE}: ${team}${line} ${priceLabel(p.price ?? 0)} ` +
          `(${qualifier.beatsVig ? "+" : ""}${((p.expectedRoi ?? 0) * 100).toFixed(1)}%)`,
      );
    } else {
      parts.push(`$${STAKE}: nothing priced at ${BOOK} yet`);
    }
    if (bonus) {
      parts.push(
        `$${BONUS_FACE} bonus: ${bonus.candidate.team} ${priceLabel(bonus.price)} ` +
          `(worth ~$${bonus.value.toFixed(0)})`,
      );
    }

    // Nothing left to qualify for, so nothing to interrupt anyone about. Without this
    // the reminder simply runs for ever.
    if (done.complete && !forced && !dry) {
      return NextResponse.json({ sent: 0, reason: "promotion complete", done: done.done });
    }
    if (alreadyPlaced && !forced && !dry) {
      // Stamped so the day is closed out rather than re-offered by every later run.
      if (due !== null) await recordPromoSent(due);
      return NextResponse.json({ sent: 0, reason: "today's qualifier is already logged", done: done.done });
    }

    const dayLabel = done.today === null ? "complete" : `day ${done.today} of ${DAYS}`;
    const payload = JSON.stringify({
      title: `FanDuel promo — ${dayLabel}`,
      body: `${parts.join("  ·  ")}. Each $${STAKE} earns another $${BONUS_FACE}.`,
      tag: "promo-daily",
      renotify: true,
      url: "/shop?book=FanDuel",
    });

    if (dry || subscriptions.length === 0) {
      return NextResponse.json({
        sent: 0, dry, qualifier, bonus, promotionWorth: total, progress: done,
        subscribers: subscriptions.length,
      });
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

    // Stamped only once a device actually took it. Recording the date on a failed send
    // would burn the day and the reminder would simply never arrive.
    if (sent > 0 && !forced && due !== null) await recordPromoSent(due);

    return NextResponse.json({ sent, date: due, progress: done, qualifier, bonus, promotionWorth: total });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return new NextResponse(`Promo dispatch failed: ${message}`, { status: 500 });
  }
}
