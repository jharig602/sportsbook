/**
 * When the daily qualifying-bet reminder should go out.
 *
 * The first version asked a different question than it appeared to. It gated on the
 * Central hour being 08 or 09 and fired whenever a collect run landed inside it — which
 * reads like "remind me at 8am" and behaves like "remind me only if a scheduled run
 * happens to occur in these two hours".
 *
 * It never did. Measured over five days of real runs: the cron asks for five a day
 * midweek and about forty-eight at a weekend, and GitHub delivered three to five, at
 * arbitrary minutes, dropping the rest. Not one landed in the window. The reminder had
 * never fired on its own in the whole time it had existed.
 *
 * So the window is now the whole usable day and the "once" is enforced by remembering
 * the date instead. The first run after 8am Central sends; every later run that day
 * finds today already recorded and does nothing. That turns a coin flip into a near
 * certainty without buzzing anyone twice, because it stops depending on WHEN a run
 * happens and depends only on whether one happened at all.
 *
 * The bet itself is the reason this can be wide. A qualifying bet has to be placed some
 * time today, not at a particular minute — unlike the survivor pick, which has a hard
 * 10am lock and genuinely does care what time it is.
 */

const CENTRAL = "America/Chicago";

/** Hours, Central, in which a reminder is worth sending. */
const FIRST_HOUR = 8;
const LAST_HOUR = 20;

function parts(now: Date): { date: string; hour: number } {
  // en-CA gives YYYY-MM-DD, which sorts and compares as a plain string.
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: CENTRAL,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (type: string) => formatted.find((p) => p.type === type)?.value ?? "";
  // Midnight can come back as "24" in some runtimes; fold it to 0 rather than letting
  // it read as an hour past the end of the day.
  const hour = Number(get("hour")) % 24;
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour };
}

/** The Central calendar date, which is what "once a day" is counted in. */
export function centralDate(now: Date): string {
  return parts(now).date;
}

/**
 * The date a reminder is due for, or null if this moment is outside the day's window.
 *
 * Returning the date rather than a boolean is deliberate: the caller compares it against
 * what was last sent, and deriving the date separately from the decision is how the two
 * drift apart across a midnight boundary.
 */
export function promoDue(now: Date): string | null {
  const { date, hour } = parts(now);
  return hour >= FIRST_HOUR && hour <= LAST_HOUR ? date : null;
}
