/**
 * When a survivor reminder is worth sending.
 *
 * The deadline is 10am Central on Sunday. Two moments are worth interrupting for, and
 * they were chosen from the arithmetic rather than from habit:
 *
 * **Saturday evening.** By then Friday's injury report is public and the line has
 * absorbed it, which is most of the information that will ever exist before the
 * deadline. This is the reminder that actually decides the pick.
 *
 * **Sunday morning, two hours out.** Overnight drift only rarely moves a line the full
 * point needed to change a pick, so this is mostly a confirmation -- and a safety net
 * against forgetting. Sent whether or not anything changed, because "still the
 * Chargers" is the useful message when you are deciding whether to look again.
 *
 * Deliberately NOT later. NFL inactives publish 90 minutes before kickoff, which is
 * 11:30am Eastern, half an hour AFTER the deadline. There is no version of waiting
 * that reaches them, so there is nothing to be gained by cutting it finer.
 */

export type SurvivorWindow = "saturday" | "sunday";

/**
 * Which reminder window a moment falls in, if any.
 *
 * Central time is UTC-5 in September (CDT) and UTC-6 in winter (CST). Resolved via
 * `Intl` rather than a fixed offset so the November switch does not silently move both
 * reminders by an hour — the Sunday one sits two hours from a hard deadline and has no
 * margin to lose.
 */
export function windowFor(now: Date): SurvivorWindow | null {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    weekday: "short",
    hour: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const day = parts.find((p) => p.type === "weekday")?.value;
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);

  // Deliberately WIDE, and the reason is the scheduler rather than the football.
  //
  // These fire from the collect workflow, and GitHub delivers scheduled runs on a
  // private repo perhaps three to five times a day at arbitrary minutes -- not the ~48
  // the cron asks for on a weekend. Measured over five days, not one run landed inside
  // the old two-hour promo window, and these were the same shape. A narrow window does
  // not mean "remind me at 8pm", it means "remind me only if a run happens to land in
  // these three hours", which is a coin flip dressed up as a schedule.
  //
  // Sending once per window is enforced by `survivorSent`, so widening costs nothing:
  // the first run inside the range sends, the rest find it already recorded. What the
  // range has to preserve is the MEANING of each moment, and it does.
  //
  // 4pm-11pm Saturday: after the Friday injury report has been priced in. The earlier
  // start is still comfortably past it.
  if (day === "Sat" && hour >= 16 && hour <= 23) return "saturday";
  // 7am-9am Sunday, unchanged. This one cannot be widened the same way: earlier is
  // before dawn, and a push that wakes you is a push you turn off. So Saturday carries
  // the load -- which is the right way round anyway, since the module's own reasoning
  // is that Saturday night is the reminder that decides the pick and Sunday is a
  // confirmation. Sunday stays best-effort.
  if (day === "Sun" && hour >= 7 && hour <= 9) return "sunday";
  return null;
}

export function windowLabel(window: SurvivorWindow): string {
  return window === "saturday" ? "Saturday night" : "Sunday morning";
}

/** The Sunday 10am Central lock for the week containing this kickoff, as an instant. */
export function sundayLockFor(kickoffIso: string): Date | null {
  const kickoff = new Date(kickoffIso);
  if (Number.isNaN(kickoff.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
  }).formatToParts(kickoff);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  // Only a Sunday or Monday game pins down the week's Sunday. A Thursday-to-Saturday game
  // is before it, and that week's lock is still ahead.
  const back = get("weekday") === "Sun" ? 0 : get("weekday") === "Mon" ? 1 : null;
  if (back === null) return null;
  const day = Date.UTC(Number(get("year")), Number(get("month")) - 1, Number(get("day")) - back);
  // 10am Central is 15:00 UTC in daylight time and 16:00 in standard; take whichever
  // reads as 10am there, so the November switch cannot move the lock an hour.
  for (const utcHour of [15, 16]) {
    const at = new Date(day + utcHour * 3_600_000);
    const hour = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hourCycle: "h23" }).format(at);
    if (Number(hour) === 10) return at;
  }
  return null;
}

/**
 * Has this week's pick already locked?
 *
 * After the Sunday deadline a week's remaining games -- the Sunday and Monday night
 * games -- are still on the schedule, and a planner that kept the week would offer only
 * those few teams for a pick that was already made that morning. Locked weeks are
 * history, and the plan starts from the next one.
 */
export function pickLocked(kickoffs: string[], now: Date): boolean {
  for (const iso of kickoffs) {
    const lock = sundayLockFor(iso);
    if (lock) return now.getTime() >= lock.getTime();
  }
  return false;
}
