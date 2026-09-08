import type { BoardEdge } from "./board-shop";

/**
 * Deciding which cross-book gaps are worth waking you up for.
 *
 * The bar here is deliberately higher than the bar for showing a row on a page. A page
 * is read when you choose to read it; a notification interrupts. So this asks three
 * things a page does not: is the return big enough to be worth acting on, is it at a
 * book you can actually reach, and have I already told you about this exact offer.
 *
 * The alternative — buzzing on every row that clears the vig — produces a stream of
 * +0.2% alerts that get muted within a weekend, and a muted channel carries no
 * information at all.
 */

/**
 * Minimum expected return before an alert is worth an interruption.
 *
 * A row at +0.2% is arithmetically positive and practically noise: it sits inside the
 * error of the consensus it is measured against, and acting on it costs more in
 * attention than it returns. Two points is roughly the difference a full point of line
 * buys in college football, so it is the smallest gap that is unambiguously a real one.
 */
export const MIN_ALERT_ROI = 0.02;

/**
 * How much better a repeat offer must be to interrupt again.
 *
 * A line that improves from +2.1% to +2.3% is the same opportunity, not a new one.
 * A full point of improvement is worth roughly 3 points of probability, so a
 * percentage point of return is a real move rather than a wiggle.
 */
export const RENOTIFY_IMPROVEMENT = 0.01;

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
  minRoi = MIN_ALERT_ROI,
): AlertDecision[] {
  if (myBooks.length === 0) return [];

  const seen = new Map(alreadyNotified.map((o) => [o.offer_key, o.last_roi]));
  const mine = new Set(myBooks);
  const out: AlertDecision[] = [];

  for (const row of rows) {
    const roi = row.expectedRoi;
    if (roi === null || roi < minRoi) continue;
    if (!mine.has(row.book)) continue;
    // A thin reference is exactly what a whole-board scan selects for, so it never
    // earns an interruption even though the page will still show it.
    if (row.thinConsensus || row.stale) continue;

    const key = offerKey(row);
    const previous = seen.get(key);
    if (previous !== undefined && roi < previous + RENOTIFY_IMPROVEMENT) continue;

    out.push({ row, key, previousRoi: previous ?? null });
  }

  // Best first, so a capped batch keeps the ones worth having.
  return out.sort((a, b) => (b.row.expectedRoi ?? 0) - (a.row.expectedRoi ?? 0));
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
