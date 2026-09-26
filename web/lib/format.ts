import type { Market, Side } from "./types";

const EM_DASH = "—";

/** American price: always signed, em-dash when absent. */
export function formatPrice(price: number | null | undefined): string {
  if (price === null || price === undefined) return EM_DASH;
  return price > 0 ? `+${price}` : `${price}`;
}

/**
 * Handicaps carry a sign; totals are magnitudes. Rendering a total as "+42.5" makes it
 * read like a spread, which is the kind of thing you only misread once with money on it.
 */
export function formatLine(
  market: Market,
  side: Side,
  line: number | null | undefined,
): string {
  if (line === null || line === undefined) return EM_DASH;
  if (market === "total") return `${side === "under" ? "u" : "o"}${line}`;
  if (market === "moneyline") return EM_DASH;
  return line > 0 ? `+${line}` : `${line}`;
}

/** Break-even probability implied by an American price, vig included. */
export function impliedProbability(price: number | null | undefined): number | null {
  if (price === null || price === undefined || Math.abs(price) < 100) return null;
  const decimal = price > 0 ? 1 + price / 100 : 1 + 100 / -price;
  return 1 / decimal;
}

export function formatPercent(value: number | null, digits = 0): string {
  if (value === null || Number.isNaN(value)) return EM_DASH;
  return `${(value * 100).toFixed(digits)}%`;
}

export function formatSigned(value: number | null, digits = 1): string {
  if (value === null || value === undefined) return EM_DASH;
  const fixed = value.toFixed(digits);
  return value > 0 ? `+${fixed}` : fixed;
}

const KIND_LABELS: Record<string, string> = {
  first_price: "First price",
  steam: "Steam",
  key_number: "Key number",
  drift: "Drift",
};

export function formatKind(kind: string): string {
  return KIND_LABELS[kind] ?? kind;
}

export function formatLeague(league: string): string {
  return league === "ncaaf" ? "NCAAF" : league.toUpperCase();
}

/**
 * The zone every displayed time is rendered in.
 *
 * Pinned rather than left to the runtime, because `toLocaleString(undefined, ...)` uses
 * the SERVER's zone in a server component — and these pages are server-rendered on
 * Vercel, where that is UTC. Every kickoff was being shown hours late: Sunday's 1pm
 * Eastern games read as "5:00 PM", which is not a cosmetic error when the survivor
 * deadline is 11am Eastern and a game you think you have all afternoon to decide on has
 * in fact already kicked off.
 *
 * Eastern because the owner asked for it (2026-09-26): it is the zone the books, the
 * networks and the league schedule all quote, so a time here matches the one on the
 * slip. One fixed zone beats the viewer's own: a server-rendered page has no access to
 * the viewer's zone anyway, so the alternative is not "their time" but "whatever machine
 * rendered it".
 *
 * Display only. The push windows (quiet hours, the morning sends, the survivor
 * reminders) still run on Central, because they are about when the owner is awake, not
 * about how a kickoff reads.
 */
export const DISPLAY_TIME_ZONE = "America/New_York";

export function formatKickoff(iso: string | null): string {
  if (!iso) return EM_DASH;
  return new Date(iso).toLocaleString("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/**
 * The calendar day a kickoff belongs to, for grouping.
 *
 * Same fix, and it matters more here: grouping on the server's UTC day files a Saturday
 * 9pm Eastern game under Sunday, because 9pm Eastern is already 01:00 UTC. That is not a
 * mislabelled heading, it is the game appearing on the wrong day of the board.
 */
export function formatDay(iso: string | null): string {
  if (!iso) return EM_DASH;
  return new Date(iso).toLocaleDateString("en-US", {
    timeZone: DISPLAY_TIME_ZONE,
    weekday: "long",
    month: "short",
    day: "numeric",
  });
}

export function formatRelative(iso: string | null): string {
  if (!iso) return EM_DASH;
  const deltaMs = new Date(iso).getTime() - Date.now();
  const minutes = Math.round(deltaMs / 60000);
  const abs = Math.abs(minutes);
  const suffix = minutes < 0 ? "ago" : "from now";

  if (abs < 1) return "just now";
  if (abs < 60) return `${abs}m ${suffix}`;
  if (abs < 60 * 24) return `${Math.round(abs / 60)}h ${suffix}`;
  return `${Math.round(abs / (60 * 24))}d ${suffix}`;
}

/**
 * Colour ramp for Move Strength. Deliberately a neutral blue->amber ramp rather than
 * red/green: green reads as "good bet", and this number says nothing about whether a
 * bet is good. It only says the move was unusual.
 */
export function strengthTone(strength: number): string {
  if (strength >= 80) return "bg-amber-500/15 text-amber-300";
  if (strength >= 60) return "bg-sky-500/15 text-sky-300";
  if (strength >= 40) return "bg-slate-500/15 text-slate-300";
  return "bg-slate-700/40 text-slate-500";
}

/**
 * Per-side colour, so a two-line chart is readable at a glance without a legend hunt.
 * Sky for home/over, amber for away/under — kept consistent across the whole app so
 * the association is learned once. Deliberately not red/green: those read as
 * bad/good, and these are just two sides of a market.
 */
export function sideTone(side: Side): { text: string; dot: string; label: string } {
  const home = side === "home" || side === "over";
  return home
    ? { text: "text-sky-400", dot: "bg-sky-400", label: side }
    : { text: "text-amber-400", dot: "bg-amber-400", label: side };
}

export function teamShort(name: string | null): string {
  // Dropping the last word to strip the mascot turns "Arizona State Sun Devils" into
  // "Arizona State Sun", which is worse than the full name. ESPN display names have no
  // reliable school/mascot boundary, so show the whole thing and let CSS truncate it.
  return name ?? "?";
}
