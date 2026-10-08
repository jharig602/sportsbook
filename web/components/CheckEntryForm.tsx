"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Check somebody else's entry without building a link by hand: pick the pool, tick the
 * teams they have used, say how many losses, and the page plans them (check-entry.ts).
 * Nothing is saved -- it is a question, carried in the URL like a pin.
 */
export function CheckEntryForm({
  pools,
  teams,
  current,
}: {
  pools: Array<{ index: number; label: string }>;
  teams: string[];
  current: { pool: number; used: string[]; losses: number } | null;
}) {
  const router = useRouter();
  const [pool, setPool] = useState(current?.pool ?? pools[0]?.index ?? 0);
  const [losses, setLosses] = useState(current?.losses ?? 0);
  const [used, setUsed] = useState<Set<string>>(new Set(current?.used ?? []));

  function toggle(team: string) {
    const next = new Set(used);
    if (next.has(team)) next.delete(team);
    else next.add(team);
    setUsed(next);
  }

  function check() {
    if (used.size === 0) return;
    const query = new URLSearchParams({
      pool: String(pool),
      check: String(pool),
      losses: String(losses),
      used: [...used].join(","),
    });
    router.push(`/survivor?${query.toString()}`);
  }

  return (
    <details className="mb-3 rounded-xl border border-edge bg-surface px-3 py-2" open={current !== null}>
      <summary className="cursor-pointer text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        Check another entry
      </summary>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        Someone else in one of your pools: tick the teams they have used and their losses.
        They are planned against the same field, with you as one of their rivals. Nothing is saved.
      </p>
      <div className="mt-2 flex gap-2">
        <select
          value={pool}
          onChange={(e) => setPool(Number(e.target.value))}
          className="flex-1 rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-200"
        >
          {pools.map((p) => (
            <option key={p.index} value={p.index}>{p.label}</option>
          ))}
        </select>
        <select
          value={losses}
          onChange={(e) => setLosses(Number(e.target.value))}
          className="rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-200"
        >
          <option value={0}>Unbeaten</option>
          <option value={1}>1 loss</option>
        </select>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1">
        {teams.map((team) => (
          <label key={team} className="flex items-center gap-1.5 text-[11px] text-slate-300">
            <input type="checkbox" checked={used.has(team)} onChange={() => toggle(team)} />
            <span className="truncate">{team}</span>
          </label>
        ))}
      </div>
      <button
        type="button"
        onClick={check}
        disabled={used.size === 0}
        className="mt-2 w-full rounded border border-sky-700/60 bg-sky-500/10 py-1.5 text-[12px] text-sky-200 disabled:opacity-40"
      >
        Check this entry ({used.size} team{used.size === 1 ? "" : "s"} used)
      </button>
    </details>
  );
}
