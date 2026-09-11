/**
 * Weeks you have fixed by hand, carried in the URL.
 *
 * The point of pinning is the comparison, not the override. "Detroit in week 5" is only
 * interesting next to what the planner would have done instead and what the difference
 * costs, so a pin is a question rather than a setting — and questions belong in the URL,
 * not in a database. It survives a refresh, it can be sent to someone, and closing the
 * tab throws it away, which is the right lifetime for a what-if.
 *
 * This is deliberately NOT where "I actually picked Detroit" lives. That is a fact about
 * your entry, it goes through `PoolPicker` into `app_settings.used`, and confusing the
 * two would let an idle experiment quietly become a recorded history.
 *
 * Format is `week:team` pairs, comma separated: `1:Philadelphia Eagles,5:Detroit Lions`.
 * No NFL team name contains a comma or a colon, and anything that does not parse is
 * dropped rather than guessed at.
 */

/** Weeks a plan can have. Anything outside it is a malformed URL, not a pin. */
const MAX_WEEK = 30;
const MAX_PINS = 18;
const MAX_TEAM = 60;

export function parsePins(raw: string | string[] | undefined | null): Map<number, string> {
  const out = new Map<number, string>();
  if (raw === undefined || raw === null) return out;
  // Next hands back an array when a parameter repeats; treat that as more pairs.
  const text = Array.isArray(raw) ? raw.join(",") : raw;

  for (const part of text.split(",")) {
    const at = part.indexOf(":");
    if (at <= 0) continue;
    const week = Number(part.slice(0, at).trim());
    const team = part.slice(at + 1).trim().slice(0, MAX_TEAM);
    if (!Number.isInteger(week) || week < 1 || week > MAX_WEEK) continue;
    if (team.length === 0) continue;
    // First pin for a week wins, so a duplicated parameter cannot shuffle the answer.
    if (!out.has(week)) out.set(week, team);
    if (out.size >= MAX_PINS) break;
  }
  return out;
}

export function serializePins(pins: Map<number, string>): string {
  return [...pins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([week, team]) => `${week}:${team}`)
    .join(",");
}

/** Set or clear one week, returning a new map. `null` clears. */
export function withPin(
  pins: Map<number, string>,
  week: number,
  team: string | null,
): Map<number, string> {
  const next = new Map(pins);
  if (team === null) next.delete(week);
  else next.set(week, team);
  return next;
}
