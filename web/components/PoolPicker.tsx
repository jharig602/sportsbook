"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { StoredPool } from "@/lib/settings-db";

/**
 * Record what an entry actually picked, and show what it has already spent.
 *
 * The plan is only right if it knows the history. A survivor entry that has burned
 * Kansas City cannot pick them again, and a planner that does not know it will keep
 * offering them all season -- confidently, and wrongly.
 *
 * Marking is manual on purpose. What you actually submitted to a pool is not something
 * this app can observe, and inferring it from the plan would be recording our own
 * suggestion as your decision.
 */
export function PoolPicker({
  pools,
  index,
  suggestion,
}: {
  pools: StoredPool[];
  index: number;
  suggestion: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const pool = pools[index];

  async function save(next: StoredPool[]) {
    setBusy(true);
    try {
      await fetch("/api/pools", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ pools: next }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  function mark(team: string) {
    const next = pools.map((p, i) =>
      i === index ? { ...p, used: [...new Set([...p.used, team])] } : p,
    );
    save(next);
  }

  function unmark(team: string) {
    const next = pools.map((p, i) =>
      i === index ? { ...p, used: p.used.filter((t) => t !== team) } : p,
    );
    save(next);
  }

  return (
    <div className="mb-3 rounded-xl border border-edge bg-surface px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline justify-between text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {pool.name} &middot; {pool.used.length} used
        </span>
        <span className="text-[11px] text-slate-600">{open ? "hide" : "edit"}</span>
      </button>

      {suggestion ? (
        <button
          type="button"
          onClick={() => mark(suggestion)}
          disabled={busy || pool.used.includes(suggestion)}
          className="mt-2 w-full rounded-lg bg-sky-500/15 py-1.5 text-[12px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 disabled:opacity-40"
        >
          {pool.used.includes(suggestion)
            ? `${suggestion} already used`
            : `I picked ${suggestion} — mark used`}
        </button>
      ) : null}

      {open ? (
        <>
          {pool.used.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {pool.used.map((team) => (
                <button
                  key={team}
                  type="button"
                  onClick={() => unmark(team)}
                  disabled={busy}
                  className="rounded-lg bg-raised px-2 py-1 text-[11px] text-slate-400"
                >
                  {team} &times;
                </button>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-[11px] text-slate-600">
              Nothing spent yet. Mark a team once you have actually submitted it.
            </p>
          )}
          <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
            Tap a team to un-spend it. The plan below excludes everything listed here,
            because a team you have used is not a choice this entry still has.
          </p>
        </>
      ) : null}
    </div>
  );
}
