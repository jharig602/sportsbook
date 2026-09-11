import type { Candidate } from "./survivor";

/**
 * What a pick is worth in a pool, as opposed to how likely it is to win.
 *
 * These come apart, and the gap is the whole reason pick popularity matters. A pool
 * pays the last entrant standing, so a pick shared with most of the field cannot
 * separate you from them: when it wins you all advance together, and the pool is no
 * closer to being decided.
 *
 *   value = P(you survive) / (1 + expected rivals who survive WITH you)
 *
 * The conditional is doing the work. Given your team won, everyone who also took it is
 * still alive, so a popular pick drags its own backers through with you. An unpopular
 * winner is worth more than its win probability suggests, because the weeks it wins
 * tend to be weeks the crowd lost.
 *
 * Checked against real week-1 numbers before being believed: with the Chargers at 80%
 * and 27.6% popular against Philadelphia at 68.3% and 3.3%, going contrarian trimmed
 * the surviving field by 6% and your own survival by 15%. The chalk won at every pool
 * size from 13 to 100,000. Differentiating is a late-season lever, not a week-one one,
 * and this function is what tells you when it turns.
 */

export interface Popularity {
  /** Share of entrants taking this team, 0-1. */
  [team: string]: number;
}

export interface PoolValue {
  candidate: Candidate;
  /** Share of the field expected to take this team. Null when unknown. */
  share: number | null;
  /** Rivals expected to still be alive after this week, given your pick won. */
  coSurvivors: number;
  /** P(survive) / (1 + co-survivors). Comparable within a week, not across weeks. */
  value: number;
}

/**
 * Rank a week's candidates by what they are worth in a pool of this size.
 *
 * With no popularity data every team is treated as equally likely to be picked, which
 * makes the co-survivor term identical for all of them and collapses the ranking back
 * to win probability. That is the right degenerate behaviour: absent knowledge of the
 * field, there is no basis for preferring an unpopular team.
 */
export function poolValues(
  candidates: Candidate[],
  popularity: Popularity,
  poolSize: number,
): PoolValue[] {
  const rivals = Math.max(0, poolSize - 1);
  const known = Object.keys(popularity).length > 0;

  // The field's overall survival: how much of it gets through this week regardless of
  // what you pick. Independent of your choice, but needed for the conditional.
  let fieldSurvival = 0;
  for (const candidate of candidates) {
    const share = popularity[candidate.team];
    if (share !== undefined) fieldSurvival += share * candidate.winProbability;
  }

  return candidates
    .map((candidate) => {
      const share = known ? (popularity[candidate.team] ?? 0) : null;
      // Given YOUR team won, its backers are certainly alive; everyone else survives
      // at their own rate. Hence `share` at full weight and the rest at theirs.
      const rest = share === null ? fieldSurvival : fieldSurvival - share * candidate.winProbability;
      const coSurvivors = rivals * ((share ?? 0) + rest);
      return {
        candidate,
        share,
        coSurvivors,
        value: candidate.winProbability / (1 + coSurvivors),
      };
    })
    .sort((a, b) => b.value - a.value);
}

/**
 * Does the pool-aware ranking disagree with plain survival?
 *
 * The only question worth putting on a page. When it says no, popularity is a curiosity
 * and the safest team is also the right one. When it says yes, the extra data has
 * changed the answer and is worth the trouble of collecting.
 */
export function contrarianCall(values: PoolValue[]): {
  safest: PoolValue | null;
  best: PoolValue | null;
  disagree: boolean;
  /** How much survival you give up by taking the pool-optimal pick instead. */
  survivalGivenUp: number;
} {
  if (values.length === 0) {
    return { safest: null, best: null, disagree: false, survivalGivenUp: 0 };
  }
  const safest = [...values].sort(
    (a, b) => b.candidate.winProbability - a.candidate.winProbability,
  )[0];
  const best = values[0];
  return {
    safest,
    best,
    disagree: best.candidate.team !== safest.candidate.team,
    survivalGivenUp: safest.candidate.winProbability - best.candidate.winProbability,
  };
}
