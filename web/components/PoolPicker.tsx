"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { fieldState, poolLabel, type StoredPool } from "@/lib/pools";

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

  function setField(key: "size" | "lossesAllowed" | "entered", value: number) {
    save(pools.map((p, i) => (i === index ? { ...p, [key]: value } : p)));
  }

  /**
   * Record how many are still alive on each number of losses.
   *
   * Stored as the state rather than as "how many lost this week", on purpose. A weekly
   * delta has to be applied exactly once, and a form that is saved twice, or edited
   * after the fact, would quietly apply it twice. The state can be re-saved any number
   * of times and still mean the same thing.
   */
  function setAlive(losses: number, value: number) {
    const current = pool.field ?? [pool.size];
    const next = Array.from({ length: pool.lossesAllowed + 1 }, (_, k) =>
      k === losses ? value : (current[k] ?? 0),
    );
    save(pools.map((p, i) => (i === index ? { ...p, field: next } : p)));
  }

  function setMyLosses(value: number) {
    save(pools.map((p, i) => (i === index ? { ...p, myLosses: value } : p)));
  }

  function clearField() {
    save(
      pools.map((p, i) => {
        if (i !== index) return p;
        const { field: _field, myLosses: _mine, ...rest } = p;
        return rest;
      }),
    );
  }

  function addPool() {
    // A new entry starts unnamed, so its label follows whatever size you give it.
    save([...pools, { used: [], size: 20, lossesAllowed: pool?.lossesAllowed ?? 0 }]);
  }

  function removePool() {
    // The last one cannot go: a survivor page with nothing to plan is not a state worth
    // being able to reach by accident.
    if (pools.length <= 1) return;
    save(pools.filter((_, i) => i !== index));
    router.push("/survivor");
  }

  function unmark(team: string) {
    const next = pools.map((p, i) =>
      i === index ? { ...p, used: p.used.filter((t) => t !== team) } : p,
    );
    save(next);
  }

  const state = fieldState(pool);

  return (
    <div className="mb-3 rounded-xl border border-edge bg-surface px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline justify-between text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {poolLabel(pool, index, pools)} &middot; {pool.used.length} used
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
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                {state.recorded ? "Still alive" : "Entrants"}
              </span>
              {/* The label changes with the meaning, because the number does. Before any
                  losses are recorded this is how many entered; afterwards it is the total
                  of the field below, which counts only entrants still alive. It read
                  "Entrants" in both states, so a pool of 141 that was down to 124 showed
                  124 under a label promising 141 and looked like it had lost people.

                  Not separately editable once the field is recorded: two numbers that
                  must agree should not both be typed. */}
              <input
                type="text"
                inputMode="numeric"
                key={`size-${pool.size}-${state.recorded}`}
                defaultValue={String(pool.size)}
                disabled={state.recorded}
                onBlur={(e) => setField("size", Number(e.target.value.replace(/[^0-9]/g, "")) || 1)}
                className="tabular mt-1 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600 disabled:opacity-60"
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                Losses allowed
              </span>
              <select
                defaultValue={String(pool.lossesAllowed)}
                onChange={(e) => setField("lossesAllowed", Number(e.target.value))}
                className="mt-1 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600"
              >
                <option value="0">0 — out on first loss</option>
                <option value="1">1 — out on second loss</option>
                <option value="2">2 — out on third loss</option>
              </select>
            </label>
          </div>

          <div className="mt-3 border-t border-edge/60 pt-2.5">
            <p className="text-[10px] uppercase tracking-wide text-slate-500">
              Still alive, by losses taken (you included)
            </p>
            <div className="mt-1 grid grid-cols-3 gap-2">
              {Array.from({ length: pool.lossesAllowed + 1 }, (_, k) => (
                <label key={k} className="block">
                  <span className="text-[10px] text-slate-500">
                    {k === 0 ? "unbeaten" : `${k} loss${k === 1 ? "" : "es"}`}
                  </span>
                  <input
                    type="text"
                    inputMode="numeric"
                    key={`alive-${k}-${pool.field?.[k] ?? "none"}`}
                    defaultValue={
                      pool.field ? String(pool.field[k] ?? 0) : k === 0 ? String(pool.size) : "0"
                    }
                    onBlur={(e) => setAlive(k, Number(e.target.value.replace(/[^0-9]/g, "")) || 0)}
                    className="tabular mt-0.5 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600"
                  />
                </label>
              ))}
              <label className="block">
                <span className="text-[10px] text-slate-500">your losses</span>
                <select
                  key={`mine-${pool.myLosses ?? 0}`}
                  defaultValue={String(pool.myLosses ?? 0)}
                  onChange={(e) => setMyLosses(Number(e.target.value))}
                  className="mt-0.5 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600"
                >
                  {Array.from({ length: pool.lossesAllowed + 2 }, (_, k) => (
                    <option key={k} value={k}>
                      {k > pool.lossesAllowed ? `${k} — out` : String(k)}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            {/* The screen's own arithmetic, so the numbers can be checked at a glance
                rather than on paper. Eliminated entrants are shown precisely because they
                are NOT in the figure above -- that is the whole point being explained. */}
            {state.recorded ? (
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-400">
                <span className="font-medium text-slate-300">
                  {state.entrants} still alive
                </span>
                {pool.entered && pool.entered >= state.entrants ? (
                  <>
                    {" "}
                    of {pool.entered} entered &mdash; {pool.entered - state.entrants} out.
                  </>
                ) : (
                  "."
                )}{" "}
                Entrants already eliminated are left out on purpose: they cannot take the
                pool and cannot take it from you, so planning against them would mean
                planning against a field that is not there.
              </p>
            ) : null}
            <label className="mt-1.5 block">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                Started with (optional)
              </span>
              <input
                type="text"
                inputMode="numeric"
                key={`entered-${pool.entered ?? "none"}`}
                defaultValue={pool.entered ? String(pool.entered) : ""}
                placeholder="141"
                onBlur={(e) =>
                  setField("entered", Number(e.target.value.replace(/[^0-9]/g, "")) || 0)
                }
                className="tabular mt-0.5 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600"
              />
              <span className="mt-0.5 block text-[10px] leading-snug text-slate-600">
                Recorded so the counts can be checked against each other. The planner never
                uses it.
              </span>
            </label>
            <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
              {state.recorded
                ? `Planning against ${state.rivals} rival${state.rivals === 1 ? "" : "s"}: ${state.rivalLosses
                    .map((n, k) => `${n} ${k === 0 ? "unbeaten" : `on ${k} loss${k === 1 ? "" : "es"}`}`)
                    .join(", ")}.`
                : "Not recorded, so every rival is assumed unbeaten — only true before week 1."}{" "}
              Enter the totals as they stand, not this week&rsquo;s changes; saving twice
              then cannot count anyone twice.
            </p>
            {state.problem ? (
              <p className="mt-1 text-[11px] leading-relaxed text-amber-300/90">{state.problem}</p>
            ) : null}
            {state.recorded ? (
              <button
                type="button"
                onClick={clearField}
                disabled={busy}
                className="mt-1.5 text-[11px] text-slate-500 underline underline-offset-2"
              >
                forget the recorded field
              </button>
            ) : null}
          </div>

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
          <p className="mt-2 text-[11px] text-slate-600">
            Tap a team to un-spend it &mdash; the plan excludes everything listed here.
            Entrants drives the picks, not just the label: a 25-person pool and a
            137-person one want different seasons.
          </p>

          <div className="mt-2.5 flex gap-2">
            <button
              type="button"
              onClick={addPool}
              disabled={busy || pools.length >= 8}
              className="flex-1 rounded-lg bg-raised py-1.5 text-[12px] font-medium text-slate-300 disabled:opacity-40"
            >
              Add a pool
            </button>
            <button
              type="button"
              onClick={removePool}
              disabled={busy || pools.length <= 1}
              className="flex-1 rounded-lg bg-rose-500/10 py-1.5 text-[12px] font-medium text-rose-300 ring-1 ring-inset ring-rose-500/25 disabled:opacity-40"
            >
              Remove this pool
            </button>
          </div>
        </>
      ) : null}
    </div>
  );
}
