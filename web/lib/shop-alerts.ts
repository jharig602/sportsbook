import type { BoardEdge } from "./board-shop";

/**
 * Deciding which cross-book gaps are worth waking you up for.
 *
 * The bar here is deliberately higher than the bar for showing a row on a page. A page
 * is read when you choose to read it; a notification interrupts. So this asks four
 * things a page does not: is the edge real on the probability scale, does enough of it
 * survive the vig, is it at a book you can actually reach, and have I already told you
 * about this exact offer.
 *
 * The alternative — buzzing on every row that clears the vig — produces a stream of
 * +0.2% alerts that get muted within a weekend, and a muted channel carries no
 * information at all.
 */

/**
 * Minimum edge, in points of probability, before an alert is worth an interruption.
 *
 * Measured on the probability scale, NOT on expected return, and this is the whole
 * point. EV is approximately the probability edge divided by the implied probability,
 * so a flat "+2% return" bar demands 1.33 points from a -200 favourite and 0.40 from a
 * +400 underdog: five different thresholds wearing one name, loosest precisely where
 * pricing noise is worst.
 *
 * That is not a theory. Simulating a PERFECTLY efficient market -- nine books, one
 * shared true probability, differing only by pricing noise -- the old rule fired on
 * 76% of boards at p=0.20 and 5% at p=0.50. Every alert the first version sent was a
 * moneyline underdog between +125 and +390, which is exactly the shape noise makes.
 *
 * On the probability scale the same simulation gives a uniform false-alarm rate around
 * 12%. Still not small: best-of-nine on a continuous price is a weak test whatever the
 * threshold, and a spread on the half-point grid discriminates far better because most
 * books agree exactly. Treat a moneyline alert as worth a look, not as a finding.
 */
export const MIN_ALERT_EDGE_POINTS = 1.5;

/**
 * How much better a repeat offer must be to interrupt again, in points of probability.
 *
 * An edge drifting from 1.6 to 1.8 points is the same opportunity, not a new one. A
 * full point is roughly a third of a point of NFL spread -- a real move rather than a
 * wiggle.
 */
export const RENOTIFY_IMPROVEMENT = 1.0;

export interface NotifiedOffer {
  offer_key: string;
  last_roi: number;
}

/**
 * Identity of an offer, for deduplication.
 *
 * A book, a game, a market, a side — deliberately NOT the price. Keying on price would
 * make every one-cent wiggle a new offer and turn the channel into noise; keying on
 * this means the same opportunity buzzes once, and only a materially better version of
 * it buzzes again.
 */
export function offerKey(row: {
  eventId: string;
  book: string;
  market: string;
  side: string;
}): string {
  return `${row.eventId}|${row.book}|${row.market}|${row.side}`;
}

export interface AlertDecision {
  row: BoardEdge;
  key: string;
  /** The previous return we alerted on, when this is a repeat. */
  previousRoi: number | null;
}

/**
 * Which rows should notify, given what has already been sent.
 *
 * `myBooks` empty means no book has been chosen, and nothing is sent: alerting on a
 * price you cannot get is worse than silence, because it trains you to ignore the
 * channel.
 */
export function selectAlerts(
  rows: BoardEdge[],
  myBooks: string[],
  alreadyNotified: NotifiedOffer[],
  minEdgePoints = MIN_ALERT_EDGE_POINTS,
): AlertDecision[] {
  if (myBooks.length === 0) return [];

  const seen = new Map(alreadyNotified.map((o) => [o.offer_key, o.last_roi]));
  const mine = new Set(myBooks);
  const out: AlertDecision[] = [];

  for (const row of rows) {
    // Both must hold: a real edge on the probability scale, AND enough of it left
    // after the vig to be worth staking. The first is the honest comparison; the
    // second is whether it pays.
    const edge = row.edgePoints;
    if (edge === null || edge < minEdgePoints) continue;
    if (row.expectedRoi === null || row.expectedRoi <= 0) continue;
    if (!mine.has(row.book)) continue;
    // A thin reference is exactly what a whole-board scan selects for, so it never
    // earns an interruption even though the page will still show it.
    if (row.thinConsensus || row.stale) continue;

    const key = offerKey(row);
    const previous = seen.get(key);
    if (previous !== undefined && edge < previous + RENOTIFY_IMPROVEMENT) continue;

    out.push({ row, key, previousRoi: previous ?? null });
  }

  // Ranked by the probability edge, for the same reason it is the threshold: ranking
  // by EV would put every longshot above every spread.
  return out.sort((a, b) => (b.row.edgePoints ?? 0) - (a.row.edgePoints ?? 0));
}

function sideLabel(row: BoardEdge): string {
  if (row.side === "home") return row.homeTeam;
  if (row.side === "away") return row.awayTeam;
  return row.side;
}

/** The push payload. Says what to bet, where, and at what number. */
export function shopNotification(decision: AlertDecision) {
  const { row } = decision;
  const roi = ((row.expectedRoi ?? 0) * 100).toFixed(1);
  const line =
    row.line === null
      ? ""
      : ` ${row.market === "total" ? (row.side === "over" ? "o" : "u") : ""}${
          row.line > 0 && row.market !== "total" ? "+" : ""
        }${row.line}`;
  const price = row.price === null ? "" : ` ${row.price > 0 ? "+" : ""}${row.price}`;
  const gap =
    row.advantagePoints !== null && row.advantagePoints !== 0
      ? `, ${row.advantagePoints > 0 ? "+" : ""}${row.advantagePoints.toFixed(1)} pts vs ${row.booksCompared} books`
      : `, vs ${row.booksCompared} books`;

  return {
    title: `+${roi}% ${row.book}`,
    body: `${sideLabel(row)}${line}${price}${gap}. ${row.awayTeam} @ ${row.homeTeam}.`,
    // One notification per offer, replacing any earlier one for the same offer rather
    // than stacking a wall of near-identical cards.
    tag: `shop-${decision.key}`,
    renotify: decision.previousRoi !== null,
    url: `/game/${row.eventId}`,
  };
}
