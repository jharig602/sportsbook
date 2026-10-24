/**
 * The record split by kind of ticket: singles, parlays (legs from different games) and
 * same-game parlays.
 *
 * Kept apart because they are different products with different costs. A same-game
 * parlay carries far more of the book's margin than a single (15-25%+ against ~4.5%), so
 * over time it should lag -- and one blended total hides exactly that. Money is counted
 * the way the main record counts it: own stake only in the ROI's denominator, bonus-bet
 * profit beside it rather than inside it, a cash-out filed by the money it made.
 */
import { recordResult, type Bet, type GradedRow } from "./settle";

export type TicketType = "single" | "parlay" | "sgp";

export interface TypeRecord {
  type: TicketType;
  tickets: number;
  won: number;
  lost: number;
  push: number;
  /** Own money staked on settled tickets (bonus bets excluded: none of it was yours). */
  staked: number;
  /** Profit on own-money tickets. */
  profit: number;
  /** Profit from bonus bets, kept apart. */
  bonusProfit: number;
  /** profit / staked, or null with nothing staked. */
  roi: number | null;
}

export function ticketType(row: Pick<Bet, "parlay_id">, legsByParlay: Map<string, Bet[]>): TicketType {
  if (!row.parlay_id) return "single";
  const legs = legsByParlay.get(row.parlay_id) ?? [];
  return legs.length > 1 && new Set(legs.map((l) => l.event_id)).size === 1 ? "sgp" : "parlay";
}

export function recordByType(rows: GradedRow[], legsByParlay: Map<string, Bet[]>): TypeRecord[] {
  const out = new Map<TicketType, TypeRecord>();
  for (const type of ["single", "parlay", "sgp"] as TicketType[]) {
    out.set(type, { type, tickets: 0, won: 0, lost: 0, push: 0, staked: 0, profit: 0, bonusProfit: 0, roi: null });
  }
  for (const row of rows) {
    const result = recordResult(row);
    if (result === "open") continue;
    const cell = out.get(ticketType(row, legsByParlay))!;
    cell.tickets += 1;
    cell[result] += 1;
    if (row.bonus) {
      cell.bonusProfit += row.profit;
    } else {
      cell.staked += row.stake;
      cell.profit += row.profit;
    }
  }
  for (const cell of out.values()) cell.roi = cell.staked > 0 ? cell.profit / cell.staked : null;
  return [...out.values()];
}
