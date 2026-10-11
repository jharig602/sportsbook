"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { TaxSetting } from "@/lib/tax";

/** Rate on winnings and whether losses come off, saved for the whole app (tax.ts). */
export function TaxSettings({ initial }: { initial: TaxSetting }) {
  const router = useRouter();
  const [rate, setRate] = useState(String(Math.round(initial.rate * 1000) / 10));
  const [losses, setLosses] = useState(initial.losses);
  const [status, setStatus] = useState<string | null>(null);

  async function save() {
    const pct = Number(rate);
    if (!(pct >= 0 && pct <= 60)) {
      setStatus("Enter a rate between 0 and 60%.");
      return;
    }
    const response = await fetch("/api/tax", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ rate: pct / 100, losses }),
    });
    setStatus(response.ok ? "Saved." : "Could not save.");
    if (response.ok) router.refresh();
  }

  return (
    <div>
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Tax on winnings</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        Winnings are taxed as income at your rate (federal bracket plus state). Losses only
        come off if you itemize -- and from 2026 only 90% of them. Used to show what bets and
        boosts are worth after tax, and an estimate of the year&rsquo;s bill. Not tax advice.
      </p>
      <div className="mt-2 flex items-end gap-2">
        <label className="flex-1 text-[10px] uppercase tracking-wide text-slate-500">
          Your rate (%)
          <input
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            inputMode="decimal"
            className="tabular mt-1 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100"
          />
        </label>
        <label className="flex-[2] text-[10px] uppercase tracking-wide text-slate-500">
          Losses
          <select
            value={losses}
            onChange={(e) => setLosses(e.target.value === "itemize" ? "itemize" : "none")}
            className="mt-1 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100"
          >
            <option value="none">Standard deduction: losses don&rsquo;t count</option>
            <option value="itemize">I itemize: 90% of losses come off</option>
          </select>
        </label>
      </div>
      <button
        type="button"
        onClick={save}
        className="mt-2 w-full rounded border border-sky-700/60 bg-sky-500/10 py-1.5 text-[12px] text-sky-200"
      >
        Save
      </button>
      {status ? <p className="mt-1 text-[11px] text-slate-500">{status}</p> : null}
    </div>
  );
}
