"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface UnlinkedGame {
  eventId: string;
  league: "nfl" | "ncaaf";
  label: string;
  date: string;
}

export interface LinkCandidate {
  eventTicker: string;
  league: "nfl" | "ncaaf";
  title: string;
  date: string | null;
  reason: string;
}

/**
 * Board games with no Kalshi price, each with the same-day Kalshi games nothing could
 * match. Matching never guesses; this is where a person does, once, and the collector
 * applies the link on its next run.
 */
export function KalshiLinks({ games, candidates }: { games: UnlinkedGame[]; candidates: LinkCandidate[] }) {
  const router = useRouter();
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [status, setStatus] = useState<Record<string, string>>({});

  async function link(game: UnlinkedGame) {
    const eventTicker = choice[game.eventId];
    if (!eventTicker) return;
    const response = await fetch("/api/kalshi-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ eventTicker, eventId: game.eventId, league: game.league }),
    });
    setStatus((s) => ({ ...s, [game.eventId]: response.ok ? "Linked; prices arrive on the next collection run." : "Could not save." }));
    if (response.ok) router.refresh();
  }

  if (games.length === 0) {
    return <p className="text-[12px] text-slate-500">Every board game has a Kalshi price.</p>;
  }
  return (
    <ul className="space-y-2">
      {games.map((game) => {
        const options = candidates.filter((c) => c.league === game.league && c.date === game.date);
        return (
          <li key={game.eventId} className="rounded border border-edge/70 px-2.5 py-2">
            <p className="text-[12px] text-slate-200">{game.label}</p>
            {options.length === 0 ? (
              <p className="mt-0.5 text-[11px] text-slate-500">No unmatched Kalshi game that day; Kalshi may not list it yet.</p>
            ) : (
              <div className="mt-1.5 flex gap-1.5">
                <select
                  value={choice[game.eventId] ?? ""}
                  onChange={(e) => setChoice((c) => ({ ...c, [game.eventId]: e.target.value }))}
                  className="min-w-0 flex-1 rounded border border-edge bg-ink px-1.5 py-1 text-[12px] text-slate-100"
                >
                  <option value="">Same-day Kalshi games…</option>
                  {options.map((o) => (
                    <option key={o.eventTicker} value={o.eventTicker}>
                      {o.title}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={() => link(game)}
                  disabled={!choice[game.eventId]}
                  className="rounded border border-sky-700/60 bg-sky-500/10 px-2.5 text-[12px] text-sky-100 disabled:opacity-40"
                >
                  Link
                </button>
              </div>
            )}
            {status[game.eventId] ? <p className="mt-1 text-[11px] text-slate-500">{status[game.eventId]}</p> : null}
          </li>
        );
      })}
    </ul>
  );
}
