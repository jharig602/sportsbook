import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, Empty, NotAdvice, PageHeader, Pill } from "@/components/ui";
import { collapseAlerts, getData } from "@/lib/data";
import {
  formatKickoff,
  formatKind,
  formatLeague,
  formatLine,
  formatPrice,
  formatRelative,
  strengthTone,
} from "@/lib/format";
import type { HistoryPoint, Market, Side } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Inline SVG sparkline of one market's line over time. No chart library: the shape is
 * trivial and a dependency here would cost more than it saves.
 */
function Sparkline({ points }: { points: HistoryPoint[] }) {
  const values = points
    .map((p) => p.line)
    .filter((line): line is number => line !== null);
  if (values.length < 2) return null;

  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const width = 260;
  const height = 40;

  const path = values
    .map((value, index) => {
      const x = (index / (values.length - 1)) * width;
      const y = height - ((value - min) / span) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className="h-10 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Line moved from ${values[0]} to ${values[values.length - 1]}`}
    >
      <path d={path} fill="none" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

function MarketPanel({
  market,
  points,
}: {
  market: Market;
  points: HistoryPoint[];
}) {
  const sides = [...new Set(points.map((p) => p.side))];
  if (sides.length === 0) return null;

  return (
    <Card className="px-3 py-3">
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">
        {market}
      </h2>
      <div className="space-y-3">
        {sides.map((side) => {
          const series = points.filter((p) => p.side === side);
          const latest = series[series.length - 1];
          const opening = series[0];
          const moved =
            latest?.line !== null &&
            opening?.line !== null &&
            latest?.line !== opening?.line;

          return (
            <div key={side}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-sm capitalize text-slate-300">{side}</span>
                <span className="tabular text-sm text-slate-100">
                  {formatLine(market, side as Side, latest?.line)}{" "}
                  <span className="text-slate-500">{formatPrice(latest?.price)}</span>
                </span>
              </div>
              {moved ? (
                <p className="text-[11px] text-slate-500">
                  opened {formatLine(market, side as Side, opening.line)}
                </p>
              ) : null}
              <div className="text-sky-400/70">
                <Sparkline points={series} />
              </div>
              <p className="text-[11px] text-slate-600">
                {series.length} observation{series.length === 1 ? "" : "s"}
              </p>
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
  const [games, allAlerts, results, history] = await Promise.all([
    data.games(),
    data.alerts(),
    data.results(),
    data.history(eventId),
  ]);

  const game = games.find((g) => g.eventId === eventId);
  const result = results.find((r) => r.event_id === eventId);
  if (!game && !result) notFound();

  const alerts = collapseAlerts(allAlerts.filter((a) => a.event_id === eventId));
  const homeTeam = game?.homeTeam ?? result?.home_team ?? "Home";
  const awayTeam = game?.awayTeam ?? result?.away_team ?? "Away";
  const markets: Market[] = ["spread", "total", "moneyline"];

  return (
    <>
      <Link
        href="/"
        className="mb-3 inline-block text-xs text-slate-500 hover:text-slate-300"
      >
        &larr; Board
      </Link>

      <PageHeader
        title={`${awayTeam} @ ${homeTeam}`}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <Pill>{formatLeague(game?.league ?? result?.league ?? "ncaaf")}</Pill>
            <span>{formatKickoff(game?.commenceTime ?? result?.commence_time ?? null)}</span>
          </span>
        }
      />

      {result ? (
        <Card className="mb-4 px-3 py-3">
          <div className="flex items-baseline justify-between">
            <span className="text-xs uppercase tracking-wide text-slate-500">Final</span>
            <span className="tabular text-lg font-semibold text-slate-100">
              {result.away_score} &ndash; {result.home_score}
              {result.went_overtime ? (
                <span className="ml-2 text-xs font-normal text-amber-400">OT</span>
              ) : null}
            </span>
          </div>
        </Card>
      ) : null}

      {history.length === 0 ? (
        <Empty
          title="No price history"
          detail="This game has been discovered but the book has not posted numbers for it yet."
        />
      ) : (
        <div className="space-y-3">
          {markets.map((market) => (
            <MarketPanel
              key={market}
              market={market}
              points={history.filter((p) => p.market === market)}
            />
          ))}
        </div>
      )}

      {alerts.length > 0 ? (
        <section className="mt-6">
          <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
            Alerts on this game
          </h2>
          <div className="space-y-2">
            {alerts.map((alert) => (
              <Card key={alert.alert_id} className="flex items-start gap-3 px-3 py-2">
                <span
                  className={`tabular flex h-8 w-8 shrink-0 items-center justify-center rounded text-xs font-semibold ring-1 ring-inset ${strengthTone(
                    alert.move_strength,
                  )}`}
                >
                  {alert.move_strength}
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-slate-300">
                    <span className="font-medium">{formatKind(alert.kind)}</span>{" "}
                    <span className="text-slate-500">{alert.message}</span>
                  </p>
                  <p className="text-[11px] text-slate-600">
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
