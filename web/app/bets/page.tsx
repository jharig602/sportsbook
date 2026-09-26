import { BetForm } from "@/components/BetForm";
import { parseBetPrefill } from "@/lib/bet-link";
import { TeamLogo } from "@/components/TeamLogo";
import { Banner, Card, Empty, NotAdvice, PageHeader, Pill, Stats } from "@/components/ui";
import { CorrectBet } from "@/components/CorrectBet";
import { listBets } from "@/lib/bets-db";
import { Freshness } from "@/components/Freshness";
import { getData } from "@/lib/data";
import { LedgerTransfer } from "@/components/LedgerTransfer";
import { currentSession } from "@/lib/session";
import { databaseUrl } from "@/lib/env";
import { formatKickoff, formatLeague, formatLine, formatPercent, formatPrice } from "@/lib/format";
import { activeBets, tally, type Bet, type GradedRow, type Score } from "@/lib/settle";
import { allBookLines } from "@/lib/book-lines";
import { fairChance, openSummary } from "@/lib/open-summary";
import { ledgerSections } from "@/lib/ordering";
import { liveGamesFor } from "@/lib/live-scores";
import { liveChance, scoreLine, type LiveGame } from "@/lib/live-value";
import type { ScoreModel } from "@/lib/joint-score";
import type { League, Side } from "@/lib/types";

export const dynamic = "force-dynamic";

const OUTCOME_TONE: Record<string, string> = {
  won: "bg-emerald-500/12 text-emerald-300",
  lost: "bg-rose-500/12 text-rose-300",
  push: "bg-slate-600/30 text-slate-300",
  open: "bg-sky-500/12 text-sky-300",
  // Amber rather than green: a cash-out made money here, but it is not a win, and
  // colouring it like one would let the record read as more right than it was.
  cashed: "bg-amber-500/12 text-amber-300",
};

/**
 * What holding would have paid, next to what was taken.
 *
 * Shown on every graded cash-out because the decision is otherwise unauditable:
 * selling early feels correct whenever the bet would have lost and wrong whenever it
 * would have won, and nobody keeps score of that honestly from memory.
 */
function HeldInstead({ took, held }: { took: number; held: number }) {
  const difference = held - took;
  if (Math.abs(difference) < 0.005) return null;
  return (
    <p className="mt-1 text-[11px] text-slate-500">
      Holding would have paid {money(held)} &mdash;{" "}
      <span className={difference > 0 ? "text-slate-400" : "text-emerald-400/80"}>
        {difference > 0 ? `${money(difference)} left on the table` : `${money(-difference)} saved`}
      </span>
    </p>
  );
}

/**
 * What an open ticket is worth to hold: the line a cash-out offer has to clear.
 *
 * Books price cash-outs below this -- the offer carries their margin -- so an offer
 * under it is paying you to hand the book part of your ticket. Before kickoff it is the
 * other books' fair price; once a game is on it is re-priced from the live score and
 * clock (`live-value.ts`). If the live score cannot be read, it says so and shows the
 * pregame figure rather than passing a stale number off as live.
 */
type Hold = { chance: number; value: number; started: boolean };
function HoldValue({ hold, live, why }: { hold?: Hold; live?: string | null; why?: string | null }) {
  if (!hold) return null;
  const stale = hold.started && !live;
  // ESPN's short status for a finished game starts "Final" ("Final", "Final/OT").
  const over = live ? /· Final/.test(live) : false;
  if (over && live) {
    return (
      <p className="mt-1 text-[11px] text-slate-500">
        <span className="font-medium text-slate-300">{live.replace(/ · Final.*$/, "")} · Final</span>{" "}
        &mdash; {hold.chance >= 0.5 ? "a winner" : "a loser"}; it settles here once the collector
        records the result.
      </p>
    );
  }
  return (
    <p className="mt-1 text-[11px] text-slate-500">
      {live ? <span className="font-medium text-emerald-300/90">Live · {live} · </span> : null}
      {stale ? "Pregame worth " : live ? "Worth now " : "Worth "}
      <span className="tabular text-slate-300">${hold.value.toFixed(2)}</span> to hold (
      {Math.round(hold.chance * 100)}% to win)
      {stale
        ? ` — ${why ?? "the live score could not be read"}, so this is the pregame figure.`
        : " — only cash out above this."}
    </p>
  );
}

function money(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

/**
 * A parlay, shown as one ticket with its legs beneath.
 *
 * The tally already counts it once, so this only has to make it look like what it is:
 * a single stake on several results, any one of which can end it.
 */
function ParlayRow({ bet, legs, hold, live, why }: { bet: GradedRow; legs: Bet[]; hold?: Hold; live?: string | null; why?: string | null }) {
  return (
    <Card className="px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div
          className={`flex h-11 w-16 shrink-0 flex-col items-center justify-center rounded-lg text-[11px] font-semibold uppercase tracking-wide ${
            OUTCOME_TONE[bet.outcome]
          }`}
        >
          {bet.outcome}
          {bet.outcome !== "open" ? (
            <span className="tabular text-[11px] font-normal">{money(bet.profit)}</span>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-1.5 text-[14px] font-medium text-slate-100">
            <span>{legs.length}-leg parlay</span>
            <span className="tabular text-slate-400">
              {formatPrice(bet.parlay_price ?? null)}
            </span>
          </p>
          <ul className="mt-1 space-y-0.5">
            {legs.map((leg) => (
              <li key={leg.bet_id} className="truncate text-[11px] text-slate-500">
                <span className="text-slate-400">
                  {leg.side === "home" ? leg.home_team : leg.away_team}
                </span>{" "}
                {leg.market === "total"
                  ? formatLine("total", leg.side, leg.line)
                  : leg.market === "spread"
                    ? formatLine("spread", leg.side, leg.line)
                    : "ML"}{" "}
                <span className="tabular text-slate-600">{formatPrice(leg.price)}</span>
              </li>
            ))}
          </ul>
          <div className="tabular mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-slate-600">
            <Pill>{formatLeague(bet.league)}</Pill>
            <span>${bet.stake.toFixed(0)}</span>
            <span>{bet.book}</span>
          </div>
          {bet.outcome === "cashed" && bet.heldProfit !== null ? (
            <HeldInstead took={bet.profit} held={bet.heldProfit} />
          ) : null}
          <HoldValue hold={hold} live={live} why={why} />
        </div>
      </div>
    </Card>
  );
}

function BetRow({ bet, hold, live, why }: { bet: GradedRow; hold?: Hold; live?: string | null; why?: string | null }) {
  const teamId = null; // bets store names, not ids; the crest comes from the game page
  const label =
    bet.market === "total"
      ? `${formatLine("total", bet.side, bet.line)}`
      : `${bet.side === "home" ? bet.home_team : bet.away_team} ${
          bet.market === "spread" ? formatLine("spread", bet.side, bet.line) : "ML"
        }`;

  return (
    <Card href={`/game/${bet.event_id}`} className="px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div
          className={`flex h-11 w-16 shrink-0 flex-col items-center justify-center rounded-lg text-[11px] font-semibold uppercase tracking-wide ${
            OUTCOME_TONE[bet.outcome]
          }`}
        >
          {bet.outcome}
          {bet.outcome !== "open" ? (
            <span className="tabular text-[11px] font-normal">{money(bet.profit)}</span>
          ) : null}
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 truncate text-[14px] font-medium text-slate-100">
            <TeamLogo league={bet.league as League} teamId={teamId} name={label} size={18} />
            <span className="truncate">{label}</span>
            <span className="tabular shrink-0 text-slate-400">{formatPrice(bet.price)}</span>
          </p>
          <p className="mt-0.5 truncate text-[11px] text-slate-500">
            {bet.away_team} <span className="text-slate-600">@</span> {bet.home_team}
          </p>
          <div className="tabular mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-slate-600">
            <Pill>{formatLeague(bet.league)}</Pill>
            <span>${bet.stake.toFixed(0)}</span>
            <span>{bet.book}</span>
            <span>{formatKickoff(bet.commence_time)}</span>
          </div>
          {bet.note ? (
            <p className="mt-1 truncate text-[11px] italic text-slate-500">{bet.note}</p>
          ) : null}
          {bet.outcome === "cashed" && bet.heldProfit !== null ? (
            <HeldInstead took={bet.profit} held={bet.heldProfit} />
          ) : null}
          <HoldValue hold={hold} live={live} why={why} />
        </div>
      </div>
    </Card>
  );
}

export default async function BetsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // A "log this" link elsewhere in the app opens the form already filled in.
  const prefill = parseBetPrefill(await searchParams);
  const data = getData();
  const session = await currentSession();
  const [games, results, freshness, models, lines] = await Promise.all([
    data.games(),
    data.results(),
    data.freshness(),
    data.marginModels(),
    // Only for pricing the open tickets; a failure costs the "expected" figure, not the page.
    data.backend === "postgres" ? allBookLines().catch(() => new Map()) : Promise.resolve(new Map()),
  ]);

  let bets: Bet[] = [];
  let loadError: string | null = null;
  if (!session.ownerId) {
    // Never fall back to the owner's ledger here. Middleware mints an identifier for
    // every visitor it lets through, so this should be unreachable -- and if it ever is
    // reached, showing somebody my rows would be a far worse answer than showing none.
    loadError = "No ledger is attached to this session, so there is nothing to show.";
  } else if (databaseUrl()) {
    try {
      bets = await listBets(session.ownerId);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  } else {
    loadError = "No database configured, so bets cannot be stored or read.";
  }

  const scores = new Map<string, Score>(
    results.map((r) => [r.event_id, { home_score: r.home_score, away_score: r.away_score }]),
  );
  // Corrected rows are replaced by their corrections before anything is counted.
  // Counting both would book the same wager twice, which is the failure a correction
  // is supposed to prevent.
  const standing = activeBets(bets);
  // Legs by ticket, so a parlay row can list what it is made of.
  const parlayLegs = new Map<string, Bet[]>();
  for (const bet of standing) {
    if (!bet.parlay_id) continue;
    parlayLegs.set(bet.parlay_id, [...(parlayLegs.get(bet.parlay_id) ?? []), bet]);
  }
  const corrections = bets.length - standing.length;
  const { rows, totals } = tally(standing, scores);

  // Live, then soonest kickoff, then won, lost and the rest. See ordering.ts.
  const sections = ledgerSections(rows, parlayLegs);

  // What is riding on the open tickets, priced against the other books. See open-summary.ts.
  const gamesById = new Map(games.map((g) => [g.eventId, g]));
  // Games under way with money on them get their live score -- one cached ESPN request
  // per league, and only when there is such a game. See live-scores.ts.
  const nowMs = Date.now();
  const startedLegs = standing.filter(
    (b) => b.commence_time && Date.parse(b.commence_time) <= nowMs && !scores.has(b.event_id),
  );
  const [liveByEvent, scoreModels] = startedLegs.length
    ? await Promise.all([
        liveGamesFor(startedLegs.map((b) => ({ eventId: b.event_id, league: b.league }))),
        data.scoreModels().catch(() => ({})),
      ])
    : [new Map<string, LiveGame>(), {} as Record<string, ScoreModel>];
  // Why a started game could not be priced live, for the row to say rather than guess.
  const whyNotLive = (bet: Bet): string => {
    if (liveByEvent.size === 0) return "ESPN's live scores could not be read";
    const game = liveByEvent.get(bet.event_id);
    if (!game) return "ESPN has no live score for this game";
    if (game.state === "pre") return "ESPN does not show it as kicked off yet";
    if (!gamesById.get(bet.event_id)) return "its pregame line is not on the board";
    if (!(scoreModels as Record<string, ScoreModel>)[bet.league]) return "no fitted score model for the league";
    return "this bet type cannot be priced live";
  };
  const liveChanceOf = (bet: Bet): number | null => {
    const game = liveByEvent.get(bet.event_id);
    const board = gamesById.get(bet.event_id);
    if (!game || game.state === "pre" || !board) return null;
    return liveChance(
      bet,
      game,
      { homeSpread: board.spread?.home?.line ?? null, total: board.total?.over?.line ?? null },
      (scoreModels as Record<string, ScoreModel>)[bet.league],
    );
  };
  const open = openSummary(
    rows,
    parlayLegs,
    (bet) =>
      liveChanceOf(bet) ??
      fairChance(bet, gamesById.get(bet.event_id), lines.get(bet.event_id) ?? [], models[bet.league] ?? null),
    scores,
  );
  // The score to show beside a ticket: every started leg must have been priced live, or
  // the figure is partly pregame and is labelled as such instead.
  const liveLabel = (row: GradedRow): string | null => {
    const legs = row.parlay_id ? parlayLegs.get(row.parlay_id) ?? [row] : [row];
    const started = legs.filter((b) => b.commence_time && Date.parse(b.commence_time) <= nowMs && !scores.has(b.event_id));
    if (started.length === 0) return null;
    if (started.some((b) => liveChanceOf(b) === null)) return null;
    return started
      .map((b) => scoreLine(liveByEvent.get(b.event_id)!, { away: b.away_team, home: b.home_team }))
      .join(" | ");
  };
  const staleReason = (row: GradedRow): string | null => {
    const legs = row.parlay_id ? parlayLegs.get(row.parlay_id) ?? [row] : [row];
    const miss = legs.find(
      (b) => b.commence_time && Date.parse(b.commence_time) <= nowMs && !scores.has(b.event_id) && liveChanceOf(b) === null,
    );
    return miss ? whyNotLive(miss) : null;
  };

  // Every game you might be logging, not the first eighty.
  //
  // The cap was a dropdown's limit, and on a college Saturday eighty upcoming games is
  // not all of them: the one you bet could simply be missing with nothing to say so.
  // Search makes the length free. Games that kicked off in the last two days are kept
  // too, after the upcoming ones, because a bet is often written down after it is
  // struck -- and a form that only offers future games makes those unloggable.
  const RECENT_MS = 48 * 60 * 60 * 1000;
  const now = Date.now();
  const kickoff = (g: { commenceTime: string }) => new Date(g.commenceTime).getTime();
  const upcoming = games.filter((g) => kickoff(g) > now).sort((a, b) => kickoff(a) - kickoff(b));
  const recent = games
    .filter((g) => kickoff(g) <= now && kickoff(g) > now - RECENT_MS)
    .sort((a, b) => kickoff(b) - kickoff(a));
  const bettable = [...upcoming, ...recent];

  return (
    <>
      <PageHeader title="Bets" subtitle="What you actually staked, and how it did" />

      {loadError ? <Banner tone="error">{loadError}</Banner> : null}

      {/*
        Guests only. My own ledger moves with the passcode, so the panel would be
        offering a second and weaker way into it.
      */}
      {session.role === "viewer" ? <LedgerTransfer bets={standing.length} /> : null}

      {/*
        The open tickets first: what is in play right now is the question this page is
        opened to answer on a game day. "If all win" is the ceiling, and it is labelled as
        one; "expected" is the number to plan around.
      */}
      {open.tickets > 0 ? (
        <>
          <Stats
            items={[
              { value: `$${open.atStake.toFixed(2)}`, label: `in play · ${open.tickets} open` },
              { value: money(open.ifAllWin), label: "if all win" },
              {
                value: money(open.expected),
                label: "expected",
                tone: open.expected > 0.005 ? ("good" as const) : open.expected < -0.005 ? ("bad" as const) : ("plain" as const),
              },
            ]}
          />
          <p className="-mt-1.5 mb-3 text-[11px] leading-relaxed text-slate-500">
            Expected is each ticket&rsquo;s payout times its fair chance of winning, from the
            other books&rsquo; prices, less its stake times its chance of losing. All{" "}
            {open.tickets} hitting is the ceiling, not the forecast.
            {open.bonusStake > 0
              ? ` Plus $${open.bonusStake.toFixed(2)} of bonus bets riding, which cannot be lost.`
              : ""}
            {open.unpriced > 0
              ? ` ${open.unpriced} ticket${open.unpriced === 1 ? " has" : "s have"} no market to price against and ${open.unpriced === 1 ? "is" : "are"} counted at break-even.`
              : ""}
          </p>
        </>
      ) : null}

      {corrections > 0 ? (
        <p className="mb-3 text-[11px] leading-relaxed text-slate-600">
          {corrections} earlier {corrections === 1 ? "row has" : "rows have"} been
          corrected and {corrections === 1 ? "is" : "are"} no longer counted. The
          originals are kept rather than deleted &mdash; what was first written is part
          of the history even when it was wrong.
        </p>
      ) : null}

      {totals.placed > 0 ? (
        <Stats
          items={[
            {
              value: `${totals.won}-${totals.lost}${totals.push > 0 ? `-${totals.push}` : ""}`,
              label: "record",
            },
            {
              value: money(totals.profit),
              // The total, bonus winnings included. It was labelled "your money", which is
              // what the ROI beside it measures and this does not -- so +$372 sat next to
              // -13.6% and read as a contradiction.
              label: totals.bonusProfit !== 0 ? "profit · all" : "profit",
              tone: totals.profit > 0 ? ("good" as const) : totals.profit < 0 ? ("bad" as const) : ("plain" as const),
            },
            {
              value: totals.roi === null ? "—" : formatPercent(totals.roi, 1),
              label: totals.bonusProfit !== 0 ? "roi · your money" : "roi",
            },
          ]}
        />
      ) : null}
      {totals.placed > 0 && totals.bonusProfit !== 0 ? (
        <p className="-mt-1.5 mb-3 text-[11px] leading-relaxed text-slate-500">
          <span className="tabular text-slate-300">{money(totals.bonusProfit)}</span> of that came
          from bonus bets, which risked none of your money. On your own money you are{" "}
          <span className="tabular text-slate-300">{money(totals.profit - totals.bonusProfit)}</span>
          {totals.roi === null ? "" : `, a ${formatPercent(totals.roi, 1)} return on what you staked`}.
        </p>
      ) : null}

      {/*
        Whether cashing out is working, across every one of them.

        A single decision is unjudgeable -- it feels correct whenever the bet would have
        lost and wrong whenever it would have won -- so the only useful version of this
        question is the running one. The wording deliberately does not congratulate
        either direction at small counts, because at three cash-outs the difference is
        one lucky fourth quarter.
      */}
      {totals.cashedGraded > 0 && totals.cashedHeld !== null ? (
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          {totals.cashedGraded} cashed-out ticket
          {totals.cashedGraded === 1 ? " has" : "s have"} since finished. You took{" "}
          <span className="tabular text-slate-300">{money(totals.cashedTaken)}</span>;
          holding would have paid{" "}
          <span className="tabular text-slate-300">{money(totals.cashedHeld)}</span>
          {Math.abs(totals.cashedHeld - totals.cashedTaken) < 0.005
            ? ", which is a wash."
            : totals.cashedHeld > totals.cashedTaken
              ? `, so selling early cost ${money(totals.cashedHeld - totals.cashedTaken)}.`
              : `, so selling early saved ${money(totals.cashedTaken - totals.cashedHeld)}.`}
          {totals.cashedGraded < 10
            ? " Far too few to mean anything yet — one fourth quarter moves this."
            : ""}
        </p>
      ) : null}

      {totals.settled > 0 && totals.settled < 30 ? (
        <Banner tone="warn">
          {totals.settled} settled bet{totals.settled === 1 ? "" : "s"} tells you almost
          nothing. At this sample size the result is variance, not evidence — a good run
          and a bad run look identical. Judge it after dozens, not after tonight.
        </Banner>
      ) : null}

      {/* Anchored so a "log this" link lands on the form rather than the ledger's top. */}
      <div id="log" className="scroll-mt-16">
        <Card className="mb-3 px-3.5 py-3">
          <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Log a bet
          </h2>
          <BetForm
            // Keyed on the prefill so following a second link re-seeds the form instead of
            // keeping the first one's numbers.
            key={prefill ? JSON.stringify(prefill) : "blank"}
            games={bettable}
            started={recent.map((g) => g.eventId)}
            initial={prefill}
          />
        </Card>
      </div>

      {rows.length === 0 ? (
        <Empty
          title="No bets logged"
          detail="Nothing recorded yet. Logging a bet is what lets the system measure it — an unrecorded bet is invisible to every number on the Track Record."
        />
      ) : (
        <div className="space-y-4">
          {(
            [
              ["Live now", sections.live],
              ["Coming up", sections.upcoming],
              ["Won", sections.won],
              ["Lost", sections.lost],
              ["Pushed", sections.other],
            ] as const
          )
            .filter(([, list]) => list.length > 0)
            .map(([title, list]) => (
              <section key={title}>
                <h2 className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  {title} <span className="tabular font-normal text-slate-600">· {list.length}</span>
                </h2>
                <div className="space-y-1.5">
                  {list.map((bet) => {
                    const legs = bet.parlay_id ? (parlayLegs.get(bet.parlay_id) ?? []) : null;
                    return (
                      <div key={bet.bet_id}>
                        {legs ? (
                          <ParlayRow bet={bet} legs={legs} hold={open.hold.get(bet.bet_id)} live={liveLabel(bet)} why={staleReason(bet)} />
                        ) : (
                          <BetRow bet={bet} hold={open.hold.get(bet.bet_id)} live={liveLabel(bet)} why={staleReason(bet)} />
                        )}
                        {legs ? null : <CorrectBet bet={bet} />}
                      </div>
                    );
                  })}
                </div>
              </section>
            ))}
        </div>
      )}

      <Freshness data={freshness} />

      <NotAdvice className="mt-6" />
    </>
  );
}
