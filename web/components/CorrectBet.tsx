"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { mirrorSide } from "@/lib/correct";
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
 * The SIDE is editable, and it is the field most worth being able to fix. On the board
 * the two sides of a market are adjacent buttons, so picking the wrong one is the
 * easiest mistake to make and the worst to leave standing: the ledger reports a win
 * where there was a loss, and every rate computed from it inherits that.
 *
 * Flipping a spread's side flips its line with it. Home -3.5 becomes away +3.5, because
 * that is the same wager seen from the other end. Changing the side alone would store
 * "away -3.5" -- a bet nobody was offered, which grades cleanly against the wrong
 * question and looks entirely normal on screen.
 *
 * The game and the market stay fixed. Those are not typos, they are a different bet, and
 * a different bet should be entered as one.
 *
 * Cashing out rides the same path, because it is the same kind of event: something that
 * happened to a ticket after it was written, recorded as a new row rather than by
 * reaching back into the old one. It is not a mistake being fixed, but the mechanism is
 * identical and a second one would only be a second thing to keep in step.
 */
export function CorrectBet({ bet }: { bet: Bet }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [price, setPrice] = useState(String(bet.price));
  const [stake, setStake] = useState(String(bet.stake));
  const [line, setLine] = useState(bet.line === null ? "" : String(bet.line));
  const [side, setSide] = useState<string>(bet.side);
  const [team, setTeam] = useState<string>(bet.team ?? "");
  const [bonus, setBonus] = useState(bet.bonus === true);
  const [cashout, setCashout] = useState(
    bet.cashout === undefined || bet.cashout === null ? "" : String(bet.cashout),
  );
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
          side,
          team: team === "" ? null : team,
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

  /**
   * Switch sides, carrying the line across.
   *
   * A spread belongs to the side that took it: the same bet is home -3.5 or away +3.5,
   * never away -3.5. Totals and moneylines have no such mirror -- over 45.5 and under
   * 45.5 are the same number -- so only the spread's line moves.
   */
  function chooseSide(next: string) {
    const mirrored = mirrorSide(bet.market, line === "" ? null : Number(line), side, next);
    setSide(mirrored.side);
    setLine(mirrored.line === null ? "" : String(mirrored.line));
  }

  const sides =
    bet.market === "total"
      ? [
          { value: "over", label: "Over" },
          { value: "under", label: "Under" },
        ]
      : [
          { value: "home", label: bet.home_team ?? "Home" },
          { value: "away", label: bet.away_team ?? "Away" },
        ];

  const submit = () =>
    send(cashout.trim() === "" ? {} : { cashout: Number(cashout) });
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

      <label className="mt-1.5 block">
        <span className={caption}>Side</span>
        <div className="mt-1 grid grid-cols-2 gap-2">
          {sides.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => chooseSide(option.value)}
              className={`truncate rounded border px-2 py-1 text-[12px] ${
                side === option.value
                  ? "border-amber-500/60 bg-amber-500/15 text-amber-200"
                  : "border-edge bg-ink text-slate-300"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        {side !== bet.side ? (
          <span className="mt-1 block text-[10px] leading-snug text-amber-300/90">
            Switching sides{bet.market === "spread" ? " and flipping the line with it" : ""}.
            The original row stays in the ledger, marked as superseded.
          </span>
        ) : null}
      </label>

      {/*
        A team total's team is the same mistake in a different place: the line and the
        side can both be right while the points belong to the other team.
      */}
      {bet.market === "total" && bet.team ? (
        <label className="mt-2 block">
          <span className={caption}>Whose points</span>
          <div className="mt-1 grid grid-cols-2 gap-2">
            {[
              { value: "home", label: bet.home_team ?? "Home" },
              { value: "away", label: bet.away_team ?? "Away" },
            ].map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setTeam(option.value)}
                className={`truncate rounded border px-2 py-1 text-[12px] ${
                  team === option.value
                    ? "border-amber-500/60 bg-amber-500/15 text-amber-200"
                    : "border-edge bg-ink text-slate-300"
                }`}
              >
                {option.label}
              </button>
            ))}
          </div>
        </label>
      ) : null}

      <div className="mt-2 grid grid-cols-3 gap-2">
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

      <label className="mt-2 block">
        <span className={caption}>Cashed out for</span>
        <input
          value={cashout}
          inputMode="decimal"
          placeholder="leave empty unless you sold it back"
          onChange={(e) => setCashout(e.target.value)}
          className={`tabular ${field}`}
        />
        <span className="mt-1 block text-[10px] leading-snug text-slate-500">
          The cash the book actually paid. This is the only verdict in the ledger that is
          stored rather than worked out from the final score &mdash; once a ticket is sold
          back, the score stops deciding anything. The game is still graded underneath, so
          the record can show what holding would have paid.
        </span>
      </label>

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
