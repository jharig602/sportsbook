"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface ParlayLegInput {
  eventId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
  market: string;
  side: string;
  line: number | null;
  price: number | null;
}

/**
 * Record a parlay you placed, as one ticket.
 *
 * The API has always accepted parlays -- one row per leg sharing an id, written in a
 * transaction -- but nothing on screen could send one, so a parlay could only be logged
 * by hand. The combined price is asked for rather than assumed: books round the product
 * of the legs their own way, and the ledger must pay out what the slip says, not what the
 * arithmetic says it should.
 */
export function LogParlay({
  legs,
  book,
  suggestedPrice,
}: {
  legs: ParlayLegInput[];
  book: string;
  suggestedPrice: number;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [stake, setStake] = useState("");
  const [price, setPrice] = useState(String(suggestedPrice));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          book,
          stake: Number(stake),
          parlay_price: Number(price),
          note: "parlay of the day",
          legs: legs.map((leg) => ({
            event_id: leg.eventId,
            league: leg.league,
            home_team: leg.homeTeam,
            away_team: leg.awayTeam,
            commence_time: leg.commenceTime,
            market: leg.market,
            side: leg.side,
            line: leg.market === "moneyline" ? null : leg.line,
            price: leg.price,
          })),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ ok: false, text: body.error ?? "Could not save." });
      } else {
        setMessage({ ok: true, text: "Parlay logged. It settles once every leg has finished." });
        setOpen(false);
        router.refresh();
      }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  const field =
    "tabular mt-0.5 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600";

  return (
    <div className="mt-2">
      {open ? (
        <div className="rounded-lg border border-edge/70 bg-raised/40 p-2.5">
          <div className="grid grid-cols-2 gap-2">
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">Stake</span>
              <input
                value={stake}
                inputMode="decimal"
                placeholder="10"
                onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ""))}
                className={field}
              />
            </label>
            <label className="block">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                Combined price on your slip
              </span>
              <input
                value={price}
                inputMode="numeric"
                onChange={(e) => setPrice(e.target.value.replace(/[^0-9+-]/g, ""))}
                className={field}
              />
            </label>
          </div>
          <button
            type="button"
            onClick={save}
            disabled={busy || !(Number(stake) > 0)}
            className="mt-2 w-full rounded-lg bg-sky-500/15 py-1.5 text-[12px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 disabled:opacity-50"
          >
            {busy ? "Saving…" : `Log this ${legs.length}-leg parlay at ${book}`}
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="inline-block rounded-md bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/25"
        >
          Log this parlay
        </button>
      )}
      {message ? (
        <p className={`mt-1.5 text-[11px] ${message.ok ? "text-emerald-300/90" : "text-rose-300/90"}`}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}
