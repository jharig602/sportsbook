import { Stake } from "@/components/Stake";
import { TeamLogo } from "@/components/TeamLogo";
import { Banner, Card, Empty, NotAdvice, PageHeader, Pill, Segmented } from "@/components/ui";
import { calibratedProbability, collapseAlerts, getData } from "@/lib/data";
import {
  formatKickoff,
  formatKind,
  formatLeague,
  formatRelative,
  strengthTone,
} from "@/lib/format";
import type { Alert, AlertKind, Game } from "@/lib/types";

export const dynamic = "force-dynamic";

const FILTERS = [
  { key: "movement", label: "Movement" },
  { key: "all", label: "All" },
  { key: "steam", label: "Steam" },
  { key: "key_number", label: "Key numbers" },
  { key: "first_price", label: "First price" },
  { key: "drift", label: "Drift" },
];

/** Alerts store team names but not ids, so crests come from the board lookup. */
type TeamIds = Map<string, { home: string | null; away: string | null }>;

function Matchup({
  alert,
  ids,
  size = 20,
}: {
  alert: Alert;
  ids: TeamIds;
  size?: number;
}) {
  const pair = ids.get(alert.event_id);
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <TeamLogo
        league={alert.league}
        teamId={pair?.away ?? null}
        name={alert.away_team}
        size={size}
      />
      <TeamLogo
        league={alert.league}
        teamId={pair?.home ?? null}
        name={alert.home_team}
        size={size}
      />
      <span className="ml-0.5 min-w-0 truncate">
        {alert.away_team ?? "?"} <span className="text-slate-600">@</span>{" "}
        {alert.home_team ?? "?"}
      </span>
    </span>
  );
}

/**
 * The single largest move on the board. Called "biggest move" and not "best pick"
 * because that is exactly what it is: the ranking is by measured movement, which has
 * not been shown to predict outcomes. The label upgrades once it has been earned.
 */
function TopMover({
  alert,
  ids,
  probability,
}: {
  alert: Alert;
  ids: TeamIds;
  probability: number | null;
}) {
  return (
    <Card
      href={`/game/${alert.event_id}`}
      className="mb-3 border-amber-500/25 px-3.5 py-3"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-amber-300">
          Biggest move
        </span>
        <span className="text-[10px] text-slate-600">
          {probability === null ? "not yet graded" : "calibrated"}
        </span>
        <span
          className={`tabular ml-auto rounded-md px-2 py-0.5 text-[13px] font-semibold ${strengthTone(
            alert.move_strength,
          )}`}
        >
          {alert.move_strength}
        </span>
      </div>

      <p className="flex text-[15px] font-semibold text-slate-100">
        <Matchup alert={alert} ids={ids} size={22} />
      </p>
      <p className="mt-1 text-[13px] leading-relaxed text-slate-400">{alert.message}</p>

      <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-slate-500">
        <Pill>{formatLeague(alert.league)}</Pill>
        <span className="capitalize">{alert.market}</span>
        <span>
          money toward{" "}
          <span className="font-medium text-slate-300">{alert.predicted_side}</span>
        </span>
      </div>

      <Stake price={alert.price_at_alert} calibratedProbability={probability} />
    </Card>
  );
}

function AlertCard({
  alert,
  ids,
  probability,
}: {
  alert: Alert;
  ids: TeamIds;
  probability: number | null;
}) {
  return (
    <Card href={`/game/${alert.event_id}`} className="px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div
          className={`tabular flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-[15px] font-semibold ${strengthTone(
            alert.move_strength,
          )}`}
          title="Move Strength: how unusual this move is, not a win probability"
        >
          {alert.move_strength}
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex text-[14px] font-medium text-slate-100">
            <Matchup alert={alert} ids={ids} />
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-slate-400">
            {alert.message}
          </p>

          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-slate-600">
            <Pill>{formatKind(alert.kind)}</Pill>
            <span className="capitalize">{alert.market}</span>
            <span>
              toward <span className="text-slate-400">{alert.predicted_side}</span>
            </span>
            <span>{formatRelative(alert.created_at)}</span>
            <span>{formatKickoff(alert.commence_time)}</span>
          </div>

          <div className="mt-1.5">
            <Stake
              price={alert.price_at_alert}
              calibratedProbability={probability}
              compact
            />
          </div>
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
  const [rawAlerts, grades, games] = await Promise.all([
    data.alerts(),
    data.grades(),
    data.games(),
  ]);

  const ids: TeamIds = new Map(
    games.map((game: Game) => [
      game.eventId,
      { home: game.homeTeamId, away: game.awayTeamId },
    ]),
  );

  const collapsed = collapseAlerts(rawAlerts);
  const probabilityFor = (strength: number) => calibratedProbability(grades, strength);

  const movement = collapsed.filter((a) => a.kind !== "first_price");

  // A quiet market leaves the Movement tab genuinely empty, which reads as a broken
  // app rather than as "nothing has moved". Falling back to opening prices keeps the
  // screen useful and says plainly which of the two you are looking at.
  const fellBack = kind === "movement" && movement.length === 0;
  const matching =
    kind === "all"
      ? collapsed
      : kind === "movement"
        ? (fellBack ? collapsed.filter((a) => a.kind === "first_price") : movement)
        : collapsed.filter((a) => a.kind === (kind as AlertKind));

  // Rendering every alert meant hundreds of cards and well over 700 logo requests on
  // one screen. The list is ranked, so anything past the first page is not what you
  // came to see; the count below says what was left off.
  const LIMIT = 60;
  const shown = matching.slice(0, LIMIT);
  const hidden = matching.length - shown.length;

  return (
    <>
      <PageHeader title="Movers" subtitle="Ranked by how unusual the move is" />

      <Segmented
        options={FILTERS}
        active={kind}
        hrefFor={(key) => (key === "movement" ? "/movers" : `/movers?kind=${key}`)}
      />

      {fellBack && shown.length > 0 ? (
        <Banner tone="info">
          No line has moved past the alert threshold yet — 97% of prices are unchanged
          between polls this far from kickoff. Showing opening prices instead. Movement
          picks up as the slate firms through the week.
        </Banner>
      ) : null}

      {shown.length === 0 ? (
        <Empty
          title="Nothing has moved yet"
          detail={
            <>
              Movement alerts need at least two polls of the same market to compare, and
              nothing has shifted past the threshold since the last one. Lines are checked
              every 30 minutes Friday through Sunday.
            </>
          }
        />
      ) : (
        <>
          <TopMover
            alert={shown[0]}
            ids={ids}
            probability={probabilityFor(shown[0].move_strength)}
          />
          <div className="space-y-1.5">
            {shown.slice(1).map((alert) => (
              <AlertCard
                key={alert.alert_id}
                alert={alert}
                ids={ids}
                probability={probabilityFor(alert.move_strength)}
              />
            ))}
          </div>
        </>
      )}

      {hidden > 0 ? (
        <p className="mt-3 text-center text-[11px] text-slate-600">
          Showing the {shown.length} strongest of {matching.length}.
        </p>
      ) : null}

      <NotAdvice className="mt-8" />
    </>
  );
}
