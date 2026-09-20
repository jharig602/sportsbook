import type { Bet } from "./settle";

/**
 * What a bet becomes when it is re-pointed at the other side.
 *
 * A spread belongs to the side that took it. The same wager is home -3.5 or away +3.5,
 * and never away -3.5: switching the side without carrying the line across records a bet
 * nobody was offered, which then grades cleanly against the wrong question and looks
 * entirely ordinary on screen. That is the failure this project keeps finding -- an
 * error that presents as a result -- and it is why this is a function with tests rather
 * than two lines inside a form.
 *
 * Totals and moneylines have no mirror. Over 45.5 and under 45.5 are the same number,
 * and a moneyline has no line at all, so only the spread moves.
 */
export function mirrorSide(
  market: Bet["market"],
  line: number | null,
  from: string,
  to: string,
): { side: string; line: number | null } {
  if (to === from || market !== "spread" || line === null || !Number.isFinite(line)) {
    return { side: to, line };
  }
  return { side: to, line: -line };
}
