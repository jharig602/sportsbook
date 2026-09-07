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

export function formatKickoff(iso: string | null): string {
  if (!iso) return EM_DASH;
  return new Date(iso).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
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

export function teamShort(name: string | null): string {
  // Dropping the last word to strip the mascot turns "Arizona State Sun Devils" into
  // "Arizona State Sun", which is worse than the full name. ESPN display names have no
  // reliable school/mascot boundary, so show the whole thing and let CSS truncate it.
  return name ?? "?";
}
