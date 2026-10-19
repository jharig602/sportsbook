"use client";

import { useMemo, useState } from "react";

import { Card } from "@/components/ui";
import {
  checkPrice,
  fairAmerican,
  groupProps,
  propFair,
  rungLabel,
  STAT_LABEL,
  STAT_ORDER,
  worthAt,
  type PropRow,
  type PropStat,
} from "@/lib/props";
import type { TaxSetting } from "@/lib/tax";

const BOOSTS = [0, 0.2, 0.25, 0.3, 0.5, 1];
const price = (v: number | null) => (v === null ? "—" : v > 0 ? `+${v}` : String(v));
const money = (v: number) => `${v >= 0 ? "+" : "−"}$${Math.abs(v).toFixed(2)}`;

/**
 * A game's player props from Kalshi: every rung with its fair chance, and a checker for
 * the price an app is offering. Pick a rung, choose the boost the app is running, and it
 * says the worst price still worth taking after tax -- then type the app's price to see
 * what $10 on it is worth.
 */
export function PlayerProps({
  rows,
  tax,
  homeTeam,
  awayTeam,
}: {
  rows: PropRow[];
  tax: TaxSetting;
  homeTeam: string;
  awayTeam: string;
}) {
  const grouped = useMemo(() => groupProps(rows), [rows]);
  const stats = STAT_ORDER.filter((s) => grouped.has(s));
  const [stat, setStat] = useState<PropStat | null>(stats[0] ?? null);
  const [picked, setPicked] = useState<PropRow | null>(null);
  const [boost, setBoost] = useState(0);
  const [offered, setOffered] = useState("");
  const [stake, setStake] = useState("10");

  if (stats.length === 0 || !stat) return null;
  const players = [...(grouped.get(stat) ?? new Map()).entries()].sort(
    ([, a], [, b]) => (b[0]?.volume ?? 0) - (a[0]?.volume ?? 0),
  );
  const fair = picked ? propFair(picked) : null;
  const offeredPrice = Number(offered);
  const validPrice = Number.isFinite(offeredPrice) && Math.abs(offeredPrice) >= 100;
  const stakeNumber = Number(stake) > 0 ? Number(stake) : 10;
  const check = fair !== null && validPrice ? checkPrice(fair, offeredPrice, tax, boost, stakeNumber) : null;

  return (
    <Card className="px-3.5 py-3">
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Player props · Kalshi</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        Fair chances from Kalshi&rsquo;s prices, no vig. Tap a rung, pick the boost your app is
        running, and compare its price with the one worth taking after tax.
      </p>

      <div className="mt-2 flex flex-wrap gap-1">
        {stats.map((s) => (
          <button
            key={s}
            type="button"
            onClick={() => {
              setStat(s);
              setPicked(null);
            }}
            className={`rounded-full border px-2 py-0.5 text-[11px] ${
              s === stat ? "border-sky-600/60 bg-sky-500/15 text-sky-100" : "border-edge text-slate-400"
            }`}
          >
            {STAT_LABEL[s]}
          </button>
        ))}
      </div>

      <ul className="mt-2 space-y-1.5">
        {players.slice(0, 24).map(([player, rungs]) => (
          <li key={player}>
            <p className="text-[12px] text-slate-200">
              {player}
              <span className="ml-1 text-[10px] text-slate-500">
                {rungs[0].teamSide === "home" ? homeTeam : rungs[0].teamSide === "away" ? awayTeam : ""}
              </span>
            </p>
            <div className="mt-0.5 flex flex-wrap gap-1">
              {rungs.map((r: PropRow) => {
                const p = propFair(r);
                const on = picked?.marketTicker === r.marketTicker;
                return (
                  <button
                    key={r.marketTicker}
                    type="button"
                    disabled={p === null}
                    onClick={() => setPicked(r)}
                    className={`tabular rounded border px-1.5 py-0.5 text-[11px] ${
                      on
                        ? "border-violet-500/70 bg-violet-500/15 text-violet-100"
                        : p === null
                          ? "border-edge/50 text-slate-600"
                          : "border-edge text-slate-300"
                    }`}
                    title={p === null ? "Too thin to price" : `Fair ${price(fairAmerican(p))}`}
                  >
                    {rungLabel(r)} {p === null ? "thin" : `${Math.round(p * 100)}%`}
                  </button>
                );
              })}
            </div>
          </li>
        ))}
      </ul>

      {picked && fair !== null ? (
        <div className="mt-3 rounded border border-violet-700/40 px-2.5 py-2">
          <p className="text-[12px] text-slate-200">
            {picked.player} {rungLabel(picked)} {picked.line === null ? "" : STAT_LABEL[picked.stat].toLowerCase()}:{" "}
            <span className="tabular">{(fair * 100).toFixed(1)}%</span>, fair{" "}
            <span className="tabular">{price(fairAmerican(fair))}</span>
          </p>
          <div className="mt-1.5 grid grid-cols-3 gap-1.5">
            <label className="text-[10px] uppercase tracking-wide text-slate-500">
              Boost
              <select
                value={String(boost)}
                onChange={(e) => setBoost(Number(e.target.value))}
                className="mt-0.5 w-full rounded border border-edge bg-ink px-1.5 py-1 text-[12px] text-slate-100"
              >
                {BOOSTS.map((b) => (
                  <option key={b} value={String(b)}>
                    {b === 0 ? "None" : `${Math.round(b * 100)}%`}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-[10px] uppercase tracking-wide text-slate-500">
              App&rsquo;s price
              <input
                value={offered}
                onChange={(e) => setOffered(e.target.value)}
                inputMode="numeric"
                placeholder="-110"
                className="tabular mt-0.5 w-full rounded border border-edge bg-ink px-1.5 py-1 text-[12px] text-slate-100"
              />
            </label>
            <label className="text-[10px] uppercase tracking-wide text-slate-500">
              Stake
              <input
                value={stake}
                onChange={(e) => setStake(e.target.value)}
                inputMode="decimal"
                className="tabular mt-0.5 w-full rounded border border-edge bg-ink px-1.5 py-1 text-[12px] text-slate-100"
              />
            </label>
          </div>
          <p className="mt-1.5 text-[12px] text-slate-300">
            Worth it at <span className="tabular font-medium text-emerald-300">{price(worthAt(fair, tax, boost))}</span> or
            better{boost > 0 ? ` with the ${Math.round(boost * 100)}% boost` : ""}, after tax
            <span className="text-slate-500"> (before tax: {price(worthAt(fair, { rate: 0, losses: "none" }, boost))})</span>.
          </p>
          {check ? (
            <p className="mt-1 text-[12px] text-slate-300">
              ${stakeNumber.toFixed(0)} at {price(offeredPrice)}{boost > 0 ? ` +${Math.round(boost * 100)}%` : ""}:{" "}
              <span className={check.after >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(check.after)} after tax</span>
              <span className="text-slate-500"> · {money(check.before)} before</span>
            </p>
          ) : null}
          <p className="mt-1 text-[10px] leading-snug text-slate-600">
            Use the app&rsquo;s price for the same line: Kalshi&rsquo;s 65+ is the app&rsquo;s over 64.5.
            Not for same-game parlays &mdash; legs on one game move together.
          </p>
        </div>
      ) : null}
    </Card>
  );
}
