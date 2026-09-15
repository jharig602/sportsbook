"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import { SignedInput } from "./SignedInput";
import { searchGames, type BetPrefill } from "@/lib/bet-link";
import type { Game, Market, Side } from "@/lib/types";

const FIELD =
  "mt-1 w-full rounded-lg border border-edge bg-ink px-2 py-1.5 text-[13px] text-slate-100 outline-none focus:border-sky-600";

/** How many search matches to list. A phone screen, not a spreadsheet. */
const MATCHES_SHOWN = 8;

/**
 * Log a wager.
 *
 * The line and price default from whatever the board last saw, but stay editable —
 * what matters is the number actually taken at the book, not what our feed observed.
 * Recording the feed's price when you got a different one would make every later
 * measurement wrong in a way nothing downstream could detect.
 *
 * The game is found by typing, not by scrolling. The old dropdown held the first eighty
 * upcoming games in kickoff order, which on a college Saturday is not even all of them
 * — the game you bet could simply be absent, with nothing to say so. And a bet logged
 * after kickoff could never be found at all, because started games were not offered.
 * Both are included now, started ones marked, and every word typed must appear in one
 * of the two team names.
 */
export function BetForm({
  games,
  started = [],
  initial = null,
}: {
  games: Game[];
  /** Event ids that have already kicked off. Still loggable; labelled as such. */
  started?: string[];
  /** Filled in from a "log this" link elsewhere in the app. */
  initial?: BetPrefill | null;
}) {
  const router = useRouter();
  const startedSet = useMemo(() => new Set(started), [started]);
  const initialGame = initial ? games.find((g) => g.eventId === initial.eventId) : undefined;

  const [eventId, setEventId] = useState(initialGame?.eventId ?? "");
  const [query, setQuery] = useState("");
  const [market, setMarket] = useState<Market>(initial?.market ?? "spread");
  const [side, setSide] = useState<Side>(
    initial?.side ?? (initial?.market === "total" ? "over" : "home"),
  );
  // A link that carries a number uses it; one that does not starts from the board.
  const [line, setLine] = useState(() => {
    if (initial?.line !== undefined && initial.line !== null) return String(initial.line);
    const quote = initialGame?.[initial?.market ?? "spread"]?.[initial?.side ?? "home"];
    return quote?.line != null ? String(quote.line) : "";
  });
  const [price, setPrice] = useState(() => {
    if (initial?.price !== undefined && initial.price !== null) return String(initial.price);
    const quote = initialGame?.[initial?.market ?? "spread"]?.[initial?.side ?? "home"];
    return quote?.price != null ? String(quote.price) : "";
  });
  const [stake, setStake] = useState(initial?.stake !== undefined ? String(initial.stake) : "20");
  const [book, setBook] = useState(initial?.book ?? "BetMGM");
  const [note, setNote] = useState("");
  const [bonus, setBonus] = useState(initial?.bonus === true);
  // For a ticket already sold back by the time it is written down. Usually empty: most
  // bets are logged when struck, and cashing out then happens through CorrectBet.
  const [cashout, setCashout] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const game = useMemo(() => games.find((g) => g.eventId === eventId), [games, eventId]);
  const matches = useMemo(() => searchGames(games, query).slice(0, MATCHES_SHOWN), [games, query]);
  const sides: Side[] = market === "total" ? ["over", "under"] : ["home", "away"];

  /** Pull the current number from the board, as a starting point only. */
  function prefill(target: Game | undefined, nextMarket: Market, nextSide: Side) {
    const quote = target?.[nextMarket]?.[nextSide];
    setLine(quote?.line != null ? String(quote.line) : "");
    setPrice(quote?.price != null ? String(quote.price) : "");
  }

  function choose(next: Game) {
    setEventId(next.eventId);
    setQuery("");
    prefill(next, market, side);
  }

  function changeMarket(next: Market) {
    const nextSide: Side = next === "total" ? "over" : "home";
    setMarket(next);
    setSide(nextSide);
    prefill(game, next, nextSide);
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!game) {
      setMessage({ ok: false, text: "Pick the game first — type a team name above." });
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/bets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event_id: eventId,
          league: game.league,
          home_team: game.homeTeam,
          away_team: game.awayTeam,
          commence_time: game.commenceTime,
          market,
          side,
          line: market === "moneyline" ? null : line,
          price,
          stake,
          book,
          note: note || null,
          bonus,
          cashout: cashout.trim() === "" ? null : Number(cashout),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage({ ok: false, text: body.error ?? "Could not save." });
      } else {
        setMessage({ ok: true, text: "Logged. It settles automatically once the game finishes." });
        setNote("");
        setCashout("");
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
        No upcoming or recent games with prices to bet on yet.
      </p>
    );
  }

  const teamLabel = (g: Game) => `${g.awayTeam ?? "Away"} @ ${g.homeTeam ?? "Home"}`;

  return (
    <form onSubmit={submit}>
      {initial && !initialGame ? (
        // Said rather than silently ignored: a link that opens a blank form looks like
        // the link did nothing, and the natural next step is to trust the blank form.
        <p className="mb-2 rounded-lg bg-amber-500/10 px-2.5 py-2 text-[12px] leading-relaxed text-amber-200/90">
          That game is no longer on the board &mdash; more than two days past kickoff, or
          never priced. Find it by name below if it is still listed.
        </p>
      ) : null}

      <div className="block">
        <span className="text-[11px] uppercase tracking-wide text-slate-500">Game</span>
        {game ? (
          <div className="mt-1 flex items-center gap-2 rounded-lg border border-sky-700/60 bg-sky-500/[0.06] px-2.5 py-2">
            <span className="min-w-0 flex-1 truncate text-[13px] text-slate-100">
              {teamLabel(game)}
            </span>
            {startedSet.has(game.eventId) ? (
              <span className="shrink-0 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-amber-300">
                started
              </span>
            ) : null}
            <button
              type="button"
              onClick={() => setEventId("")}
              className="shrink-0 text-[11px] text-sky-300 underline underline-offset-2"
            >
              change
            </button>
          </div>
        ) : (
          <>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type a team — e.g. browns, or cle jax"
              autoComplete="off"
              autoCorrect="off"
              spellCheck={false}
              className={FIELD}
            />
            <div className="mt-1 overflow-hidden rounded-lg border border-edge/70">
              {matches.length === 0 ? (
                <p className="px-2.5 py-2 text-[12px] text-slate-500">
                  Nothing matches &ldquo;{query}&rdquo;.
                </p>
              ) : (
                matches.map((g) => (
                  <button
                    key={g.eventId}
                    type="button"
                    onClick={() => choose(g)}
                    className="flex w-full items-center gap-2 border-b border-edge/50 px-2.5 py-2 text-left last:border-b-0 hover:bg-raised/60"
                  >
                    <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200">
                      {teamLabel(g)}
                    </span>
                    <span className="shrink-0 text-[10px] uppercase tracking-wide text-slate-500">
                      {g.league}
                    </span>
                    {startedSet.has(g.eventId) ? (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-amber-300/90">
                        started
                      </span>
                    ) : null}
                  </button>
                ))
              )}
            </div>
            {query.trim() === "" ? (
              <p className="mt-1 text-[11px] text-slate-600">
                Soonest kickoff first. Games that started in the last two days are listed
                after them, so a bet logged late can still be found.
              </p>
            ) : null}
          </>
        )}
      </div>

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
              prefill(game, market, next);
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
          Cashed out for (optional)
        </span>
        <input
          value={cashout}
          inputMode="decimal"
          onChange={(e) => setCashout(e.target.value)}
          placeholder="only if you already sold it back"
          className={`tabular ${FIELD}`}
        />
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
        disabled={busy || !game}
        className="mt-3 w-full rounded-lg bg-sky-500/15 py-2 text-[14px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 transition-colors hover:bg-sky-500/25 disabled:opacity-50"
      >
        {busy ? "Saving…" : game ? "Log this bet" : "Pick a game first"}
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
        {initialGame
          ? "Filled in from the screen you tapped. Check the price against what the book actually gave you before saving — "
          : "Enter the price you actually got, not the one shown on the board — "}
        recording our feed&rsquo;s number when you took a different one would make every
        later measurement wrong in a way nothing here could detect.
      </p>
    </form>
  );
}
