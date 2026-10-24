"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import positions from "@/config/player-positions.json";
import { searchGames } from "@/lib/bet-link";
import { STAT_LABEL, STAT_ORDER, type PropStat } from "@/lib/props";
import type { Game } from "@/lib/types";

const FIELD =
  "mt-0.5 w-full rounded-md border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600";
const LABEL = "block text-[10px] uppercase tracking-wide text-slate-500";
const PLAYERS = Object.keys(positions as Record<string, string>).sort();

type LegMarket = "moneyline" | "spread" | "total" | "prop";
/** How a prop's number reads: "at least 275" (over 274.5), or over/under a half-point line. */
type PropMode = "atLeast" | "over" | "under";

interface LegDraft {
  key: string;
  eventId: string;
  query: string;
  market: LegMarket;
  side: "home" | "away" | "over" | "under";
  line: string;
  price: string;
  player: string;
  stat: PropStat;
  mode: PropMode;
}

const blank = (eventId = ""): LegDraft => ({
  key: `${Date.now()}-${Math.random()}`,
  eventId,
  query: "",
  market: "moneyline",
  side: "home",
  line: "",
  price: "",
  player: "",
  stat: "anytime_td",
  mode: "atLeast",
});

/**
 * Log a parlay or same-game parlay, leg by leg -- including player props.
 *
 * A prop leg is a player, a stat and a number: "Goff 275+ passing yards" is AT LEAST 275,
 * stored as over 274.5; an anytime TD needs no number. Legs default to the previous leg's
 * game, so a same-game ticket is quick. Each leg's own price is optional -- a same-game
 * slip usually shows only the combined price, and that is what the ticket settles on.
 * Enter the price you actually got (the boosted one, if a boost applied).
 */
export function ParlayForm({ games, started = [] }: { games: Game[]; started?: string[] }) {
  const router = useRouter();
  const startedSet = useMemo(() => new Set(started), [started]);
  const [open, setOpen] = useState(false);
  const [legs, setLegs] = useState<LegDraft[]>([blank()]);
  const [book, setBook] = useState("DraftKings");
  const [price, setPrice] = useState("");
  const [stake, setStake] = useState("10");
  const [bonus, setBonus] = useState(false);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const byId = useMemo(() => new Map(games.map((g) => [g.eventId, g])), [games]);
  const set = (i: number, patch: Partial<LegDraft>) =>
    setLegs((all) => all.map((leg, j) => (j === i ? { ...leg, ...patch } : leg)));

  function payload() {
    return {
      book,
      parlay_price: Number(price),
      stake: Number(stake),
      bonus,
      note: note.trim() || null,
      legs: legs.map((leg) => {
        const game = byId.get(leg.eventId);
        const base = {
          event_id: leg.eventId,
          league: game?.league ?? "nfl",
          home_team: game?.homeTeam ?? null,
          away_team: game?.awayTeam ?? null,
          commence_time: game?.commenceTime ?? null,
          market: leg.market,
          price: leg.price.trim() === "" ? null : Number(leg.price),
        };
        if (leg.market === "prop") {
          const n = Number(leg.line);
          const isTd = leg.stat === "anytime_td" || leg.stat === "first_td";
          return {
            ...base,
            prop_player: leg.player.trim(),
            prop_stat: leg.stat,
            side: leg.mode === "under" ? "under" : "over",
            line: isTd ? 0.5 : leg.mode === "atLeast" ? n - 0.5 : n,
          };
        }
        return {
          ...base,
          side: leg.side,
          line: leg.market === "moneyline" || leg.line.trim() === "" ? null : Number(leg.line),
        };
      }),
    };
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload()),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ ok: false, text: body.error ?? "Could not save." });
      } else {
        setMessage({ ok: true, text: `Logged a ${legs.length}-leg ticket.` });
        setLegs([blank()]);
        setPrice("");
        setNote("");
        setBonus(false);
        router.refresh();
      }
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
        className="w-full rounded-lg border border-edge bg-surface py-2 text-[13px] text-slate-300"
      >
        Log a parlay or same-game parlay
      </button>
    );
  }

  return (
    <div>
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Log a parlay</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-slate-500">
          close
        </button>
      </div>

      <datalist id="dissent-players">
        {PLAYERS.map((p) => (
          <option key={p} value={p} />
        ))}
      </datalist>

      <ol className="mt-2 space-y-2">
        {legs.map((leg, i) => {
          const game = byId.get(leg.eventId);
          const matches = leg.eventId ? [] : searchGames(games, leg.query).slice(0, 6);
          const isTd = leg.stat === "anytime_td" || leg.stat === "first_td";
          return (
            <li key={leg.key} className="rounded-lg border border-edge/70 px-2.5 py-2">
              <div className="flex items-baseline justify-between">
                <span className="text-[11px] text-slate-400">Leg {i + 1}</span>
                {legs.length > 1 ? (
                  <button
                    type="button"
                    onClick={() => setLegs((all) => all.filter((_, j) => j !== i))}
                    className="text-[11px] text-slate-500"
                  >
                    remove
                  </button>
                ) : null}
              </div>

              {game ? (
                <p className="mt-0.5 text-[12px] text-slate-200">
                  {game.awayTeam} @ {game.homeTeam}
                  {startedSet.has(game.eventId) ? <span className="text-slate-500"> · started</span> : null}{" "}
                  <button type="button" onClick={() => set(i, { eventId: "", query: "" })} className="text-[11px] text-sky-400">
                    change
                  </button>
                </p>
              ) : (
                <div>
                  <input
                    value={leg.query}
                    onChange={(e) => set(i, { query: e.target.value })}
                    placeholder="Search a team"
                    className={FIELD}
                  />
                  {leg.query ? (
                    <ul className="mt-1 space-y-0.5">
                      {matches.map((g) => (
                        <li key={g.eventId}>
                          <button
                            type="button"
                            onClick={() => set(i, { eventId: g.eventId })}
                            className="w-full rounded px-1.5 py-1 text-left text-[12px] text-slate-300 hover:bg-raised"
                          >
                            {g.awayTeam} @ {g.homeTeam}
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              )}

              {game ? (
                <div className="mt-1.5 grid grid-cols-2 gap-1.5">
                  <label className={LABEL}>
                    Market
                    <select
                      value={leg.market}
                      onChange={(e) => {
                        const market = e.target.value as LegMarket;
                        set(i, { market, side: market === "total" ? "over" : "home", line: "" });
                      }}
                      className={FIELD}
                    >
                      <option value="moneyline">Moneyline</option>
                      <option value="spread">Spread</option>
                      <option value="total">Total</option>
                      <option value="prop">Player prop</option>
                    </select>
                  </label>

                  {leg.market === "prop" ? (
                    <label className={LABEL}>
                      Player
                      <input
                        value={leg.player}
                        onChange={(e) => set(i, { player: e.target.value })}
                        list="dissent-players"
                        placeholder="Jared Goff"
                        className={FIELD}
                      />
                    </label>
                  ) : (
                    <label className={LABEL}>
                      Side
                      <select value={leg.side} onChange={(e) => set(i, { side: e.target.value as LegDraft["side"] })} className={FIELD}>
                        {leg.market === "total" ? (
                          <>
                            <option value="over">Over</option>
                            <option value="under">Under</option>
                          </>
                        ) : (
                          <>
                            <option value="home">{game.homeTeam}</option>
                            <option value="away">{game.awayTeam}</option>
                          </>
                        )}
                      </select>
                    </label>
                  )}

                  {leg.market === "prop" ? (
                    <>
                      <label className={LABEL}>
                        Stat
                        <select value={leg.stat} onChange={(e) => set(i, { stat: e.target.value as PropStat })} className={FIELD}>
                          {STAT_ORDER.map((s) => (
                            <option key={s} value={s}>
                              {STAT_LABEL[s]}
                            </option>
                          ))}
                        </select>
                      </label>
                      {isTd ? (
                        <p className="self-end pb-1 text-[11px] text-slate-500">Scores a TD: no number needed.</p>
                      ) : (
                        <div className="grid grid-cols-2 gap-1">
                          <label className={LABEL}>
                            Type
                            <select value={leg.mode} onChange={(e) => set(i, { mode: e.target.value as PropMode })} className={FIELD}>
                              <option value="atLeast">At least</option>
                              <option value="over">Over</option>
                              <option value="under">Under</option>
                            </select>
                          </label>
                          <label className={LABEL}>
                            {leg.mode === "atLeast" ? "N+" : "Line"}
                            <input
                              value={leg.line}
                              onChange={(e) => set(i, { line: e.target.value })}
                              inputMode="decimal"
                              placeholder={leg.mode === "atLeast" ? "275" : "274.5"}
                              className={FIELD}
                            />
                          </label>
                        </div>
                      )}
                    </>
                  ) : leg.market !== "moneyline" ? (
                    <label className={LABEL}>
                      Line
                      <input
                        value={leg.line}
                        onChange={(e) => set(i, { line: e.target.value })}
                        inputMode="decimal"
                        placeholder={leg.market === "total" ? "47.5" : "-3.5"}
                        className={FIELD}
                      />
                    </label>
                  ) : null}

                  <label className={LABEL}>
                    Leg price (optional)
                    <input
                      value={leg.price}
                      onChange={(e) => set(i, { price: e.target.value })}
                      inputMode="numeric"
                      placeholder="-110"
                      className={FIELD}
                    />
                  </label>
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>

      <button
        type="button"
        onClick={() => setLegs((all) => [...all, blank(all[all.length - 1]?.eventId ?? "")])}
        className="mt-1.5 text-[12px] text-sky-300 underline underline-offset-2"
      >
        + add a leg
      </button>

      <div className="mt-2.5 grid grid-cols-3 gap-1.5">
        <label className={LABEL}>
          Book
          <input value={book} onChange={(e) => setBook(e.target.value)} className={FIELD} />
        </label>
        <label className={LABEL}>
          Combined price
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="numeric" placeholder="+195" className={FIELD} />
        </label>
        <label className={LABEL}>
          Stake
          <input value={stake} onChange={(e) => setStake(e.target.value)} inputMode="decimal" className={FIELD} />
        </label>
      </div>
      <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-400">
        <input type="checkbox" checked={bonus} onChange={(e) => setBonus(e.target.checked)} />
        Bonus bet (stake is the book&rsquo;s)
      </label>
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="Note (optional): boost, why"
        className={`${FIELD} mt-1.5`}
      />
      <p className="mt-1 text-[10px] leading-snug text-slate-600">
        Enter the price you actually got &mdash; the boosted one if a boost applied, or the
        ticket settles at the wrong payout. Player-prop legs are marked won or lost on the
        Bets page once the game is over.
      </p>
      <button
        type="button"
        onClick={save}
        disabled={busy || legs.length < 2 || !(Math.abs(Number(price)) >= 100) || !(Number(stake) > 0)}
        className="mt-2 w-full rounded-lg bg-sky-500/15 py-2 text-[13px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 disabled:opacity-40"
      >
        {busy ? "Saving…" : `Log this ${legs.length}-leg ticket`}
      </button>
      {message ? (
        <p className={`mt-1.5 text-[12px] ${message.ok ? "text-emerald-300" : "text-rose-300"}`}>{message.text}</p>
      ) : null}
    </div>
  );
}
