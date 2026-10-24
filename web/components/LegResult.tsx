"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const CHOICES = [
  { result: "won", label: "Hit" },
  { result: "lost", label: "Missed" },
  { result: "void", label: "Void" },
] as const;

/**
 * Settle a player-prop leg by hand: no final score decides a player's stat. Writes a new
 * result row (the latest counts), so a wrong tap is fixed by tapping again.
 */
export function LegResult({ betId, current }: { betId: string; current: string | null }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(current === null);
  const [error, setError] = useState<string | null>(null);

  async function record(result: string) {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/bets/leg-result", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bet_id: betId, result }),
    });
    setBusy(false);
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      setError(body.error ?? "Could not save.");
      return;
    }
    setEditing(false);
    router.refresh();
  }

  if (!editing) {
    return (
      <button type="button" onClick={() => setEditing(true)} className="ml-1 text-[10px] text-slate-600 underline">
        change
      </button>
    );
  }
  return (
    <span className="ml-1 inline-flex items-center gap-1">
      {CHOICES.map((c) => (
        <button
          key={c.result}
          type="button"
          disabled={busy}
          onClick={() => record(c.result)}
          className={`rounded border px-1.5 text-[10px] ${
            c.result === "won"
              ? "border-emerald-700/60 text-emerald-300"
              : c.result === "lost"
                ? "border-rose-700/60 text-rose-300"
                : "border-edge text-slate-400"
          } disabled:opacity-40`}
        >
          {c.label}
        </button>
      ))}
      {error ? <span className="text-[10px] text-rose-300">{error}</span> : null}
    </span>
  );
}
