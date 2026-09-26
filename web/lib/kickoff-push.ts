/**
 * Telling you a game you have money on is starting.
 *
 * One push per GAME, not per bet: three bets on one game are one kickoff, and the push
 * lists all of them. Parlay legs count -- a leg's game starting is the moment that leg
 * goes live -- unless the parlay is already dead, when the rest of its games are nobody's
 * news.
 *
 * ## When
 *
 * From two minutes before kickoff to twenty minutes after. The watcher that calls this
 * (`kickoff-watch.yml`) sleeps until the next kickoff, so the push usually lands on the
 * minute; the tail is for a bet logged while it was asleep. Anything later than that is
 * not "starting", it is "on", and is dropped rather than sent late.
 *
 * Not overnight: between midnight and 8 AM Central a kickoff is skipped, not held. A
 * held result is still news in the morning (`result-push.ts`); a held kickoff is not.
 *
 * ## What it reads
 *
 * The owner's ledger only, for the same reason as the result pushes: a guest's bets are
 * theirs. Voided and corrected rows are already gone (`activeBets`), and a cashed-out
 * ticket is over.
 */
import { legLabel, quietHours } from "./result-push";
import { activeBets, groupParlays, settleParlay, type Bet, type Score } from "./settle";

/** Minutes before kickoff a push may go out. The watcher aims for the minute itself. */
export const KICKOFF_EARLY_MINUTES = 2;
/** Minutes after kickoff a push is still worth sending. Later, the game is simply on. */
export const KICKOFF_LATE_MINUTES = 20;
/**
 * How far ahead `next` looks. A kickoff further out than this is left for a later
 * watcher: the collector starts one on every run, and a watcher asleep for a day would
 * tie up a runner to save nothing.
 */
export const KICKOFF_HORIZON_HOURS = 6;

export interface KickoffMessage {
  key: string;
  eventId: string;
  kickoff: number;
  title: string;
  body: string;
}

export interface KickoffPlan {
  messages: KickoffMessage[];
  /** Seconds until the next kickoff still to announce, inside the horizon; null if none. */
  next: number | null;
}

function price(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

function kickoffOf(bet: Bet): number | null {
  if (!bet.commence_time) return null;
  const at = Date.parse(bet.commence_time);
  return Number.isFinite(at) ? at : null;
}

/** The kickoffs to announce now, and when the next one is. */
export function kickoffsToAnnounce(
  bets: Bet[],
  scores: Map<string, Score>,
  now: Date,
  sent: Set<string>,
): KickoffPlan {
  // Every live position, by game: what you have on it, as a slip prints it.
  const byGame = new Map<string, { bet: Bet; lines: string[] }>();
  const add = (bet: Bet, line: string) => {
    const game = byGame.get(bet.event_id);
    if (game) game.lines.push(line);
    else byGame.set(bet.event_id, { bet, lines: [line] });
  };

  for (const ticket of groupParlays(activeBets(bets))) {
    if (ticket.kind === "single") {
      const { bet } = ticket;
      if (bet.cashout !== undefined && bet.cashout !== null) continue;
      // A final score means the game is over, not starting.
      if (scores.has(bet.event_id)) continue;
      add(bet, `${legLabel(bet)} ${price(bet.price)} at ${bet.book}`);
      continue;
    }
    const first = ticket.legs[0];
    if (first?.cashout !== undefined && first?.cashout !== null) continue;
    // A parlay with a losing leg is over, whatever its other games do.
    if (settleParlay(ticket.legs, scores).outcome === "lost") continue;
    for (const leg of ticket.legs) {
      if (scores.has(leg.event_id)) continue;
      add(leg, `${legLabel(leg)} (parlay leg)`);
    }
  }

  const at = now.getTime();
  const quiet = quietHours(now);
  const messages: KickoffMessage[] = [];
  let next: number | null = null;

  for (const [eventId, { bet, lines }] of byGame) {
    const kickoff = kickoffOf(bet);
    if (kickoff === null) continue;
    const key = `kick:${eventId}`;
    if (sent.has(key)) continue;
    const minutes = (at - kickoff) / 60_000;

    if (minutes < -KICKOFF_EARLY_MINUTES) {
      const wait = Math.ceil((kickoff - KICKOFF_EARLY_MINUTES * 60_000 - at) / 1000);
      if (wait <= KICKOFF_HORIZON_HOURS * 3600 && (next === null || wait < next)) next = wait;
      continue;
    }
    if (minutes > KICKOFF_LATE_MINUTES || quiet) continue;

    const game = `${bet.away_team ?? "Away"} @ ${bet.home_team ?? "Home"}`;
    const started = Math.round(minutes);
    messages.push({
      key,
      eventId,
      kickoff,
      title: started >= 2 ? `Started ${started} min ago: ${game}` : `Kicking off: ${game}`,
      body: `Your ${lines.length === 1 ? "bet" : `${lines.length} bets`}: ${lines.join(" · ")}`,
    });
  }

  return { messages: messages.sort((a, b) => a.kickoff - b.kickoff), next };
}
