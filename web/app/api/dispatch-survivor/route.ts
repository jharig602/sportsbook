import { NextResponse } from "next/server";

import { getData } from "@/lib/data";
import { listSubscriptions, recordFailure } from "@/lib/push";
import { seasonGames } from "@/lib/season-db";
import { getPools, recordSurvivorSent, survivorSent } from "@/lib/settings-db";
import { buildPlans, buildWeeks } from "@/lib/survivor";
import { windowFor, windowLabel } from "@/lib/survivor-window";

export const dynamic = "force-dynamic";

/**
 * Remind you who to pick, at the two moments before a Sunday 10am Central deadline
 * that are worth interrupting for.
 *
 * Sent on a schedule rather than on a change, which is the opposite of how the
 * cross-book alerts work, and deliberately: this is a deadline you can miss. "Still
 * the Chargers" is the useful message when you are deciding whether to look again, and
 * an alert that only fires on a change cannot say it.
 *
 * Guarded by the same shared secret as the other dispatchers, because it too makes the
 * phone buzz.
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
  if (presented !== secret) return new NextResponse("Unauthorized.", { status: 401 });

  const url = new URL(request.url);
  // `force` exists so the thing can be tested outside a Saturday night.
  const forced = url.searchParams.get("force");
  const window = forced === "saturday" || forced === "sunday"
    ? forced
    : windowFor(new Date());
  if (!window) {
    return NextResponse.json({ sent: 0, reason: "not a reminder window" });
  }

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:alerts@example.com";
  if (!publicKey || !privateKey) {
    return new NextResponse("VAPID keys are not configured.", { status: 503 });
  }

  try {
    const data = getData();
    const [models, games, pools, subscriptions] = await Promise.all([
      data.marginModels(),
      seasonGames("nfl"),
      getPools(),
      listSubscriptions(),
    ]);

    const weeks = buildWeeks(games, models.nfl ?? null);
    const priced = weeks.filter((w) => w.candidates.length > 0).length;
    const multi = buildPlans(weeks, pools, priced);

    const picks = multi.pools.map((entry) => ({
      pool: entry.pool.name,
      team: entry.plan.picks[0]?.pick?.team ?? null,
      probability: entry.plan.picks[0]?.pick?.winProbability ?? null,
    }));
    if (picks.every((p) => p.team === null)) {
      return NextResponse.json({ sent: 0, reason: "no pick available" });
    }

    // The week this slate is, by the same numbering the planner uses.
    const week = weeks.findIndex((w) => w.candidates.length > 0) + 1;

    if (!forced && (await survivorSent(week, window))) {
      return NextResponse.json({ sent: 0, reason: "already sent for this window" });
    }
    if (subscriptions.length === 0) {
      return NextResponse.json({ sent: 0, reason: "nobody subscribed" });
    }

    const body = picks
      .map((p) =>
        p.team
          ? `${p.pool}: ${p.team}${p.probability ? ` (${(p.probability * 100).toFixed(0)}%)` : ""}`
          : `${p.pool}: nothing available`,
      )
      .join("  ·  ");

    const payload = JSON.stringify({
      title: `Survivor week ${week} — ${windowLabel(window)}`,
      body: `${body}. Locks 10am Central.`,
      // One card per window, so Sunday's replaces nothing and Saturday's stays read.
      tag: `survivor-${week}-${window}`,
      renotify: true,
      url: "/survivor",
    });

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

    // Only stamped once a device actually received it; otherwise the reminder is lost
    // silently and the next tick would think it had already gone.
    if (sent > 0 && !forced) await recordSurvivorSent(week, window, picks);

    return NextResponse.json({ sent, week, window, picks });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return new NextResponse(`Survivor dispatch failed: ${message}`, { status: 500 });
  }
}
