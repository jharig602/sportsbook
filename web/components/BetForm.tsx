"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { SignedInput } from "./SignedInput";
import type { Game, Market, Side } from "@/lib/types";

const FIELD =
  "mt-1 w-full rounded-lg border border-edge bg-ink px-2 py-1.5 text-[13px] text-slate-100 outline-none focus:border-sky-600";

/**
 * Log a wager.
 *
 * The line and price default from whatever the board last saw, but stay editable —
 * what matters is the number actually taken at the book, not what our feed observed.
 * Recording the feed's price when you got a different one would make every later
 * measurement wrong in a way nothing downstream could detect.
 */
export function BetForm({ games }: { games: Game[] }) {
  const router = useRouter();
  const [eventId, setEventId] = useState(games[0]?.eventId ?? "");
  const [market, setMarket] = useState<Market>("spread");
  const [side, setSide] = useState<Side>("home");
  const [line, setLine] = useState("");
  const [price, setPrice] = useState("");
  const [stake, setStake] = useState("20");
  const [book, setBook] = useState("BetMGM");
  const [note, setNote] = useState("");
  const [bonus, setBonus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const game = useMemo(() => games.find((g) => g.eventId === eventId), [games, eventId]);
  const sides: Side[] = market === "total" ? ["over", "under"] : ["home", "away"];

  /** Pull the current number from the board, as a starting point only. */
  function prefill(nextMarket: Market, nextSide: Side) {
    const quote = game?.[nextMarket]?.[nextSide];
    setLine(quote?.line != null ? String(quote.line) : "");
    setPrice(quote?.price != null ? String(quote.price) : "");
  }

  function changeMarket(next: Market) {
    const nextSide: Side = next === "total" ? "over" : "home";
    setMarket(next);
    setSide(nextSide);
    prefill(next, nextSide);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event_id: eventId,
          league: game?.league,
          home_team: game?.homeTeam,
          away_team: game?.awayTeam,
          commence_time: game?.commenceTime,
          market,
          side,
          line: market === "moneyline" ? null : line,
          price,
          stake,
          book,
          note: note || null,
          bonus,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ ok: false, text: body.error ?? "Could not save." });
      } else {
        setMessage({ ok: true, text: "Logged. It settles automatically once the game finishes." });
        setNote("");
        router.refresh();
      }
    } catch (error) {
      setMessage({ ok: false, text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }

  if (games.length === 0) {
    return (
      <p className="text-[13px] text-slate-500">
        No upcoming games with prices to bet on yet.
      </p>
    );
  }

  return (
    <form onSubmit={submit}>
      <label className="block">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">Game</span>
        <select
          value={eventId}
          onChange={(e) => {
            setEventId(e.target.value);
            setLine("");
            setPrice("");
          }}
          className={FIELD}
        >
          {games.map((g) => (
            <option key={g.eventId} value={g.eventId}>
              {g.awayTeam} @ {g.homeTeam}
            </option>
          ))}
        </select>
      </label>

      <div className="mt-2 grid grid-cols-2 gap-2">
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
            onChange={(e) => {
              const next = e.target.value as Side;
              setSide(next);
              prefill(market, next);
            }}
            className={FIELD}
          >
            {sides.map((s) => (
              <option key={s} value={s}>
                {s === "home"
                  ? (game?.homeTeam ?? "Home")
                  : s === "away"
                    ? (game?.awayTeam ?? "Away")
                    : s}
              </option>
            ))}
          </select>
        </label>

        {market !== "moneyline" ? (
          <SignedInput
            label="Line"
            value={line}
            onChange={setLine}
            step="0.5"
            placeholder="3.5"
          />
        ) : null}

        <SignedInput
          label="Price you got"
          value={price}
          onChange={setPrice}
          placeholder="110"
        />

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">Stake</span>
          <input
            type="text"
            inputMode="decimal"
            value={stake}
            onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ""))}
            className={FIELD}
          />
        </label>

        <label className="block">
          <span className="text-[11px] uppercase tracking-wide text-slate-500">Book</span>
          <input
            value={book}
            onChange={(e) => setBook(e.target.value)}
            className={FIELD}
          />
        </label>
      </div>

      <label className="mt-2 flex items-center gap-2">
        <input
          type="checkbox"
          checked={bonus}
          onChange={(e) => setBonus(e.target.checked)}
          className="h-4 w-4 accent-sky-500"
        />
        <span className="text-[12px] text-slate-300">
          Bonus bet &mdash; stake is the book&rsquo;s, winnings only
        </span>
      </label>

      <label className="mt-2 block">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">
          Why (optional)
        </span>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="what made you take it"
          className={FIELD}
        />
      </label>

      <button
        type="submit"
        disabled={busy}
        className="mt-3 w-full rounded-lg bg-sky-500/15 py-2 text-[14px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 transition-colors hover:bg-sky-500/25 disabled:opacity-50"
      >
        {busy ? "Saving…" : "Log this bet"}
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
        Enter the price you actually got, not the one shown on the board. Recording our
        feed&rsquo;s number when you took a different one would make every later
        measurement wrong in a way nothing here could detect.
      </p>
    </form>
  );
}
