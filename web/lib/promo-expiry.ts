/**
 * Promo tokens about to lapse unused -- the one promo loss that costs real money.
 *
 * The promo tracker sorts by expiry, but a list only helps when it is opened. This picks
 * the tokens worth a push: still available, expiring within `windowHours`, and not
 * already announced. One push per token: a second about the same boost is noise.
 *
 * The window is wide (a day) for the same reason every time-gated push here is: GitHub
 * delivers collector runs at arbitrary minutes, and a narrow window is one no run lands
 * in. The daytime gate (`promoDue`) is applied by the dispatcher, so a token expiring at
 * 3 AM is announced the afternoon before.
 */
import type { Promo } from "./types";

export const PROMO_EXPIRY_WINDOW_HOURS = 24;

export const promoReminderKey = (promo: Pick<Promo, "promo_id">) => `promo:${promo.promo_id}`;

export function duePromoReminders(
  promos: Promo[],
  now: Date,
  sent: Set<string>,
  windowHours = PROMO_EXPIRY_WINDOW_HOURS,
): Promo[] {
  const until = now.getTime() + windowHours * 3_600_000;
  return promos
    .filter((p) => p.status === "available")
    .filter((p) => {
      const at = Date.parse(p.expires_at);
      return Number.isFinite(at) && at > now.getTime() && at <= until;
    })
    .filter((p) => !sent.has(promoReminderKey(p)))
    .sort((a, b) => a.expires_at.localeCompare(b.expires_at));
}

/** "in 5 hours", "in 40 minutes": how long is left, in words a notification can carry. */
export function timeLeft(expiresAt: string, now: Date): string {
  const minutes = Math.max(0, Math.round((Date.parse(expiresAt) - now.getTime()) / 60_000));
  if (minutes < 90) return `in ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.round(minutes / 60);
  return `in ${hours} hour${hours === 1 ? "" : "s"}`;
}
