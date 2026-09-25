/**
 * Telling you how your bets finished.
 *
 * One push per ticket when its result is known: won, lost, or pushed, with what it paid
 * and the final score. A parlay is one ticket, announced once -- and the moment one leg
 * loses, since that settles it whatever the other games do.
 *
 * ## What it reads
 *
 * The owner's ledger only (`HOUSE`). The collector runs from cron with no cookie, and a
 * guest's bets are theirs; announcing them to the owner's phone would be a leak dressed
 * as a feature. Voided and corrected rows are already gone by the time this sees them
 * (`activeBets`), and a cashed-out ticket is not announced: you ended it yourself, so
 * the final score telling you what you missed is not news you asked for.
 *
 * ## When
 *
 * Only results for games that kicked off in the last day and a half. Without that bound
 * the first run after this shipped would have pushed the entire season, one bet at a
 * time. And not between midnight and 8 AM Central: a result that lands then is held,
 * not dropped, and the first run after 8 carries it. A 3 AM buzz to say a Saturday
 * night bet lost is worse news than the loss.
 *
 * When several tickets finish at once -- a college Saturday -- one summary replaces a
 * pile of separate buzzes.
 */
import { activeBets, groupParlays, settle, settleParlay, type Bet, type Score } from "./settle";

export const RESULT_WINDOW_HOURS = 36;
/** More than this many results in one run become a single summary. */
export const SUMMARY_OVER = 3;
const QUIET_FROM_HOUR = 0;
const QUIET_UNTIL_HOUR = 8;

export interface ResultMessage {
  key: string;
  outcome: "won" | "lost" | "push" | "fix";
  title: string;
  body: string;
  profit: number;
  kickoff: number;
  eventId: string;
}

/** The hour in Central time, which is the clock every window in this app runs on. */
export function centralHour(now: Date): number {
  const hour = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    hour: "numeric",
    hourCycle: "h23",
  }).format(now);
  return Number(hour);
}

/** Overnight in Central time, when results are held rather than sent. */
export function quietHours(now: Date): boolean {
  const hour = centralHour(now);
  return hour >= QUIET_FROM_HOUR && hour < QUIET_UNTIL_HOUR;
}

export function money(amount: number): string {
  const sign = amount > 0 ? "+" : amount < 0 ? "−" : "";
  return `${sign}$${Math.abs(amount).toFixed(2)}`;
}

function price(value: number): string {
  return `${value > 0 ? "+" : ""}${value}`;
}

/** A leg the way a bet slip prints it. */
export function legLabel(bet: Bet): string {
  const team =
    bet.side === "home" ? bet.home_team : bet.side === "away" ? bet.away_team : null;
  if (bet.market === "moneyline") return `${team ?? bet.side} ML`;
  if (bet.market === "spread") {
    const line = bet.line ?? 0;
    return `${team ?? bet.side} ${line > 0 ? "+" : ""}${line}`;
  }
  // A total with a team on it is that team's points, not the game's.
  const whose =
    bet.team === "home" ? `${bet.home_team} ` : bet.team === "away" ? `${bet.away_team} ` : "";
  return `${whose}${bet.side === "over" ? "Over" : "Under"} ${bet.line ?? ""}`.trim();
}

function finalScore(bet: Bet, score: Score): string {
  return `Final: ${bet.away_team ?? "Away"} ${score.away_score}, ${bet.home_team ?? "Home"} ${score.home_score}.`;
}

function kickoffOf(bet: Bet): number | null {
  if (!bet.commence_time) return null;
  const at = Date.parse(bet.commence_time);
  return Number.isFinite(at) ? at : null;
}

function recent(kickoff: number | null, now: Date): kickoff is number {
  if (kickoff === null) return false;
  const hours = (now.getTime() - kickoff) / 3_600_000;
  return hours > 0 && hours <= RESULT_WINDOW_HOURS;
}

/**
 * Every result that should be announced now and has not been.
 *
 * A bet with no kickoff time is skipped: without one there is no way to tell a result
 * from last night from one in August, and guessing wrong means a burst of old news.
 */
export function resultsToAnnounce(
  bets: Bet[],
  scores: Map<string, Score>,
  now: Date,
  sent: Set<string>,
): ResultMessage[] {
  const out: ResultMessage[] = [];

  for (const ticket of groupParlays(activeBets(bets))) {
    if (ticket.kind === "single") {
      const { bet } = ticket;
      const score = scores.get(bet.event_id);
      const kickoff = kickoffOf(bet);
      if (!score || !recent(kickoff, now)) continue;
      const result = settle(bet, score);
      if (result.outcome !== "won" && result.outcome !== "lost" && result.outcome !== "push") {
        continue;
      }
      const key = `bet:${bet.bet_id}:${result.outcome}`;
      if (sent.has(key)) continue;

      const what = `${legLabel(bet)} ${price(bet.price)} at ${bet.book}.`;
      out.push({
        key,
        outcome: result.outcome,
        eventId: bet.event_id,
        kickoff,
        profit: result.profit,
        title:
          result.outcome === "won"
            ? `Won ${money(result.profit)}`
            : result.outcome === "push"
              ? "Push — stake back"
              : bet.bonus
                ? "Lost — bonus bet, cost nothing"
                : `Lost ${money(result.profit)}`,
        body: `${what} ${finalScore(bet, score)}`,
      });
      continue;
    }

    // A parlay: one ticket, decided the moment any leg loses.
    const settled = settleParlay(ticket.legs, scores);
    const decidedKickoffs = ticket.legs
      .filter((leg) => scores.has(leg.event_id))
      .map(kickoffOf)
      .filter((k): k is number => k !== null);
    const latest = decidedKickoffs.length ? Math.max(...decidedKickoffs) : null;
    if (!recent(latest, now)) continue;

    const legs = ticket.legs.map(legLabel).join(" + ");
    const first = ticket.legs[0];
    const at = first?.parlay_price ? ` ${price(first.parlay_price)} at ${first.book}` : "";

    if (settled.needsCorrection) {
      // A leg pushed and the book re-priced the ticket. The new price is the book's to
      // set, not ours to guess, so the message asks for it rather than inventing one.
      const key = `parlay:${ticket.id}:fix`;
      if (sent.has(key)) continue;
      out.push({
        key,
        outcome: "fix",
        eventId: first.event_id,
        kickoff: latest,
        profit: 0,
        title: "Parlay needs updating",
        body: `A leg pushed, so the book re-priced your ${legs} parlay. Enter the new price in Bets to settle it.`,
      });
      continue;
    }
    if (settled.outcome !== "won" && settled.outcome !== "lost") continue;

    const key = `parlay:${ticket.id}:${settled.outcome}`;
    if (sent.has(key)) continue;
    out.push({
      key,
      outcome: settled.outcome,
      eventId: first.event_id,
      kickoff: latest,
      profit: settled.profit,
      title:
        settled.outcome === "won"
          ? `Parlay won ${money(settled.profit)}`
          : first.bonus
            ? "Parlay lost — bonus bet, cost nothing"
            : `Parlay lost ${money(settled.profit)}`,
      body: `${legs}${at}.`,
    });
  }

  return out.sort((a, b) => a.kickoff - b.kickoff);
}

/** One notification standing in for several results that landed together. */
export function summarise(messages: ResultMessage[]): { title: string; body: string } {
  const won = messages.filter((m) => m.outcome === "won").length;
  const lost = messages.filter((m) => m.outcome === "lost").length;
  const net = messages.reduce((sum, m) => sum + m.profit, 0);
  const parts = [won ? `${won} won` : null, lost ? `${lost} lost` : null].filter(Boolean);
  return {
    title: `${parts.join(", ") || `${messages.length} results`} · ${money(net)}`,
    body: messages.map((m) => m.title).join(" · "),
  };
}
