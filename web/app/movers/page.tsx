import Link from "next/link";

import { Stake } from "@/components/Stake";
import { Card, Empty, NotAdvice, PageHeader, Pill } from "@/components/ui";
import { calibratedProbability, collapseAlerts, getData } from "@/lib/data";
import {
  formatKickoff,
  formatKind,
  formatLeague,
  formatRelative,
  strengthTone,
  teamShort,
} from "@/lib/format";
import type { Alert, AlertKind } from "@/lib/types";

export const dynamic = "force-dynamic";

const FILTERS: Array<{ key: string; label: string }> = [
  { key: "movement", label: "Movement" },
  { key: "all", label: "All" },
  { key: "steam", label: "Steam" },
  { key: "key_number", label: "Key numbers" },
  { key: "first_price", label: "First price" },
  { key: "drift", label: "Drift" },
];

/**
 * The single largest move on the board. Called "biggest move" and not "best pick"
 * because that is exactly what it is: the ranking is by measured movement, which has
 * not been shown to predict outcomes. The label upgrades once it has been earned.
 */
function TopMover({
  alert,
  probability,
}: {
  alert: Alert;
  probability: number | null;
}) {
  return (
    <Card
      href={`/game/${alert.event_id}`}
      className="mb-4 border-amber-500/25 bg-amber-500/[0.04] px-3 py-3"
    >
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-amber-300/90">
          Biggest move
        </span>
        <span className="text-[11px] text-slate-500">
          {probability === null ? "not yet graded" : "calibrated"}
        </span>
      </div>
      <p className="mt-1 text-base font-semibold text-slate-100">
        {teamShort(alert.away_team)} @ {teamShort(alert.home_team)}
      </p>
      <p className="mt-0.5 text-sm text-slate-400">{alert.message}</p>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <Pill>{formatLeague(alert.league)}</Pill>
        <span className="capitalize">{alert.market}</span>
        <span>
          money toward{" "}
          <span className="font-medium text-slate-300">{alert.predicted_side}</span>
        </span>
        <span>strength {alert.move_strength}</span>
      </div>
      <Stake price={alert.price_at_alert} calibratedProbability={probability} />
    </Card>
  );
}

function AlertCard({
  alert,
  probability,
}: {
  alert: Alert;
  probability: number | null;
}) {
  const matchup = `${teamShort(alert.away_team)} @ ${teamShort(alert.home_team)}`;

  return (
    <Card href={`/game/${alert.event_id}`} className="px-3 py-3">
      <div className="flex items-start gap-3">
        <div
          className={`tabular flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-lg text-sm font-semibold ring-1 ring-inset ${strengthTone(
            alert.move_strength,
          )}`}
          title="Move Strength: how unusual this move is, not a win probability"
        >
          {alert.move_strength}
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <Pill>{formatLeague(alert.league)}</Pill>
            <Pill>{formatKind(alert.kind)}</Pill>
            <span className="text-[11px] capitalize text-slate-500">{alert.market}</span>
          </div>

          <p className="mt-1 truncate text-sm font-medium text-slate-100">{matchup}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-slate-400">{alert.message}</p>

          <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-600">
            <span>
              money toward{" "}
              <span className="font-medium text-slate-400">{alert.predicted_side}</span>
            </span>
            <span>{formatRelative(alert.created_at)}</span>
            <span>{formatKickoff(alert.commence_time)}</span>
          </div>

          <Stake
            price={alert.price_at_alert}
            calibratedProbability={probability}
            compact
          />
        </div>
      </div>
    </Card>
  );
}

export default async function MoversPage({
  searchParams,
}: {
  searchParams: Promise<{ kind?: string }>;
}) {
  const { kind = "movement" } = await searchParams;
  const data = getData();
  const [rawAlerts, grades] = await Promise.all([data.alerts(), data.grades()]);
  const collapsed = collapseAlerts(rawAlerts);
  const probabilityFor = (strength: number) => calibratedProbability(grades, strength);

  const shown =
    kind === "all"
      ? collapsed
      : kind === "movement"
        ? collapsed.filter((a) => a.kind !== "first_price")
        : collapsed.filter((a) => a.kind === (kind as AlertKind));

  return (
    <>
      <PageHeader
        title="Movers"
        subtitle="Ranked by how unusual the move is. Biggest first."
      />

      <div className="scroll-x mb-4 -mx-3 px-3">
        <div className="flex w-max gap-2">
          {FILTERS.map((filter) => (
            <Link
              key={filter.key}
              href={
                filter.key === "movement" ? "/movers" : `/movers?kind=${filter.key}`
              }
              className={`whitespace-nowrap rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${
                kind === filter.key
                  ? "bg-sky-500/15 text-sky-300 ring-sky-500/30"
                  : "text-slate-400 ring-slate-700 hover:text-slate-200"
              }`}
            >
              {filter.label}
            </Link>
          ))}
        </div>
      </div>

      {shown.length === 0 ? (
        <Empty
          title="Nothing has moved yet"
          detail={
            <>
              Movement alerts need at least two polls of the same market to compare. If
              collection started recently, the first ones appear after the next poll —
              lines are checked every 30 minutes from Friday through Sunday.
            </>
          }
        />
      ) : (
        <>
          <TopMover alert={shown[0]} probability={probabilityFor(shown[0].move_strength)} />
          <div className="space-y-2">
            {shown.slice(1).map((alert) => (
              <AlertCard
                key={alert.alert_id}
                alert={alert}
                probability={probabilityFor(alert.move_strength)}
              />
            ))}
          </div>
        </>
      )}

      <NotAdvice className="mt-8" />
    </>
  );
}
