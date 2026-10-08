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
