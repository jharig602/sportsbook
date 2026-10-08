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
): { followed: number; scored: number; expected: number } {
  const spent = new Set<string>();
  let followed = 0;
  let scored = 0;
  // How often picking in proportion to the national shares would have hit the favourite:
  // the bar a rival's own rate is measured against, so "follows" means MORE than chance.
  let expected = 0;
  usedInOrder.forEach((pick, i) => {
    const shares = national.get(i + 1);
    if (shares && Object.keys(shares).length > 0) {
      const left = Object.entries(shares).filter(([team]) => !spent.has(team));
      const total = left.reduce((sum, [, share]) => sum + share, 0);
      const [top, topShare] = left.sort((a, b) => b[1] - a[1])[0] ?? [undefined, 0];
      if (top && total > 0) {
        scored += 1;
        expected += topShare / total;
        if (top === pick) followed += 1;
      }
    }
    spent.add(pick);
  });
  return { followed, scored, expected };
}

/**
 * How much more (above 1) or less (below 1) than the national split this rival takes the
 * favourite, as an odds ratio: their follow rate against the rate picking by the shares
 * would have given. Both rates are shrunk toward the pool's, two weeks of prior each, so
 * a rival with one week of history sits close to the pool and the pool close to 1.
 */
export function followTilt(
  record: { followed: number; scored: number; expected: number },
  pool: { followed: number; expected: number; scored: number },
): number {
  if (pool.scored === 0) return 1;
  const poolRate = pool.followed / pool.scored;
  const poolExpected = pool.expected / pool.scored;
  const rate = (record.followed + 2 * poolRate) / (record.scored + 2);
  const base = (record.expected + 2 * poolExpected) / (record.scored + 2);
  const odds = (p: number) => Math.min(0.97, Math.max(0.03, p)) / (1 - Math.min(0.97, Math.max(0.03, p)));
  return odds(rate) / odds(base);
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

/**
 * Each team's chance for one rival this week: the national shares over the teams they
 * have left, with the favourite weighted by their tilt (`followTilt`). A rival who follows
 * the crowd exactly as often as the shares would predict gets the national split -- if
 * 40% of the country is on the Cowboys, so is 40% of their chance.
 */
export function pickChances(
  candidates: Candidate[],
  spent: Set<string>,
  shares: Shares | undefined,
  tilt: number,
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
  const top = [...available].sort((a, b) => (shares[b.team] ?? 0) - (shares[a.team] ?? 0))[0].team;
  const weight = (team: string) => (shares[team] ?? 0) * (team === top ? tilt : 1);
  const sum = available.reduce((acc, c) => acc + weight(c.team), 0);
  for (const c of available) {
    const p = weight(c.team) / sum;
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
