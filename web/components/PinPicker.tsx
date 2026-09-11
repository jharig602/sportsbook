"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";

import { parsePins, serializePins, withPin } from "@/lib/pins";

/**
 * Fix one week to a team of your choosing and see what it costs.
 *
 * Writes to the URL rather than to component state, so the answer is reachable: a
 * pinned season survives a refresh, can be sent to someone, and is thrown away when the
 * tab closes. The whole plan is recomputed on the server against the constraint, which
 * is the only way the number underneath it can be trusted — re-ranking the visible rows
 * on the client would leave the remaining seventeen weeks unchanged and report a
 * survival figure for a season nobody is playing.
 *
 * Deliberately separate from "mark used" in `PoolPicker`. This is a question about a
 * week; that is a record of what you actually submitted. Letting an experiment write
 * itself into your history would be the worse of the two mistakes by a distance.
 */
export function PinPicker({
  week,
  options,
  current,
  pinned,
}: {
  week: number;
  /** Teams playable this week, best first. Already filtered of teams you have spent. */
  options: Array<{ team: string; winProbability: number }>;
  /** The team the plan is currently on, pinned or not. */
  current: string | null;
  pinned: boolean;
}) {
  const router = useRouter();
  const params = useSearchParams();
  const [busy, startTransition] = useTransition();

  function choose(team: string) {
    const pins = parsePins(params.get("pin"));
    // Choosing the team the planner already wanted is a release, not a pin: it stops
    // the URL filling up with constraints that constrain nothing.
    const next = withPin(pins, week, team === "" ? null : team);
    const query = new URLSearchParams(params.toString());
    const encoded = serializePins(next);
    if (encoded) query.set("pin", encoded);
    else query.delete("pin");
    startTransition(() => {
      router.push(`/survivor?${query.toString()}`, { scroll: false });
    });
  }

  return (
    <div className="mt-1.5 flex items-center gap-1.5">
      <select
        value={pinned && current ? current : ""}
        disabled={busy}
        onChange={(event) => choose(event.target.value)}
        aria-label={`Pin week ${week}`}
        className={`min-w-0 flex-1 truncate rounded border bg-ink px-1.5 py-1 text-[11px] outline-none focus:border-sky-600 disabled:opacity-50 ${
          pinned ? "border-amber-600/60 text-amber-200" : "border-edge text-slate-400"
        }`}
      >
        <option value="">
          {pinned ? "— release this week —" : "try a different team…"}
        </option>
        {options.map((option) => (
          <option key={option.team} value={option.team}>
            {option.team} · {(option.winProbability * 100).toFixed(0)}%
          </option>
        ))}
      </select>
      {pinned ? (
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-wide text-amber-400/80">
          pinned
        </span>
      ) : null}
    </div>
  );
}
