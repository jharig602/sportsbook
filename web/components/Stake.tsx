"use client";

import { formatMoney, recommendStake } from "@/lib/staking";
import { useStakeSettings } from "./StakeSettings";

/**
 * The stake for one pick.
 *
 * `calibratedProbability` comes from the server and is null until that Move Strength
 * bucket has been graded on enough finished games. Null means a flat stake — the number
 * shown here never varies with Move Strength alone.
 */
export function Stake({
  price,
  calibratedProbability,
  compact = false,
}: {
  price: number | null;
  calibratedProbability: number | null;
  compact?: boolean;
}) {
  const settings = useStakeSettings();
  const advice = recommendStake(settings, price, calibratedProbability);

  if (settings.bankroll <= 0) {
    return (
      <span className="text-[11px] text-slate-600" title="Set a bankroll in About">
        {advice.units}u
      </span>
    );
  }

  const tone =
    advice.basis === "kelly"
      ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25"
      : "bg-slate-700/40 text-slate-300 ring-slate-600/40";

  if (compact) {
    return (
      <span
        className={`tabular inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone}`}
        title={advice.reason}
      >
        {formatMoney(advice.amount)}
      </span>
    );
  }

  return (
    <div className="mt-2 flex items-start gap-2 border-t border-edge pt-2">
      <span
        className={`tabular inline-flex shrink-0 items-center rounded px-1.5 py-0.5 text-xs font-semibold ring-1 ring-inset ${tone}`}
      >
        {formatMoney(advice.amount)}
      </span>
      <span className="text-[11px] leading-relaxed text-slate-500">
        {advice.units}u &middot; {advice.basis === "kelly" ? "Kelly" : "flat"} &mdash;{" "}
        {advice.reason}
      </span>
    </div>
  );
}
