"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Log a survivor pick to the ledger as a moneyline bet.
 *
 * Deliberately shows the expected return on the button itself rather than only after
 * the fact. A survivor pick is chosen for the highest chance of winning, with no
 * regard to price, and that is usually a poor bet: the number here is normally
 * negative, and hiding it behind a tap would be the app quietly encouraging something
 * its own arithmetic says is a bad idea.
 */
export function LogPickButton({
  eventId,
  league,
  homeTeam,
  awayTeam,
  commenceTime,
  side,
  price,
  book,
  team,
  expectedRoi,
  week,
}: {
  eventId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  side: "home" | "away";
  price: number;
  book: string;
  team: string;
  expectedRoi: number | null;
  week: number;
}) {
  const router = useRouter();
  const [stake, setStake] = useState("5");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const roi = expectedRoi === null ? null : (expectedRoi * 100).toFixed(1);

  async function submit() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event_id: eventId,
          league,
          home_team: homeTeam,
          away_team: awayTeam,
          commence_time: commenceTime,
          market: "moneyline",
          side,
          line: null,
          price,
          stake,
          book,
          note: `survivor week ${week}: ${team}`,
        }),
      });
      const body = await response.json();
      setMessage(
        response.ok
          ? { ok: true, text: "Logged. It settles automatically once the game finishes." }
          : { ok: false, text: body.error ?? "Could not save." },
      );
      if (response.ok) router.refresh();
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1.5 rounded-lg bg-slate-700/40 px-2.5 py-1 text-[11px] font-medium text-slate-300"
      >
        Bet {price > 0 ? "+" : ""}
        {price} at {book}
        {roi !== null ? (
          <span className={expectedRoi! > 0 ? "text-emerald-300" : "text-slate-500"}>
            {" "}
            ({expectedRoi! > 0 ? "+" : ""}
            {roi}%)
          </span>
        ) : null}
      </button>
    );
  }

  return (
    <div className="mt-1.5 rounded-lg bg-slate-800/50 px-2.5 py-2">
      <div className="flex items-center gap-2">
        <span className="text-[11px] text-slate-400">$</span>
        <input
          type="text"
          inputMode="decimal"
          value={stake}
          onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ""))}
          className="tabular w-16 rounded border border-edge bg-ink px-1.5 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600"
        />
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-lg bg-sky-500/15 px-2.5 py-1 text-[12px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Log it"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="text-[11px] text-slate-500"
        >
          Cancel
        </button>
      </div>
      {roi !== null && expectedRoi! <= 0 ? (
        <p className="mt-1.5 text-[10px] leading-relaxed text-amber-400/80">
          Expected return {roi}%. A survivor pick is chosen for safety, not value, and a
          heavy favourite is where the vig bites hardest.
        </p>
      ) : null}
      {message ? (
        <p
          className={`mt-1.5 text-[11px] leading-relaxed ${
            message.ok ? "text-emerald-300/90" : "text-rose-300/90"
          }`}
        >
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
