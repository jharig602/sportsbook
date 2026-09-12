"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { Bet } from "@/lib/settle";

/**
 * Fix a wager that was recorded wrongly.
 *
 * The bets table is append-only and nothing in it is ever updated, which is deliberate:
 * the verdict is derived from `game_results` at read time, so a corrected score corrects
 * the P&L by itself and there is no stored outcome to drift. The cost of that design was
 * that a row entered wrongly stayed wrong for good.
 *
 * So a correction is a NEW row naming the old one. Both are kept. What was first written
 * is part of the history even when it was mistaken, and a ledger you can quietly edit
 * has stopped being a ledger — the whole value of this table is that it records what was
 * actually staked, including the times it was recorded badly.
 *
 * Only the fields that are plausibly mistyped are offered. The game, market and side are
 * not editable here: getting those wrong is not a typo, it is a different bet, and it
 * should be entered as one.
 */
export function CorrectBet({ bet }: { bet: Bet }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(String(bet.price));
  const [stake, setStake] = useState(String(bet.stake));
  const [line, setLine] = useState(bet.line === null ? "" : String(bet.line));
  const [bonus, setBonus] = useState(bet.bonus === true);
  const [why, setWhy] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send(extra: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          league: bet.league,
          event_id: bet.event_id,
          home_team: bet.home_team,
          away_team: bet.away_team,
          commence_time: bet.commence_time,
          market: bet.market,
          side: bet.side,
          line: bet.market === "moneyline" ? null : Number(line),
          price: Number(price),
          stake: Number(stake),
          book: bet.book,
          model_probability: bet.model_probability,
          market_probability: bet.market_probability,
          bonus,
          supersedes: bet.bet_id,
          note: why.trim() || bet.note,
          ...extra,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not save the correction.");
        return;
      }
      setOpen(false);
      router.refresh();
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : "Could not save the correction.");
    } finally {
      setBusy(false);
    }
  }

  const submit = () => send({});
  // Removing is a tombstone, not a DELETE: the row stops counting and stops showing,
  // and the ledger still records that it was once written.
  const remove = () => send({ voided: true, note: why.trim() || "Removed" });

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-1 text-[10px] uppercase tracking-wide text-slate-600 underline underline-offset-2"
      >
        edit or remove
      </button>
    );
  }

  const field = "mt-1 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600";
  const caption = "text-[10px] uppercase tracking-wide text-slate-500";

  return (
    <div className="mt-2 rounded-lg border border-amber-700/40 bg-raised/40 p-2.5">
      <p className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
        Edit this bet
      </p>

      <div className="mt-1.5 grid grid-cols-3 gap-2">
        <label className="block">
          <span className={caption}>Price</span>
          <input
            value={price}
            inputMode="numeric"
            onChange={(e) => setPrice(e.target.value)}
            className={`tabular ${field}`}
          />
        </label>
        <label className="block">
          <span className={caption}>Stake</span>
          <input
            value={stake}
            inputMode="decimal"
            onChange={(e) => setStake(e.target.value)}
            className={`tabular ${field}`}
          />
        </label>
        {bet.market === "moneyline" ? (
          <div />
        ) : (
          <label className="block">
            <span className={caption}>Line</span>
            <input
              value={line}
              inputMode="decimal"
              onChange={(e) => setLine(e.target.value)}
              className={`tabular ${field}`}
            />
          </label>
        )}
      </div>

      <label className="mt-2 flex items-start gap-2">
        <input
          type="checkbox"
          checked={bonus}
          onChange={(e) => setBonus(e.target.checked)}
          className="mt-0.5"
        />
        <span className="text-[11px] leading-snug text-slate-400">
          Bonus bet &mdash; the stake is the book&rsquo;s, so only the winnings are yours.
          A losing one costs nothing; recorded as an ordinary wager it books the full
          stake as a loss.
        </span>
      </label>

      <label className="mt-2 block">
        <span className={caption}>What was wrong (optional)</span>
        <input
          value={why}
          onChange={(e) => setWhy(e.target.value)}
          placeholder={bet.note ?? "e.g. logged before the bonus flag existed"}
          className={field}
        />
      </label>

      {error ? <p className="mt-2 text-[11px] text-rose-300">{error}</p> : null}

      <div className="mt-2 flex gap-2">
        <button
          type="button"
          onClick={submit}
          disabled={busy}
          className="rounded-lg bg-amber-500/15 px-3 py-1.5 text-[12px] font-medium text-amber-200 ring-1 ring-inset ring-amber-500/30 disabled:opacity-40"
        >
          {busy ? "Saving…" : "Save correction"}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className="rounded-lg bg-rose-500/10 px-3 py-1.5 text-[12px] font-medium text-rose-300 ring-1 ring-inset ring-rose-500/25 disabled:opacity-40"
        >
          Remove
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          disabled={busy}
          className="ml-auto rounded-lg px-3 py-1.5 text-[12px] text-slate-500"
        >
          Cancel
        </button>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-slate-600">
        Both keep the original row rather than deleting it &mdash; corrected, or marked
        removed. It stops counting either way; it does not stop having been written.
      </p>
    </div>
  );
}
