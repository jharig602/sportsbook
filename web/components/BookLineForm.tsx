"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { SignedInput } from "./SignedInput";
import type { Game, Market, Side } from "@/lib/types";

const FIELD =
  "mt-1 w-full rounded-lg border border-edge bg-ink px-2 py-1.5 text-[13px] text-slate-100 outline-none focus:border-sky-600";

/**
 * Type in what another book is showing.
 *
 * ESPN returns exactly one book, so nothing on this board can disagree with anything —
 * which is why the Edges page finds zero. A single number from a second book is the
 * missing input, and it is worth more than it looks: a point of line is 3.2 points of
 * win probability in the NFL and 2.6 in college, against a 2.4-point vig at -110. One
 * point of disagreement between books clears the hold outright.
 *
 * Deliberately manual and deliberately small. You already check your own book before
 * betting; this records what you saw there so the comparison can be priced instead of
 * eyeballed.
 */
export function BookLineForm({ game }: { game: Game }) {
  const router = useRouter();
  const [book, setBook] = useState("BetMGM");
  const [market, setMarket] = useState<Market>("spread");
  const [side, setSide] = useState<Side>("home");
  const [line, setLine] = useState("");
  const [price, setPrice] = useState("-110");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const sides: Side[] = market === "total" ? ["over", "under"] : ["home", "away"];

  function changeMarket(next: Market) {
    setMarket(next);
    setSide(next === "total" ? "over" : "home");
    setLine("");
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/book-lines", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event_id: game.eventId,
          league: game.league,
          book,
          market,
          side,
          line: market === "moneyline" ? null : line,
          price,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ ok: false, text: body.error ?? "Could not save." });
      } else {
        setMessage({ ok: true, text: "Saved. The comparison above now includes it." });
        router.refresh();
      }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">Book</span>
          <input value={book} onChange={(e) => setBook(e.target.value)} className={FIELD} />
        </label>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">Market</span>
          <select
            value={market}
            onChange={(e) => changeMarket(e.target.value as Market)}
            className={FIELD}
          >
            <option value="spread">Spread</option>
            <option value="total">Total</option>
            <option value="moneyline">Moneyline</option>
          </select>
        </label>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">Side</span>
          <select
            value={side}
            onChange={(e) => setSide(e.target.value as Side)}
            className={FIELD}
          >
            {sides.map((s) => (
              <option key={s} value={s}>
                {s === "home"
                  ? (game.homeTeam ?? "Home")
                  : s === "away"
                    ? (game.awayTeam ?? "Away")
                    : s}
              </option>
            ))}
          </select>
        </label>

        {market !== "moneyline" ? (
          <SignedInput label="Their line" value={line} onChange={setLine} step="0.5" placeholder="3.5" />
        ) : null}

        <SignedInput label="Their price" value={price} onChange={setPrice} placeholder="110" />
      </div>

      <button
        type="submit"
        disabled={busy}
        className="mt-3 w-full rounded-lg bg-sky-500/15 py-2 text-[14px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 transition-colors hover:bg-sky-500/25 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Add this line"}
      </button>

      {message ? (
        <p
          className={`mt-2 text-[12px] leading-relaxed ${
            message.ok ? "text-emerald-300/90" : "text-rose-300/90"
          }`}
        >
          {message.text}
        </p>
      ) : null}

      <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
        Enter the line as that book shows it from the side you picked. A mistyped number
        does not fail loudly here &mdash; it invents an edge that is not there.
      </p>
    </form>
  );
}
