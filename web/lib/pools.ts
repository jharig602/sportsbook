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
  /**
   * Entrants STILL ALIVE, including you. Decides what surviving is worth.
   *
   * Not how many started. Someone already eliminated is nobody's rival: they cannot
   * take the pool and they cannot take it from you, so counting them would plan against
   * a field that is not there. Once `field` is recorded this is its total and is not
   * separately editable -- two numbers that must agree should not both be typed.
   */
  size: number;
  /** Losses you may take before elimination. 0 = out on the first. */
  lossesAllowed: number;
  /**
   * The field as it stands now: entrants still alive, bucketed by losses already
   * taken, INCLUDING you. `[90, 51]` is ninety unbeaten and fifty-one a loss down.
   *
   * Absent means nobody has lost yet, which is only true in week 1. After that it is
   * the single most important input the planner has and the one it cannot observe: a
   * rival on their last life goes out the first week their team loses, and a pool
   * where a third of the field is in that state resolves weeks earlier than one where
   * nobody is. Treating those 51 as unbeaten would plan against a field that does not
   * exist.
   */
  field?: number[];
  /**
   * How many entered at the start, if you have recorded it.
   *
   * Purely descriptive: the planner never reads it, because entrants who are out are
   * not rivals. It is stored so the screen can show its own arithmetic -- 124 alive of
   * 141 entered, 17 out -- which is the sum you would otherwise be doing on paper to
   * check that the number in front of you means what you think it means.
   */
  entered?: number;
  /**
   * How much THIS pool herds, from its own completed weeks: the most-picked team's count
   * summed across weeks (`top`), over every pick made in them (`picks`).
   *
   * The planner otherwise borrows a national survivor-pick feed, and a pool is not the
   * nation. Measured from the owner's own sheets, the 141-entry pool put 37% on one team
   * a week and the 11-entry pool 50%, against the feed's ~28%. More herding makes
   * separating from the crowd's team worth more, so this changes picks, not just labels.
   *
   * Stored as the two counts rather than a percentage so the blend with the national
   * figure can weigh them by how much evidence they are -- see `poolCrowding`.
   */
  crowd?: { top: number; picks: number };
  /** Losses your own entry has taken. Absent means none. */
  myLosses?: number;
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

/**
 * The field in the shape the model needs.
 *
 * `rivalLosses[k]` counts the OTHER entrants alive with `k` losses already taken —
 * you are removed from your own bucket, because you are not your own rival.
 */
export interface FieldState {
  /** Entrants still alive, you included. */
  entrants: number;
  rivals: number;
  /** Rivals by losses already taken, length lossesAllowed + 1. */
  rivalLosses: number[];
  myLosses: number;
  /** Further losses you can absorb and stay in. Negative means you are out. */
  livesLeft: number;
  /** True when the field was actually recorded rather than assumed unbeaten. */
  recorded: boolean;
  /**
   * Set when the recorded numbers cannot all be true, and the model is running on the
   * nearest consistent reading. Shown on the page rather than swallowed.
   */
  problem: string | null;
}

export function fieldState(pool: {
  size?: number;
  lossesAllowed?: number;
  field?: number[];
  myLosses?: number;
}): FieldState {
  const lossesAllowed = Math.max(0, pool.lossesAllowed ?? 0);
  const myLosses = Math.max(0, pool.myLosses ?? 0);
  const buckets = lossesAllowed + 1;
  const livesLeft = lossesAllowed - myLosses;

  const recorded = Array.isArray(pool.field) && pool.field.some((n) => n > 0);
  if (!recorded) {
    const entrants = Math.max(1, pool.size ?? 1);
    const rivalLosses = new Array(buckets).fill(0);
    rivalLosses[0] = entrants - 1;
    return {
      entrants, rivals: entrants - 1, rivalLosses, myLosses, livesLeft,
      recorded: false, problem: null,
    };
  }

  const counts = new Array(buckets).fill(0);
  pool.field!.slice(0, buckets).forEach((n, k) => {
    counts[k] = Math.max(0, Math.floor(n));
  });
  let problem: string | null = null;
  if ((pool.field?.length ?? 0) > buckets) {
    problem = `The field lists entrants on more losses than this pool allows; those are out and were dropped.`;
  }

  const rivalLosses = [...counts];
  if (livesLeft >= 0) {
    if (rivalLosses[myLosses] >= 1) {
      rivalLosses[myLosses] -= 1;
    } else {
      // You are alive with this many losses, so the bucket must hold at least one entry:
      // yours. Adding you rather than silently ignoring the mismatch keeps the rival
      // count exactly what was typed, which is the number that was actually observed.
      problem = `The field has nobody on ${myLosses} loss${myLosses === 1 ? "" : "es"}, but that is where your entry is. Counted you there on top of the numbers given.`;
    }
  }
  const rivals = rivalLosses.reduce((a, b) => a + b, 0);
  return {
    entrants: rivals + (livesLeft >= 0 ? 1 : 0),
    rivals,
    rivalLosses,
    myLosses,
    livesLeft,
    recorded: true,
    problem,
  };
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
        ...(Array.isArray(p.field) && p.field.some((n: unknown) => Number(n) > 0)
          ? {
              field: p.field
                .slice(0, 6)
                .map((n: unknown) => Math.min(100000, Math.max(0, Math.floor(Number(n) || 0)))),
            }
          : {}),
        ...(Number(p.entered) > 0
          ? { entered: Math.min(100000, Math.max(1, Math.floor(Number(p.entered)))) }
          : {}),
        // Kept on every re-save. The app writes the whole pool list back whenever
        // anything is tapped, so a field this parser dropped would be erased the first
        // time you marked a team used -- silently, with the plan quietly reverting to
        // the national figure.
        ...(p.crowd &&
        Number(p.crowd.picks) > 0 &&
        Number(p.crowd.top) >= 0 &&
        Number(p.crowd.top) <= Number(p.crowd.picks)
          ? {
              crowd: {
                top: Math.floor(Number(p.crowd.top)),
                picks: Math.min(1_000_000, Math.floor(Number(p.crowd.picks))),
              },
            }
          : {}),
        ...(Number(p.myLosses) > 0
          ? { myLosses: Math.min(5, Math.max(0, Math.floor(Number(p.myLosses)))) }
          : {}),
      }))
      // With a recorded field, the size IS its total: two numbers that must agree should
      // not both be stored as if either could be edited alone and still be believed.
      .map((p) =>
        p.field ? { ...p, size: Math.max(1, p.field.reduce((a: number, b: number) => a + b, 0)) } : p,
      );
    return pools.length > 0 ? pools : DEFAULT_POOLS;
  } catch {
    return DEFAULT_POOLS;
  }
}
