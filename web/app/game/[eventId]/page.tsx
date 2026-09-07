import Link from "next/link";
import { notFound } from "next/navigation";

import { Probability } from "@/components/Probability";
import { TeamLogo } from "@/components/TeamLogo";
import { Card, Empty, NotAdvice, Pill } from "@/components/ui";
import { collapseAlerts, getData } from "@/lib/data";
import { deVig, lineProbability, type MarginModel } from "@/lib/probability";
import {
  formatKickoff,
  formatKind,
  formatLeague,
  formatLine,
  formatPrice,
  formatRelative,
  sideTone,
  strengthTone,
} from "@/lib/format";
import type { HistoryPoint, League, Market, Side } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Inline SVG sparkline with an area fill. No chart library: the shape is trivial and a
 * dependency would cost more bundle than it saves. A flat line still renders as a flat
 * line rather than vanishing, which matters — "did not move" is a real answer.
 */
function Sparkline({ points }: { points: HistoryPoint[] }) {
  const values = points
    .map((p) => p.line)
    .filter((line): line is number => line !== null);
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 300;
  const height = 44;
  const pad = 4;
  const usable = height - pad * 2;

  const coords = values.map((value, index) => {
    const x = (index / (values.length - 1)) * width;
    // A flat series would otherwise divide by its own zero range; centre it instead.
    const y = max === min ? height / 2 : pad + usable - ((value - min) / span) * usable;
    return [x, y] as const;
  });

  const line = coords
    .map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${width},${height} L0,${height} Z`;
  const id = `g${points[0]?.market ?? "m"}${points[0]?.side ?? "s"}`;

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-11 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Moved from ${values[0]} to ${values[values.length - 1]}`}
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.22" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function MarketPanel({
  market,
  points,
  homeTeam,
  awayTeam,
  homeSpread,
  homeCoverProbability,
  model,
}: {
  market: Market;
  points: HistoryPoint[];
  homeTeam: string;
  awayTeam: string;
  homeSpread: number | null;
  homeCoverProbability: number | null;
  model: MarginModel | null;
}) {
  const sides = [...new Set(points.map((p) => p.side))];
  if (sides.length === 0) return null;

  // Spread and moneyline sides are teams; showing the team name beats "home"/"away".
  const labelFor = (side: string) =>
    market === "total" ? side : side === "home" ? homeTeam : awayTeam;

  return (
    <Card className="px-3.5 py-3">
      <h2 className="mb-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {market}
      </h2>
      <div className="space-y-3.5">
        {sides.map((side) => {
          const series = points.filter((p) => p.side === side);
          const latest = series[series.length - 1];
          const opening = series[0];
          const moved =
            latest?.line !== null &&
            opening?.line !== null &&
            latest?.line !== opening?.line;

          const tone = sideTone(side as Side);

          // De-vigging needs the opposing price, so the other side's latest is read here.
          const otherSeries = points.filter((p) => p.side !== side);
          const otherLatest = otherSeries[otherSeries.length - 1];
          const probability = lineProbability(
            market,
            side as Side,
            latest?.price ?? null,
            otherLatest?.price ?? null,
            homeSpread,
            model,
            homeCoverProbability,
          );

          return (
            <div key={side}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${tone.dot}`} />
                  <span className="truncate text-[13px] capitalize text-slate-300">
                    {labelFor(side)}
                  </span>
                </span>
                <span className="tabular text-[14px] font-medium text-slate-100">
                  {formatLine(market, side as Side, latest?.line)}
                  <span className="ml-1.5 text-[11px] font-normal text-slate-500">
                    {formatPrice(latest?.price)}
                  </span>
                </span>
              </div>

              <Probability value={probability} />

              <div className={moved ? tone.text : "text-slate-700"}>
                <Sparkline points={series} />
              </div>

              <div className="flex items-baseline justify-between text-[10px] text-slate-600">
                <span>
                  {moved
                    ? `opened ${formatLine(market, side as Side, opening.line)}`
                    : "unchanged since first seen"}
                </span>
                <span>
                  {series.length} obs
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

export default async function GamePage({
  params,
}: {
  params: Promise<{ eventId: string }>;
}) {
  const { eventId } = await params;
  const data = getData();
  const [games, allAlerts, results, history, models] = await Promise.all([
    data.games(),
    data.alerts(),
    data.results(),
    data.history(eventId),
    data.marginModels(),
  ]);

  const game = games.find((g) => g.eventId === eventId);
  const result = results.find((r) => r.event_id === eventId);
  if (!game && !result) notFound();

  const alerts = collapseAlerts(allAlerts.filter((a) => a.event_id === eventId));
  const league: League = game?.league ?? result?.league ?? "ncaaf";
  const homeTeam = game?.homeTeam ?? result?.home_team ?? "Home";
  const awayTeam = game?.awayTeam ?? result?.away_team ?? "Away";
  const markets: Market[] = ["spread", "total", "moneyline"];
  const model = models[league] ?? null;
  // The current home handicap is what the model converts into a win probability.
  const spreadHistory = history.filter((p) => p.market === "spread" && p.side === "home");
  const awaySpreadHistory = history.filter(
    (p) => p.market === "spread" && p.side === "away",
  );
  const latestHomeSpread = spreadHistory[spreadHistory.length - 1];
  const latestAwaySpread = awaySpreadHistory[awaySpreadHistory.length - 1];
  const homeSpread = latestHomeSpread?.line ?? null;
  // What the book charges for the spread says how much of it it actually believes: a
  // -1.5 juiced +102/-122 is really about -0.7, and reading the posted number literally
  // overstates the favourite.
  const homeCoverProbability =
    deVig(latestHomeSpread?.price ?? null, latestAwaySpread?.price ?? null)?.a ?? null;

  return (
    <>
      <Link
        href="/"
        className="mb-3 inline-flex items-center gap-1 text-[12px] text-slate-500"
      >
        &larr; Board
      </Link>

      <Card className="mb-3 px-3.5 py-3">
        <div className="mb-2 flex items-center gap-2">
          <Pill>{formatLeague(league)}</Pill>
          <span className="text-[11px] text-slate-500">
            {formatKickoff(game?.commenceTime ?? result?.commence_time ?? null)}
          </span>
        </div>

        {[
          { name: awayTeam, id: game?.awayTeamId ?? null, score: result?.away_score },
          { name: homeTeam, id: game?.homeTeamId ?? null, score: result?.home_score },
        ].map((team, index) => (
          <div key={index} className="flex items-center gap-2.5 py-1">
            <TeamLogo league={league} teamId={team.id} name={team.name} size={30} />
            <span className="min-w-0 flex-1 truncate text-[15px] font-medium text-slate-100">
              {team.name}
            </span>
            {result ? (
              <span className="tabular text-[19px] font-semibold text-slate-50">
                {team.score}
              </span>
            ) : null}
          </div>
        ))}

        {result ? (
          <p className="mt-1.5 border-t border-edge/70 pt-1.5 text-[10px] uppercase tracking-wider text-slate-500">
            Final{result.went_overtime ? " · OT" : ""}
          </p>
        ) : null}
      </Card>

      {history.length === 0 ? (
        <Empty
          title="No price history"
          detail="This game has been discovered but the book has not posted numbers for it yet."
        />
      ) : (
        <div className="space-y-2">
          {markets.map((market) => (
            <MarketPanel
              key={market}
              market={market}
              points={history.filter((p) => p.market === market)}
              homeTeam={homeTeam}
              awayTeam={awayTeam}
              homeSpread={homeSpread}
              homeCoverProbability={homeCoverProbability}
              model={model}
            />
          ))}
        </div>
      )}

      {history.length > 0 ? (
        <Card className="mt-2 px-3.5 py-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Reading these numbers
          </h2>
          <dl className="mt-2 space-y-2 text-[12px] leading-relaxed">
            <div>
              <dt className="inline font-medium text-slate-300">Market</dt>
              <dd className="inline text-slate-400">
                {" "}
                &mdash; what DraftKings&rsquo; own price implies, with their margin
                stripped out. Not a prediction of ours; it moves whenever the price moves.
              </dd>
            </div>
            <div>
              <dt className="inline font-medium text-slate-300">Model</dt>
              <dd className="inline text-slate-400">
                {" "}
                &mdash; what the <em>spread</em> implies about the same question, from{" "}
                {model ? model.games.toLocaleString() : "past"} completed games. Shown
                only on the moneyline, because only there do the spread and the price
                answer the same question independently.
              </dd>
            </div>
            <div>
              <dt className="inline font-medium text-slate-300">&plusmn; pts</dt>
              <dd className="inline text-slate-400">
                {" "}
                &mdash; model minus market. Near zero means the two agree and there is
                nothing here. A few points apart means DraftKings&rsquo; spread and its
                own moneyline disagree about this game.
              </dd>
            </div>
            <div>
              <dt className="inline font-medium text-slate-300">Hold</dt>
              <dd className="inline text-slate-400">
                {" "}
                &mdash; the book&rsquo;s margin on that market. Roughly 4.5% is normal.
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
            Spreads and totals show no model number on purpose: a spread is set so both
            sides are near 50%, so a model figure there would be decoration, not analysis.
          </p>
        </Card>
      ) : null}

      {alerts.length > 0 ? (
        <section className="mt-5">
          <h2 className="mb-2 px-0.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Alerts on this game
          </h2>
          <div className="space-y-1.5">
            {alerts.map((alert) => (
              <Card key={alert.alert_id} className="flex items-start gap-2.5 px-3 py-2.5">
                <span
                  className={`tabular flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-[13px] font-semibold ${strengthTone(
                    alert.move_strength,
                  )}`}
                >
                  {alert.move_strength}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-[12px] text-slate-300">
                    <span className="font-medium">{formatKind(alert.kind)}</span>{" "}
                    <span className="text-slate-500">{alert.message}</span>
                  </p>
                  <p className="text-[10px] text-slate-600">
                    {formatRelative(alert.created_at)}
                  </p>
                </div>
              </Card>
            ))}
          </div>
        </section>
      ) : null}

      <NotAdvice className="mt-8" />
    </>
  );
}
