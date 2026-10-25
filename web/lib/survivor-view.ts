/**
 * The survivor planner's inputs as the Survivor page builds them, shared with the Claude
 * connector (mcp-tools.ts) so "who do we pick" has one answer wherever it is asked.
 *
 * Moved out of the page verbatim: the slate with this week's locked games removed, the
 * mid-week state of the current week (games under way, rivals' standing picks), and the
 * odds a plan implies against the recorded field.
 */
import { fieldState } from "./pools";
import { extraLifeMultiple, poolOdds } from "./pool-odds";
import type { PoolWinPlan } from "./pool-win";
import { winProbabilityFromSpread, type MarginModel } from "./probability";
import { buildWeeks, type Candidate } from "./survivor";
import { pickLocked } from "./survivor-window";
import type { Game, GameResult } from "./types";

type SeasonGames = Parameters<typeof buildWeeks>[0];

/**
 * The weeks still to pick. A week whose Sunday lock has passed is history: its pick is in,
 * and its remaining Sunday-night and Monday games are not a choice.
 */
export function openWeeks(games: SeasonGames, model: MarginModel | null, opener: string | null, now: Date) {
  return buildWeeks(games, model, opener).filter(
    (w, i, all) => !(i === all.findIndex((x) => x.candidates.length > 0) &&
      pickLocked(w.candidates.map((c) => c.commenceTime), now)),
  );
}

/**
 * This week mid-week (pool-win.ts WeekZero). Games already under way are dropped from the
 * schedule, but rivals' picks on them still stand, so they are kept as locked games -- at
 * their pregame chance, or the result once final. And a rival with no pick yet cannot
 * take a Thursday-to-Saturday game twelve hours or less from kickoff.
 */
export function weekZero(
  board: Game[],
  finals: Map<string, GameResult>,
  model: MarginModel | null,
  openerCandidates: Candidate[],
  nowMs: number,
) {
  const locked = new Map<string, Candidate>();
  for (const g of board) {
    const start = Date.parse(g.commenceTime);
    if (g.league !== "nfl" || !(start <= nowMs) || nowMs - start > 5 * 86_400_000) continue;
    const final = finals.get(g.eventId);
    const homeSpread = g.spread?.home?.line ?? null;
    const homeChance = final
      ? final.home_score > final.away_score ? 1 : final.home_score < final.away_score ? 0 : 0.5
      : model && homeSpread !== null
        ? winProbabilityFromSpread(model, homeSpread, "home") ?? 0.5
        : 0.5;
    for (const [team, opponent, chance, home] of [
      [g.homeTeam, g.awayTeam, homeChance, true],
      [g.awayTeam, g.homeTeam, 1 - homeChance, false],
    ] as const) {
      if (!team || !opponent) continue;
      locked.set(team, {
        team, opponent, home, winProbability: chance, spread: 0,
        commenceTime: g.commenceTime, eventId: g.eventId,
      });
    }
  }
  const closedToUnpicked = new Set(
    openerCandidates
      .filter((c) => {
        const day = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" }).format(new Date(c.commenceTime));
        return ["Thu", "Fri", "Sat"].includes(day) && Date.parse(c.commenceTime) - nowMs < 12 * 3_600_000;
      })
      .map((c) => c.team),
  );
  return { locked, closedToUnpicked };
}

/** Survival with a spare life, and what surviving is worth against a field of this size. */
export function entryOdds(entry: { pool: PoolWinPlan["pool"]; plan: PoolWinPlan["plan"] }) {
  const probs = entry.plan.picks
    .map((pick) => pick.pick?.winProbability)
    .filter((v): v is number => v !== undefined);
  return {
    pool: entry.pool,
    probs,
    // The recorded field, so "field left" counts a rival on their last life as having
    // one life, not two.
    odds: poolOdds(
      probs,
      entry.pool.lossesAllowed ?? 0,
      entry.pool.size ?? 1,
      fieldState(entry.pool),
    ),
    // What a spare life is worth only means something if you still have one to spare.
    lifeMultiple: fieldState(entry.pool).livesLeft > 0 ? extraLifeMultiple(probs) : 1,
  };
}
