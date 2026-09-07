import type { League } from "./types";

/**
 * ESPN team logos, derived from the team IDs the collector already stores.
 *
 * The URL pattern is stable and works by numeric id for both leagues (verified for
 * NCAAF and NFL), so no extra column, collector change or backfill is needed.
 *
 * Served as plain <img> rather than next/image on purpose: Vercel's free tier meters
 * image optimisation, and these are already small, cached, CDN-hosted PNGs. Running
 * them through the optimiser would spend quota to make them no better.
 */
export function teamLogo(league: League, teamId: string | null): string | null {
  if (!teamId) return null;
  const sport = league === "nfl" ? "nfl" : "ncaa";
  return `https://a.espncdn.com/i/teamlogos/${sport}/500/${teamId}.png`;
}

/** Initials for the placeholder shown while a logo loads or when one is missing. */
export function teamInitials(name: string | null): string {
  if (!name) return "?";
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}
