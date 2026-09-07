/**
 * Stake sizing.
 *
 * Two modes, and which one applies is decided by evidence rather than preference:
 *
 * **Flat** — the default, and the only mode available until a Move Strength bucket has
 * been calibrated. Every pick gets the same fraction of bankroll. Sizing by an unproven
 * signal concentrates money on the alerts you happen to feel strongest about, which if
 * the signal is worthless loses faster than flat betting rather than slower.
 *
 * **Fractional Kelly** — unlocks per bucket, automatically, once calibration has a
 * probability for it. Kelly needs a real edge estimate; before calibration there is
 * none, so there is nothing to compute and the flat stake stands.
 *
 * Every result is clamped by a hard per-bet cap regardless of what the maths says.
 * Kelly is famously aggressive, and a probability estimate from a few hundred games
 * carries enough error that full Kelly can be ruinous even when the edge is real.
 */

export interface StakeSettings {
  /** Total bankroll in dollars. Stored on the device, never sent anywhere. */
  bankroll: number;
  /** Flat stake as a fraction of bankroll. 0.01 = one unit = 1%. */
  unitFraction: number;
  /** Hard ceiling on any single bet, as a fraction of bankroll. */
  maxFraction: number;
  /** Fraction of full Kelly to use once a bucket is calibrated. */
  kellyFraction: number;
}

export const DEFAULT_SETTINGS: StakeSettings = {
  bankroll: 0,
  unitFraction: 0.01,
  maxFraction: 0.03,
  kellyFraction: 0.25,
};

export const SETTINGS_KEY = "line-tracker.staking.v1";

export interface StakeAdvice {
  /** Dollars, or null when no bankroll has been set. */
  amount: number | null;
  units: number;
  basis: "flat" | "kelly";
  /** Plain-language reason, shown in the UI so the number is never unexplained. */
  reason: string;
  cappedByMax: boolean;
}

export function americanToDecimal(price: number | null | undefined): number | null {
  if (price === null || price === undefined || Math.abs(price) < 100) return null;
  return price > 0 ? 1 + price / 100 : 1 + 100 / -price;
}

/**
 * Full-Kelly fraction for a no-push bet: f = (b·p − q) / b, where b is net decimal
 * payout. Returns null when the edge is nonpositive — there is no Kelly stake for a
 * bet you do not expect to win money on.
 */
export function fullKellyFraction(
  probability: number,
  price: number | null,
): number | null {
  const decimal = americanToDecimal(price);
  if (decimal === null) return null;
  if (!(probability > 0 && probability < 1)) return null;

  const net = decimal - 1;
  if (net <= 0) return null;

  const fraction = (net * probability - (1 - probability)) / net;
  return fraction > 0 ? fraction : null;
}

export function loadSettings(): StakeSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function saveSettings(settings: StakeSettings): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing and blocked storage both land here. Losing the setting is
    // survivable; crashing the page over it is not.
  }
}

/**
 * Work out the stake for one pick.
 *
 * `calibratedProbability` is the measured win rate for this alert's Move Strength
 * bucket, or null when that bucket has not yet earned one. Null means flat, always.
 */
export function recommendStake(
  settings: StakeSettings,
  price: number | null,
  calibratedProbability: number | null,
): StakeAdvice {
  const { bankroll, unitFraction, maxFraction, kellyFraction } = settings;

  const kelly =
    calibratedProbability === null
      ? null
      : fullKellyFraction(calibratedProbability, price);

  let fraction: number;
  let basis: StakeAdvice["basis"];
  let reason: string;

  if (kelly === null) {
    fraction = unitFraction;
    basis = "flat";
    reason =
      calibratedProbability === null
        ? "Flat stake. This alert type has not been graded on enough finished games to estimate an edge, so every pick gets the same size."
        : "Flat stake. The calibrated win rate does not clear the price offered, so there is no positive edge to size against.";
  } else {
    fraction = kelly * kellyFraction;
    basis = "kelly";
    reason = `${Math.round(kellyFraction * 100)}% Kelly on a measured ${(
      calibratedProbability! * 100
    ).toFixed(1)}% win rate for this bucket.`;
  }

  const cappedByMax = fraction > maxFraction;
  if (cappedByMax) {
    fraction = maxFraction;
    reason += ` Capped at ${(maxFraction * 100).toFixed(1)}% of bankroll.`;
  }

  return {
    amount: bankroll > 0 ? Math.round(bankroll * fraction * 100) / 100 : null,
    units: Math.round((fraction / unitFraction) * 100) / 100,
    basis,
    reason,
    cappedByMax,
  };
}

export function formatMoney(amount: number | null): string {
  if (amount === null) return "—";
  return amount.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: amount < 100 ? 2 : 0,
  });
}
