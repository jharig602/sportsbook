/**
 * Plan somebody else's entry: a rival in one of your pools, asked about by name.
 *
 * The pool's recorded field is everyone still alive, you and them included, so the same
 * field serves: only "which entry is mine" changes. Their losses decide which bucket is
 * theirs (`myLosses`), and the rivals' histories swap them out for you -- their group
 * loses one member, and your own spent teams join as a rival, because to them you are
 * one. Planned alone, never jointly with your entries: their season is not yours to
 * share teams with.
 *
 * Read-only and owner-only (it lives on the Survivor page). Their teams arrive in the URL
 * and are never stored.
 */
import type { PoolEntry } from "./pool-win";

type Groups = NonNullable<PoolEntry["rivals"]>["groups"];

const same = (a: string[], b: string[]) =>
  a.length === b.length && [...a].sort().every((t, i) => t === [...b].sort()[i]);

/** The pool as seen from the checked entry. */
export function entryFor(pool: PoolEntry, used: string[], losses: number): PoolEntry {
  let rivals = pool.rivals;
  if (rivals) {
    const groups: Groups = rivals.groups.map((g) => ({ ...g }));
    // Take them out: the group with exactly their history (and no pick this week, or
    // any pick -- their own pick is not a rival's).
    const theirs = groups.findIndex((g) => same(g.used, used));
    if (theirs >= 0) groups[theirs].n -= 1;
    // Put you in, as the rival you are to them.
    groups.push({ used: [...pool.used], n: 1 });
    rivals = { week: rivals.week, groups: groups.filter((g) => g.n > 0) };
  }
  return {
    ...pool,
    name: "Checked entry",
    used,
    myLosses: Math.max(0, Math.floor(losses)),
    pinned: new Map(),
    rivals,
  };
}

/** `Team A,Team B` from the URL: trimmed, de-duplicated, no empties, at most 18. */
export function parseUsed(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((t) => t.trim()).filter((t) => t && t.length <= 60))].slice(0, 18);
}
