"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { formatPrice } from "@/lib/format";
import type { GameLines, ScoreLeg, ScoreModel } from "@/lib/joint-score";
import type { MarginModel } from "@/lib/probability";
import { priceSameGame, sgpEv } from "@/lib/sgp";

/**
 * Build a same-game parlay and see the price the book has to beat.
 *
 * Deliberately not a payout calculator. Every sportsbook ships one of those, and it
 * answers the one question that cannot lose you money: what this returns if it wins.
 * The question that decides the bet is whether the price on the slip is better than the
 * ticket is worth, and a book's own builder will never show you that.
 *
 * So the headline is the FAIR price, and the offered price is something you type in from
 * the slip. When the offered price is worse than fair the panel says so plainly, which
 * will be most of the time -- that is the honest finding about same-game parlays, not a
 * failure of the tool.
 */

interface Choice {
  key: string;
  label: string;
  leg: ScoreLeg;
  /** The board's price for this leg, when the board has one. */
  price: number | null;
}

export interface SgpBoardLeg {
  market: "spread" | "total" | "moneyline";
  side: "home" | "away" | "over" | "under";
  line: number | null;
  price: number | null;
}

const FIELD =
  "w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600";

export function SameGameParlay({
  eventId,
  league,
  homeTeam,
  awayTeam,
  commenceTime,
  lines,
  board,
  margin,
  score,
  book,
}: {
  eventId: string;
  league: string;
  homeTeam: string;
  awayTeam: string;
  commenceTime: string | null;
  lines: GameLines | null;
  board: SgpBoardLeg[];
  margin: MarginModel | null;
  score: ScoreModel | null;
  book: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [teamTotals, setTeamTotals] = useState<
    Array<{ key: string; team: "home" | "away"; side: "over" | "under"; line: string; price: string }>
  >([]);
  const [offered, setOffered] = useState("");
  const [stake, setStake] = useState("");
  const [bonus, setBonus] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const choices = useMemo<Choice[]>(() => {
    const out: Choice[] = [];
    for (const row of board) {
      if (row.market === "moneyline" && (row.side === "home" || row.side === "away")) {
        out.push({
          key: `ml-${row.side}`,
          label: `${row.side === "home" ? homeTeam : awayTeam} ML`,
          leg: { market: "moneyline", side: row.side },
          price: row.price,
        });
      } else if (row.market === "spread" && row.line !== null && (row.side === "home" || row.side === "away")) {
        out.push({
          key: `sp-${row.side}`,
          label: `${row.side === "home" ? homeTeam : awayTeam} ${row.line > 0 ? "+" : ""}${row.line}`,
          leg: { market: "spread", side: row.side, line: row.line },
          price: row.price,
        });
      } else if (row.market === "total" && row.line !== null && (row.side === "over" || row.side === "under")) {
        out.push({
          key: `to-${row.side}`,
          label: `${row.side === "over" ? "Over" : "Under"} ${row.line}`,
          leg: { market: "total", side: row.side, line: row.line },
          price: row.price,
        });
      }
    }
    return out;
  }, [board, homeTeam, awayTeam]);

  const chosen = choices.filter((c) => picked.includes(c.key));

  const typedLegs = teamTotals
    .filter((t) => t.line.trim() !== "" && Number.isFinite(Number(t.line)))
    .map((t) => ({
      key: t.key,
      label: `${t.team === "home" ? homeTeam : awayTeam} ${t.side} ${t.line}`,
      leg: {
        market: "team_total" as const,
        team: t.team,
        side: t.side,
        line: Number(t.line),
      },
      price: t.price.trim() === "" ? null : Number(t.price),
      team: t.team,
    }));

  const legs: ScoreLeg[] = [...chosen.map((c) => c.leg), ...typedLegs.map((t) => t.leg)];
  const allLabels = [...chosen.map((c) => c.label), ...typedLegs.map((t) => t.label)];

  const quote =
    margin && score && lines && legs.length >= 2
      ? priceSameGame(margin, score, lines, legs)
      : null;

  // The product of the legs' own prices: what these would pay from different games. The
  // book will offer less than this on one game, and the gap is what it charges for the
  // correlation. Only available when every leg has a price.
  const allPrices = [...chosen.map((c) => c.price), ...typedLegs.map((t) => t.price)];
  const independent = allPrices.every((p) => p !== null && Number.isFinite(p) && Math.abs(p) >= 100)
    ? allPrices.reduce<number>((acc, p) => acc * (p! > 0 ? 1 + p! / 100 : 1 + 100 / -p!), 1)
    : null;

  const offeredPrice = Number(offered);
  const validOffer = Number.isFinite(offeredPrice) && Math.abs(offeredPrice) >= 100;
  const ev = quote && validOffer ? sgpEv(quote, offeredPrice, { bonus }) : null;

  function toggle(key: string) {
    setPicked((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  }

  async function log() {
    setBusy(true);
    setMessage(null);
    try {
      const payload = {
        stake: Number(stake),
        parlay_price: offeredPrice,
        book,
        bonus,
        legs: [
          ...chosen.map((c) => ({
            event_id: eventId,
            league,
            home_team: homeTeam,
            away_team: awayTeam,
            commence_time: commenceTime,
            market: c.leg.market,
            side: c.leg.market === "moneyline" || c.leg.market === "spread" ? c.leg.side : c.leg.side,
            line: "line" in c.leg ? c.leg.line : null,
            price: c.price,
          })),
          ...typedLegs.map((t) => ({
            event_id: eventId,
            league,
            home_team: homeTeam,
            away_team: awayTeam,
            commence_time: commenceTime,
            // A team total is stored as a total with a team on it; it grades off the
            // same score, asking one side's points instead of both.
            market: "total",
            side: t.leg.side,
            team: t.team,
            line: t.leg.line,
            price: t.price,
          })),
        ],
      };
      const response = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage(body.error ?? "Could not save.");
      } else {
        setMessage("Logged.");
        setPicked([]);
        setTeamTotals([]);
        setOffered("");
        setStake("");
        router.refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full rounded-xl border border-edge bg-surface py-2.5 text-[13px] font-medium text-slate-300"
      >
        Build a same-game parlay
      </button>
    );
  }

  const unavailable = !margin || !score || !lines;

  return (
    <div className="rounded-xl border border-edge bg-surface px-3.5 py-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Same-game parlay
        </h2>
        <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-slate-500">
          close
        </button>
      </div>

      {unavailable ? (
        <p className="mt-2 text-[12px] text-slate-400">
          {!lines
            ? "This game has no posted spread and total yet, and both are needed to price a ticket off one scoreline."
            : "No fitted model for this league yet, so there is nothing honest to price against."}
        </p>
      ) : (
        <>
          <ul className="mt-2 grid grid-cols-2 gap-1">
            {choices.map((choice) => (
              <li key={choice.key}>
                <button
                  type="button"
                  onClick={() => toggle(choice.key)}
                  className={`w-full rounded-lg px-2 py-1.5 text-left text-[12px] ${
                    picked.includes(choice.key)
                      ? "bg-sky-500/15 text-sky-200 ring-1 ring-inset ring-sky-500/40"
                      : "bg-raised/60 text-slate-300"
                  }`}
                >
                  <span className="block truncate">{choice.label}</span>
                  <span className="block text-[10px] text-slate-500">
                    {choice.price === null ? "no price" : formatPrice(choice.price)}
                  </span>
                </button>
              </li>
            ))}
          </ul>

          {/*
            Team totals are typed rather than picked. They are the best legs on a
            same-game ticket -- a team total and that team's own spread are the most
            correlated pair a book offers -- and no feed in this app prices them, so the
            number has to come off the slip. The model prices them exactly either way.
          */}
          <div className="mt-2">
            {teamTotals.map((t, i) => (
              <div key={t.key} className="mb-1 grid grid-cols-4 gap-1">
                <select
                  value={t.team}
                  onChange={(e) =>
                    setTeamTotals((c) =>
                      c.map((x, j) => (j === i ? { ...x, team: e.target.value as "home" | "away" } : x)),
                    )
                  }
                  className={FIELD}
                >
                  <option value="home">{homeTeam}</option>
                  <option value="away">{awayTeam}</option>
                </select>
                <select
                  value={t.side}
                  onChange={(e) =>
                    setTeamTotals((c) =>
                      c.map((x, j) => (j === i ? { ...x, side: e.target.value as "over" | "under" } : x)),
                    )
                  }
                  className={FIELD}
                >
                  <option value="over">over</option>
                  <option value="under">under</option>
                </select>
                <input
                  value={t.line}
                  placeholder="24.5"
                  inputMode="decimal"
                  onChange={(e) =>
                    setTeamTotals((c) => c.map((x, j) => (j === i ? { ...x, line: e.target.value } : x)))
                  }
                  className={FIELD}
                />
                <input
                  value={t.price}
                  placeholder="-110"
                  inputMode="numeric"
                  onChange={(e) =>
                    setTeamTotals((c) => c.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))
                  }
                  className={FIELD}
                />
              </div>
            ))}
            <button
              type="button"
              onClick={() =>
                setTeamTotals((c) => [
                  ...c,
                  { key: `tt-${Date.now()}`, team: "home", side: "over", line: "", price: "" },
                ])
              }
              className="text-[11px] text-sky-300 underline underline-offset-2"
            >
              + team total
            </button>
          </div>

          {legs.length < 2 ? (
            <p className="mt-2 text-[12px] text-slate-500">Pick at least two legs.</p>
          ) : quote === null || quote.fairDecimal === null ? (
            <p className="mt-2 text-[12px] text-rose-300">
              These legs cannot all win, so there is no price for the ticket.
            </p>
          ) : (
            <div className="mt-2.5 rounded-lg bg-raised/50 px-2.5 py-2">
              <p className="text-[11px] text-slate-400">{allLabels.join("  +  ")}</p>
              <div className="mt-1.5 flex items-baseline gap-3">
                <span className="text-[20px] font-semibold text-slate-100">
                  {formatPrice(quote.fairAmerican!)}
                </span>
                <span className="text-[11px] text-slate-500">
                  fair price &middot; lands {(quote.win * 100).toFixed(1)}%
                  {quote.push > 0 ? `, pushes ${(quote.push * 100).toFixed(1)}%` : ""}
                </span>
              </div>
              <p className="mt-1 text-[11px] text-slate-400">
                Beat {formatPrice(quote.fairAmerican!)} and the ticket is worth taking.
              </p>

              {/*
                The correlation, stated rather than buried. This is the number a book's
                own builder silently charges for, and its direction is not obvious: legs
                that help each other make the ticket likelier and the fair price shorter.
              */}
              {Math.abs(quote.correlationShift) > 0.005 ? (
                <p className="mt-1.5 text-[11px] text-slate-500">
                  These legs {quote.correlationShift > 0 ? "help" : "fight"} each other:{" "}
                  {Math.abs(quote.correlationShift * 100).toFixed(0)}%{" "}
                  {quote.correlationShift > 0 ? "likelier" : "less likely"} than multiplying
                  them would say.
                </p>
              ) : null}

              {independent !== null ? (
                <p className="mt-1 text-[11px] text-slate-500">
                  From separate games these legs would pay{" "}
                  {formatPrice(
                    independent - 1 >= 1
                      ? Math.round((independent - 1) * 100)
                      : -Math.round(100 / (independent - 1)),
                  )}
                  . Anything less is what the book charges for one scoreline.
                </p>
              ) : null}

              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">
                    Price on the slip
                  </span>
                  <input
                    value={offered}
                    onChange={(e) => setOffered(e.target.value)}
                    placeholder="+380"
                    inputMode="numeric"
                    className={FIELD}
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase tracking-wide text-slate-500">Stake</span>
                  <input
                    value={stake}
                    onChange={(e) => setStake(e.target.value)}
                    placeholder="10"
                    inputMode="decimal"
                    className={FIELD}
                  />
                </label>
              </div>

              <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
                <input type="checkbox" checked={bonus} onChange={(e) => setBonus(e.target.checked)} />
                Bonus bet (stake is not returned)
              </label>

              {ev !== null ? (
                <p
                  className={`mt-1.5 text-[12px] ${ev > 0 ? "text-emerald-300" : "text-rose-300"}`}
                >
                  {ev > 0 ? "+" : ""}
                  {(ev * 100).toFixed(1)}% per dollar {bonus ? "of bonus face " : ""}at that
                  price.
                  {ev <= 0 ? " Below fair — the book is keeping the difference." : ""}
                </p>
              ) : null}

              <button
                type="button"
                onClick={log}
                disabled={busy || !validOffer || !(Number(stake) > 0)}
                className="mt-2 w-full rounded-lg bg-sky-500/15 py-2 text-[13px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 disabled:opacity-40"
              >
                {busy ? "Saving…" : "Log this ticket"}
              </button>
              {message ? <p className="mt-1.5 text-[11px] text-slate-400">{message}</p> : null}
            </div>
          )}
        </>
      )}
    </div>
  );
}
