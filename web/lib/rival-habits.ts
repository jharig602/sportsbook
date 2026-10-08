/**
 * How each rival picks, learned from their own sheet, for predicting this week's pick.
 *
 * "Best team left" made nearly every rival's predicted pick the same team, which is not
 * how people pick: some take the national favourite every week, some never do. So each
 * rival's past weeks are scored against the national pick shares stored for those weeks
 * (`pick_popularity`): did they take the most popular team they still had? That rate,
 * shrunk toward the pool's own average (two weeks of prior, so one week cannot decide
 * it), says whether they follow the crowd.
 *
 * - A follower is predicted to take the most popular team they have left nationally.
 * - An independent is predicted to take the next most popular one they have left:
 *   people who go their own way still choose among teams the public likes, and the
 *   national shares beyond the top are the best evidence of where.
 *
 * Without national shares for this week the prediction falls back to their best team
 * left, which is what the page did before; without shares for past weeks a rival simply
 * gets the pool's average habit. Neither case invents a tendency.
 */
import type { Candidate } from "./survivor";

export type Shares = Record<string, number>;

/** Weeks a rival took the most popular team still available to them, of weeks scored. */
export function followRecord(
  usedInOrder: string[],
  /** National shares by week number; week i+1 is the week of `usedInOrder[i]`. */
  national: Map<number, Shares>,
): { followed: number; scored: number } {
  const spent = new Set<string>();
  let followed = 0;
  let scored = 0;
  usedInOrder.forEach((pick, i) => {
    const shares = national.get(i + 1);
    if (shares && Object.keys(shares).length > 0) {
      const top = Object.entries(shares)
        .filter(([team]) => !spent.has(team))
        .sort((a, b) => b[1] - a[1])[0]?.[0];
      if (top) {
        scored += 1;
        if (top === pick) followed += 1;
      }
    }
    spent.add(pick);
  });
  return { followed, scored };
}

/** Their follow rate, shrunk toward the pool's: `(followed + 2*prior) / (scored + 2)`. */
export function followRate(record: { followed: number; scored: number }, prior: number): number {
  return (record.followed + 2 * prior) / (record.scored + 2);
}

/** The single most likely pick this week, given their habit and what they have left. */
export function predictPick(
  candidates: Candidate[],
  spent: Set<string>,
  shares: Shares | undefined,
  rate: number,
): Candidate | null {
  const available = candidates.filter((c) => !spent.has(c.team));
  if (available.length === 0) return null;
  const safest = [...available].sort((a, b) => b.winProbability - a.winProbability)[0];
  if (!shares || Object.keys(shares).length === 0) return safest;
  const byShare = [...available].sort((a, b) => (shares[b.team] ?? 0) - (shares[a.team] ?? 0));
  if ((shares[byShare[0].team] ?? 0) === 0) return safest;
  return rate >= 0.5 ? byShare[0] : byShare[1] ?? byShare[0];
}

/** Each team's chance for one rival this week: their habit over the shares they have left. */
export function pickChances(
  candidates: Candidate[],
  spent: Set<string>,
  shares: Shares | undefined,
  rate: number,
): Map<string, number> {
  const available = candidates.filter((c) => !spent.has(c.team));
  const out = new Map<string, number>();
  if (available.length === 0) return out;
  const total = available.reduce((sum, c) => sum + (shares?.[c.team] ?? 0), 0);
  if (!shares || total <= 0) {
    // No national picture: their best team left, as before.
    const safest = [...available].sort((a, b) => b.winProbability - a.winProbability)[0];
    out.set(safest.team, 1);
    return out;
  }
  const byShare = [...available].sort((a, b) => (shares[b.team] ?? 0) - (shares[a.team] ?? 0));
  const top = byShare[0].team;
  const rest = total - (shares[top] ?? 0);
  for (const c of available) {
    const s = shares[c.team] ?? 0;
    // A follower takes the favourite they have; otherwise they go where the public's
    // other picks go, in proportion. With nobody else on the board, all on the favourite.
    const p = c.team === top ? rate + (rest > 0 ? 0 : 1 - rate) : rest > 0 ? (1 - rate) * (s / rest) : 0;
    if (p > 0) out.set(c.team, p);
  }
  return out;
}

/**
 * One predicted team per rival group, handed out so the totals match the expected spread.
 *
 * Taking each rival's single likeliest team bunches everyone onto one or two teams -- the
 * likeliest pick for every independent is the same "next most popular" team -- when what
 * is expected is a spread. So the expected head count on each team is worked out first
 * (each group's chances times its size), and teams are handed to the groups that most
 * want them until each team's expected count is used up. Everyone still lands on a team
 * they could plausibly take; the column now looks like the pool will.
 */
export function allocatePicks(
  groups: Array<{ n: number; chances: Map<string, number> }>,
): (string | null)[] {
  const expected = new Map<string, number>();
  for (const g of groups) {
    for (const [team, p] of g.chances) expected.set(team, (expected.get(team) ?? 0) + g.n * p);
  }
  const room = new Map([...expected].map(([team, e]) => [team, e]));
  const pairs = groups
    .flatMap((g, i) => [...g.chances].map(([team, p]) => ({ i, team, p })))
    .sort((a, b) => b.p - a.p);
  const out: (string | null)[] = groups.map(() => null);
  for (const { i, team } of pairs) {
    if (out[i] !== null) continue;
    const left = room.get(team) ?? 0;
    // Half a head of slack, so a team expected to draw 1.6 people can take two.
    if (left + 0.5 >= groups[i].n) {
      out[i] = team;
      room.set(team, left - groups[i].n);
    }
  }
  // Anyone left over goes to their own likeliest team.
  groups.forEach((g, i) => {
    if (out[i] === null) out[i] = [...g.chances].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  });
  return out;
}
