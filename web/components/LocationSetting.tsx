"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Where the owner bets from. It decides whether Kalshi flags that buy on Kalshi are
 * shown -- they stay hidden (and shadow-logged) in states `web/config/kalshi.json` blocks.
 */
export function LocationSetting({ initial, states, blocked }: { initial: string; states: string[]; blocked: string[] }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [status, setStatus] = useState<string | null>(null);

  async function save(next: string) {
    setState(next);
    const response = await fetch("/api/location", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state: next }),
    });
    setStatus(response.ok ? "Saved." : "Could not save.");
    if (response.ok) router.refresh();
  }

  return (
    <div>
      <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Your state</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        Decides which Kalshi flags you see. Stale-book flags (bet at a sportsbook) show
        everywhere; flags that buy on Kalshi are hidden in {blocked.join(", ") || "no states"} and
        logged quietly instead, so you can see whether they would have paid.
      </p>
      <select
        value={state}
        onChange={(e) => save(e.target.value)}
        className="mt-2 w-full rounded border border-edge bg-ink px-2 py-1.5 text-[13px] text-slate-100"
      >
        {states.map((s) => (
          <option key={s} value={s}>
            {s}
            {blocked.includes(s) ? " (Kalshi sports blocked)" : ""}
          </option>
        ))}
      </select>
      {status ? <p className="mt-1 text-[11px] text-slate-500">{status}</p> : null}
    </div>
  );
}
