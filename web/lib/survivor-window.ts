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

  // 8pm-11pm Saturday: the Friday report is in and the line has moved on it.
  if (day === "Sat" && hour >= 20 && hour <= 23) return "saturday";
  // 7am-9am Sunday: a confirmation, comfortably before a 10am lock.
  if (day === "Sun" && hour >= 7 && hour <= 9) return "sunday";
  return null;
}

export function windowLabel(window: SurvivorWindow): string {
  return window === "saturday" ? "Saturday night" : "Sunday morning";
}
