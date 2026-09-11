import { NextResponse } from "next/server";

import { listBets } from "@/lib/bets-db";
import { allBookLines } from "@/lib/book-lines";
import { buildBoardShop } from "@/lib/board-shop";
import { getData } from "@/lib/data";
import { winProbabilityFromSpread } from "@/lib/probability";
import { bestBonusTarget, bestQualifier, progress, promoValue, qualifyingDates } from "@/lib/promo";
import { promoDue, centralDate } from "@/lib/promo-window";
import { listSubscriptions, recordFailure } from "@/lib/push";
import { promoSentOn, recordPromoSent } from "@/lib/settings-db";
import type { Candidate } from "@/lib/survivor";

export const dynamic = "force-dynamic";

const BOOK = "FanDuel";
const STAKE = 5;
const BONUS_FACE = 50;
const DAYS = 7;   // seven qualifying bets, each earning its own $50

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
    const data = getData();
    const [games, models, lines, subscriptions, ledger] = await Promise.all([
      data.games(),
      data.marginModels(),
      allBookLines(),
      listSubscriptions(),
      listBets().catch(() => []),
    ]);

    // Which qualifying day this is, counted from bets actually logged rather than from
    // the calendar. A day you forgot is a day that did not count -- the book is not
    // going to award the bonus for a bet you did not place, and a tracker that assumed
    // otherwise would announce completion while it was still unearned. The cost of that
    // honesty is that the count is only as good as the logging, which the push says.
    const done = progress(qualifyingDates(ledger, BOOK, STAKE), DAYS);

    const shop = buildBoardShop(games, lines, models);
    const qualifier = bestQualifier(shop.rows, BOOK, STAKE);

    // Bonus candidates: every moneyline this book offers, priced with OUR model's
    // probability rather than the one implied by the price. The implied number carries
    // the favourite-longshot bias, which would push every recommendation toward
    // +5000 shots that win far less often than they are priced to.
    const targets: Array<{ candidate: Candidate; price: number }> = [];
    for (const game of games) {
      const model = models[game.league];
      const spread = game.spread?.home?.line;
      if (!model || spread === null || spread === undefined) continue;
      if (new Date(game.commenceTime).getTime() <= Date.now()) continue;

      for (const side of ["home", "away"] as const) {
        const quotes = lines.get(game.eventId) ?? [];
        const mine = quotes.find(
          (q) => q.book === BOOK && q.market === "moneyline" && q.side === side,
        );
        const price = mine?.price ?? game.moneyline?.[side]?.price ?? null;
        if (price === null) continue;
        const probability = winProbabilityFromSpread(model, spread, side);
        if (probability === null) continue;
        targets.push({
          candidate: {
            team: (side === "home" ? game.homeTeam : game.awayTeam) ?? "?",
            opponent: (side === "home" ? game.awayTeam : game.homeTeam) ?? "?",
            home: side === "home",
            winProbability: probability,
            spread: side === "home" ? spread : -spread,
            commenceTime: game.commenceTime,
            eventId: game.eventId,
          },
          price,
        });
      }
    }
    const bonus = bestBonusTarget(targets, BONUS_FACE);

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

    const total = promoValue(qualifier.expectedProfit, DAYS, bonus?.value ?? 0);

    // Nothing left to qualify for, so nothing to interrupt anyone about. Without this
    // the reminder simply runs for ever.
    if (done.complete && !forced && !dry) {
      return NextResponse.json({ sent: 0, reason: "promotion complete", done: done.done });
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
