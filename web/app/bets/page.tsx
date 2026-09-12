import { BetForm } from "@/components/BetForm";
import { TeamLogo } from "@/components/TeamLogo";
import { Banner, Card, Empty, NotAdvice, PageHeader, Pill, Stats } from "@/components/ui";
import { CorrectBet } from "@/components/CorrectBet";
import { listBets } from "@/lib/bets-db";
import { getData } from "@/lib/data";
import { databaseUrl } from "@/lib/env";
import { formatKickoff, formatLeague, formatLine, formatPercent, formatPrice } from "@/lib/format";
import { activeBets, tally, type Bet, type Score, type Settlement } from "@/lib/settle";
import type { League, Side } from "@/lib/types";

export const dynamic = "force-dynamic";

const OUTCOME_TONE: Record<string, string> = {
  won: "bg-emerald-500/12 text-emerald-300",
  lost: "bg-rose-500/12 text-rose-300",
  push: "bg-slate-600/30 text-slate-300",
  open: "bg-sky-500/12 text-sky-300",
};

function money(value: number): string {
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function BetRow({ bet }: { bet: Bet & Settlement }) {
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
        </div>
      </div>
    </Card>
  );
}

export default async function BetsPage() {
  const data = getData();
  const [games, results] = await Promise.all([data.games(), data.results()]);

  let bets: Bet[] = [];
  let loadError: string | null = null;
  if (databaseUrl()) {
    try {
      bets = await listBets();
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
  const corrections = bets.length - standing.length;
  const { rows, totals } = tally(standing, scores);

  // Only games that have not kicked off can be bet.
  const now = Date.now();
  const upcoming = games
    .filter((g) => new Date(g.commenceTime).getTime() > now)
    .slice(0, 80);

  return (
    <>
      <PageHeader title="Bets" subtitle="What you actually staked, and how it did" />

      {loadError ? <Banner tone="error">{loadError}</Banner> : null}

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
              label: totals.bonusProfit !== 0 ? "profit · your money" : "profit",
              tone: totals.profit > 0 ? ("good" as const) : totals.profit < 0 ? ("bad" as const) : ("plain" as const),
            },
            {
              value: totals.roi === null ? "—" : formatPercent(totals.roi, 1),
              label: "roi",
            },
          ]}
        />
      ) : null}

      {totals.settled > 0 && totals.settled < 30 ? (
        <Banner tone="warn">
          {totals.settled} settled bet{totals.settled === 1 ? "" : "s"} tells you almost
          nothing. At this sample size the result is variance, not evidence — a good run
          and a bad run look identical. Judge it after dozens, not after tonight.
        </Banner>
      ) : null}

      <Card className="mb-3 px-3.5 py-3">
        <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Log a bet
        </h2>
        <BetForm games={upcoming} />
      </Card>

      {rows.length === 0 ? (
        <Empty
          title="No bets logged"
          detail="Nothing recorded yet. Logging a bet is what lets the system measure it — an unrecorded bet is invisible to every number on the Track Record."
        />
      ) : (
        <div className="space-y-1.5">
          {rows.map((bet) => (
            <div key={bet.bet_id}>
              <BetRow bet={bet} />
              <CorrectBet bet={bet} />
            </div>
          ))}
        </div>
      )}

      <NotAdvice className="mt-6" />
    </>
  );
}
