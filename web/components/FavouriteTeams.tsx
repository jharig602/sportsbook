"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { themedTeams } from "@/lib/favourites";

/**
 * Teams you back every week whatever the board says.
 *
 * Framed as a filter rather than a recommendation, and the wording has to keep that
 * straight. The app has nothing useful to say about whether to bet your team — that
 * decision is made before it opens. What it can say is which market costs least, and
 * that is a real question with a real answer.
 *
 * One favourite also themes the app. Two does not, because two teams have no single
 * colour and picking the first would be arbitrary in a way the interface could not
 * explain.
 */
export function FavouriteTeams({ selected }: { selected: string[] }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const teams = themedTeams();

  async function save(next: string[]) {
    setBusy(true);
    try {
      await fetch("/api/favourites", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ teams: next }),
      });
      router.refresh();
    } finally {
      setBusy(false);
    }
  }

  const toggle = (team: string) =>
    save(selected.includes(team) ? selected.filter((t) => t !== team) : [...selected, team]);

  return (
    <div className="mb-3 rounded-xl border border-edge bg-surface px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline justify-between text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          My teams
        </span>
        <span className="text-[11px] text-slate-500">
          {selected.length === 0 ? "none" : selected.join(", ")}{" "}
          <span className="text-slate-600">{open ? "hide" : "edit"}</span>
        </span>
      </button>

      {open ? (
        <>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {teams.map((team) => {
              const on = selected.includes(team);
              return (
                <button
                  key={team}
                  type="button"
                  onClick={() => toggle(team)}
                  disabled={busy}
                  className={`rounded-lg px-2 py-1 text-[11px] disabled:opacity-40 ${
                    on
                      ? "bg-accent/15 text-accent ring-1 ring-inset ring-accent/30"
                      : "bg-raised text-slate-400"
                  }`}
                >
                  {team}
                </button>
              );
            })}
          </div>
          <p className="mt-2.5 text-[11px] leading-relaxed text-slate-600">
            This does not decide whether to bet them &mdash; you already have. The Shop
            page shows every way to back them this week ranked by what each costs, and
            with notifications on you get the cheapest one before each game, because a
            moneyline on a favourite and a spread at a book hanging a different number
            are not equally good. The bet of the day, the parlay and the same-game parlay
            also never suggest betting against them &mdash; totals are still fair game, since
            an over or an under picks no side.{" "}
            {selected.length === 1
              ? "One team also colours the app."
              : "Pick exactly one to colour the app; two teams have no single colour."}
          </p>
        </>
      ) : null}
    </div>
  );
}
