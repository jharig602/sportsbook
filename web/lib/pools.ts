/**
 * Survivor entries: what they are, and how they are named.
 *
 * Split out of `settings-db` because the picker is a client component and importing
 * that module pulled the Postgres driver into the browser bundle. The parsing and the
 * naming are pure functions with no business touching a connection pool, and keeping
 * them here means they can be tested without one too.
 */

/**
 * Survivor entries and the teams each has already spent.
 *
 * Kept in app_settings as JSON rather than given a table: it is a handful of rows for
 * one person, it changes once a week, and a table would buy nothing but a migration.
 * Validated on read, because it is data that came back from a browser.
 */
export interface StoredPool {
  /**
   * A name you typed, if you typed one. Absent means the label is derived from the
   * size, which is the thing that actually distinguishes one pool from another and the
   * thing that drives the picks. "Pool A" carried no information and went stale the
   * moment an entrant dropped out.
   */
  name?: string;
  used: string[];
  /** How many entrants, including you. Decides what surviving is worth. */
  size: number;
  /** Losses you may take before elimination. 0 = out on the first. */
  lossesAllowed: number;
}

export const DEFAULT_POOLS: StoredPool[] = [
  { used: [], size: 13, lossesAllowed: 1 },
  { used: [], size: 137, lossesAllowed: 1 },
];

/**
 * What to call a pool.
 *
 * Derived from the size unless you named it, so it cannot go stale: change 13 entrants
 * to 25 and the label follows, which matters because the size is not cosmetic. It feeds
 * the pool-win objective directly — a 25-person pool and a 137-person one want
 * genuinely different seasons, and the label should say which one you are looking at.
 *
 * Two pools of the same size are disambiguated by position rather than being left
 * identical, because picking the wrong tab is exactly the confusion this replaces.
 */
export function poolLabel(pool: StoredPool, index: number, all: StoredPool[]): string {
  const named = pool.name?.trim();
  if (named) return named;
  const sameSize = all.filter((other) => !other.name?.trim() && other.size === pool.size);
  if (sameSize.length <= 1) return `Pool ${pool.size}`;
  return `Pool ${pool.size} (${sameSize.indexOf(pool) + 1})`;
}

export function parsePools(raw: string | null | undefined): StoredPool[] {
  if (!raw) return DEFAULT_POOLS;
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return DEFAULT_POOLS;
    const pools = value
      .filter((p) => p && typeof p === "object")
      .slice(0, 8)
      .map((p) => ({
        // An empty or missing name means "derive it", so it is not stored.
        ...(typeof p.name === "string" && p.name.trim()
          ? { name: String(p.name).trim().slice(0, 40) }
          : {}),
        used: Array.isArray(p.used)
          ? [...new Set<string>(p.used.map((t: unknown) => String(t).slice(0, 60)))].slice(0, 25)
          : ([] as string[]),
        size: Math.min(100000, Math.max(1, Number(p.size) || 1)),
        lossesAllowed: Math.min(5, Math.max(0, Number(p.lossesAllowed) || 0)),
      }));
    return pools.length > 0 ? pools : DEFAULT_POOLS;
  } catch {
    return DEFAULT_POOLS;
  }
}
