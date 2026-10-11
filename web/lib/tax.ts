/**
 * Tax on winnings: the cost that does not appear on any slip.
 *
 * US gambling winnings are taxable income at your ordinary rate (federal bracket plus
 * state). Losses only come off if you itemize deductions, only up to your winnings, and
 * from tax year 2026 only 90% of them. On the standard deduction they do not come off
 * at all -- every winning bet is taxed and every losing bet is simply gone. (24% is the
 * federal WITHHOLDING rate on large wins, not the tax itself; the owner set 24% as his
 * planning rate, and it is a setting.) General information, not tax advice.
 *
 * Two places it changes decisions:
 *
 * - A bet's value. A win keeps `1 - rate` of its profit; a loss costs the full stake,
 *   or `1 - 0.9 * rate` of it when losses can be itemized against winnings. A -110 bet
 *   that breaks even at 52.4% before tax needs about 60% at a 26% rate with no loss
 *   deduction. Boosts and bonus bets survive it; plain bets mostly do not.
 * - The year's bill: rate x (winnings - deductible losses), from the ledger.
 *
 * Winnings are counted per ticket -- the profit on every winning bet -- which is how the
 * year's gross gambling income is built, not net profit.
 */
import { decimalOdds, recordResult, type GradedRow } from "./settle";

export interface TaxSetting {
  /** Combined marginal rate on winnings, 0-0.6. 0 switches the whole feature off. */
  rate: number;
  /** Whether losses come off winnings (itemizing): none, or 90% from 2026. */
  losses: "none" | "itemize";
  /** The state's share of `rate` (Michigan 0.0425); the rest is federal. Only splits the bill. */
  state?: number;
}

export const DEFAULT_TAX: TaxSetting = { rate: 0.24, losses: "none" };
/** Share of losses deductible when itemizing, from tax year 2026. */
export const LOSS_SHARE = 0.9;

export function parseTax(raw: unknown): TaxSetting {
  const v = (raw ?? {}) as { rate?: unknown; losses?: unknown; state?: unknown };
  const r = Number(v.rate);
  const rate = Number.isFinite(r) && r >= 0 && r <= 0.6 ? r : DEFAULT_TAX.rate;
  const st = Number(v.state);
  return {
    rate,
    losses: v.losses === "itemize" ? "itemize" : "none",
    state: Number.isFinite(st) && st > 0 ? Math.min(st, rate) : 0,
  };
}

/** What a loss really costs, per $1 staked, once tax is counted. */
export function lossCost(tax: TaxSetting): number {
  return tax.losses === "itemize" ? 1 - LOSS_SHARE * tax.rate : 1;
}

/**
 * Expected profit per $1 after tax: win `p`, push `push`, at an American price, with a
 * profit boost (0.5 for 50%), and a bonus bet's stake never yours to lose.
 */
export function afterTaxEv(
  p: number,
  price: number,
  tax: TaxSetting,
  options: { boost?: number; push?: number; bonus?: boolean } = {},
): number {
  const d = decimalOdds(price);
  if (d === null) return Number.NaN;
  const profit = (d - 1) * (1 + (options.boost ?? 0));
  const lose = 1 - p - (options.push ?? 0);
  return p * profit * (1 - tax.rate) - lose * (options.bonus ? 0 : lossCost(tax));
}

/** The win rate a plain bet at this price needs to break even after tax. */
export function breakEvenAfterTax(price: number, tax: TaxSetting): number | null {
  const d = decimalOdds(price);
  if (d === null) return null;
  const win = (d - 1) * (1 - tax.rate);
  const loss = lossCost(tax);
  return loss / (win + loss);
}

export interface YearTax {
  year: number;
  /** Profit on every winning ticket settled in the year: the gross that is taxed. */
  winnings: number;
  /** Stakes lost in the year (your own money; a bonus bet loses nothing). */
  losses: number;
  /** Losses that come off, given the setting. */
  deducted: number;
  tax: number;
  /** `tax` split by where it is paid: federal (IRS) and state. */
  federal: number;
  state: number;
  /** Net profit in the year, before and after the estimated tax. */
  net: number;
  afterTax: number;
}

/** The year's estimated tax from the ledger's settled tickets. */
export function yearTax(rows: GradedRow[], tax: TaxSetting, year: number): YearTax {
  let winnings = 0;
  let losses = 0;
  let net = 0;
  for (const row of rows) {
    const when = row.commence_time ?? row.placed_at;
    if (!when || new Date(when).getUTCFullYear() !== year) continue;
    const result = recordResult(row);
    if (result === "open" || result === "push") continue;
    net += row.profit;
    if (row.profit > 0) winnings += row.profit;
    else losses += -row.profit;
  }
  const deducted = tax.losses === "itemize" ? Math.min(winnings, LOSS_SHARE * losses) : 0;
  const owed = Math.max(0, tax.rate * (winnings - deducted));
  const state = tax.rate > 0 ? owed * Math.min(tax.state ?? 0, tax.rate) / tax.rate : 0;
  return { year, winnings, losses, deducted, tax: owed, federal: owed - state, state, net, afterTax: net - owed };
}

/**
 * The smallest profit boost (0.5 = 50%) that makes a bet worth placing after tax, at a
 * fair chance `p`; 0 when it is already worth it unboosted. The answer to "is this bet
 * worth it, or only with a boost?" -- compare it with the boosts you hold.
 */
export function boostNeeded(p: number, price: number, tax: TaxSetting): number | null {
  const d = decimalOdds(price);
  if (d === null || !(p > 0 && p < 1)) return null;
  const keep = (d - 1) * (1 - tax.rate);
  if (keep <= 0) return null;
  const factor = ((1 - p) * lossCost(tax)) / (p * keep);
  return Math.max(0, factor - 1);
}

/** What a bonus bet on this line is worth per $1 after tax: only the winnings, taxed. */
export function bonusValue(p: number, price: number, tax: TaxSetting): number | null {
  const d = decimalOdds(price);
  if (d === null || !(p > 0 && p < 1)) return null;
  return p * (d - 1) * (1 - tax.rate);
}
