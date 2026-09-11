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
