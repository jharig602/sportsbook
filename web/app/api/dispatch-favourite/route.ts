import { NextResponse } from "next/server";

import { planBacking, spreadOfOptions } from "@/lib/backing";
import { listBets } from "@/lib/bets-db";
import { buildBoardShop } from "@/lib/board-shop";
import { allBookLines } from "@/lib/book-lines";
import { openEvents } from "@/lib/daily-bet";
import { getData } from "@/lib/data";
import { describeCost, dueFavouriteGames, favouriteKey } from "@/lib/favourite-push";
import { formatKickoff } from "@/lib/format";
import { HOUSE } from "@/lib/owner";
import { promoDue } from "@/lib/promo-window";
import { listSubscriptions, recordFailure } from "@/lib/push";
import {
  favouritePushesSent,
  getFavourites,
  getMaxSpread,
  getMyBooks,
  recordFavouritePushSent,
} from "@/lib/settings-db";

export const dynamic = "force-dynamic";

/**
 * Your team's game this week: the cheapest way in, pushed before kickoff.
 *
 * Once per game per team, the first collector run in the thirty hours before kickoff and
 * inside the daytime window -- see `favourite-push.ts` for why a window and not a time.
 *
 * Not a tip. The decision to back your team is made before the app opens; the part still
 * open is which market and which book cost least, and that is what the message says.
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

  const publicKey = process.env.VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT ?? "mailto:alerts@example.com";
  if (!publicKey || !privateKey) {
    return new NextResponse("VAPID keys are not configured.", { status: 503 });
  }
  const dry = new URL(request.url).searchParams.get("dry") === "1";

  const now = new Date();
  // Daylight only. A run can land at any minute, and a buzz at 3 AM about Sunday's price
  // is not worth waking for when a later run will carry the same message at breakfast.
  if (!dry && promoDue(now) === null) {
    return NextResponse.json({ sent: 0, reason: "outside the daytime window" });
  }

  try {
    const data = getData();
    const [favourites, games, models, lines, myBooks, maxSpread, sent, ledger, results, subscriptions] =
      await Promise.all([
        getFavourites(),
        data.games(),
        data.marginModels(),
        allBookLines(),
        getMyBooks().catch(() => [] as string[]),
        getMaxSpread(),
        favouritePushesSent(),
        listBets(HOUSE).catch(() => []),
        data.results().catch(() => []),
        listSubscriptions(),
      ]);

    if (favourites.length === 0) {
      return NextResponse.json({ sent: 0, reason: "no teams chosen in My teams" });
    }

    const due = dueFavouriteGames(games, favourites, now, sent);
    if (due.length === 0) {
      return NextResponse.json({ sent: 0, reason: "no game of yours inside the window", favourites });
    }

    const shop = buildBoardShop(games, lines, models);
    const held = openEvents(ledger, new Set(results.map((r) => r.event_id)));
    const report: Array<Record<string, unknown>> = [];
    let sentTotal = 0;
    const webpush = dry ? null : (await import("web-push")).default;
    webpush?.setVapidDetails(subject, publicKey, privateKey);

    for (const game of due) {
      // Already bet it: the message would be advice about a decision already taken.
      // Not stamped, so a bet voided later still gets its reminder.
      if (held.has(game.eventId)) {
        report.push({ team: game.team, eventId: game.eventId, skipped: "already bet" });
        continue;
      }

      const plan = planBacking(
        shop.rows.filter((row) => row.eventId === game.eventId),
        game.team,
        { myBooks, maxSpread },
      );
      // No price yet: say nothing and leave the game unstamped, so the next run -- by
      // which time the books may have posted -- gets a chance. Announcing "no price" would
      // spend the one message on the least useful thing it could say.
      if (!plan.best) {
        report.push({ team: game.team, eventId: game.eventId, skipped: "not priced yet" });
        continue;
      }

      const { row, expectedRoi } = plan.best;
      const number =
        row.market === "moneyline" || row.line === null
          ? "ML"
          : `${row.line > 0 ? "+" : ""}${row.line}`;
      const price = row.price === null ? "" : ` ${row.price > 0 ? "+" : ""}${row.price}`;
      const saving = spreadOfOptions(plan);
      const savingText =
        saving !== null && saving >= 0.005
          ? ` — ${Math.round(saving * 100)}¢ per $1 cheaper than the worst way in.`
          : ".";

      const payload = JSON.stringify({
        title: `${game.team} this week`,
        body:
          `${game.home ? "vs" : "at"} ${game.opponent}, ${formatKickoff(game.commenceTime)}. ` +
          `Cheapest way to back them: ${number}${price} at ${row.book}, ` +
          `${describeCost(expectedRoi)}${savingText}`,
        tag: `favourite-${game.eventId}`,
        renotify: true,
        url: `/game/${game.eventId}`,
      });

      if (dry || !webpush || subscriptions.length === 0) {
        report.push({ team: game.team, eventId: game.eventId, dry: true, payload: JSON.parse(payload) });
        continue;
      }

      let delivered = 0;
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
            delivered += 1;
          } catch {
            await recordFailure(subscription.endpoint);
          }
        }),
      );
      // Stamped only once a device actually took it; a failed send must not spend the game.
      if (delivered > 0) await recordFavouritePushSent(favouriteKey(game.eventId, game.team));
      sentTotal += delivered;
      report.push({ team: game.team, eventId: game.eventId, delivered });
    }

    return NextResponse.json({ sent: sentTotal, subscribers: subscriptions.length, games: report });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
