import { TeamLogo } from "@/components/TeamLogo";
import { Banner, Card, Empty, NotAdvice, PageHeader, Pill } from "@/components/ui";
import { getData } from "@/lib/data";
import { boardShrinkage, buildEdges, type Edge } from "@/lib/edges";
import { formatKickoff, formatLeague, formatPercent, formatPrice } from "@/lib/format";

export const dynamic = "force-dynamic";

function EdgeRow({ edge }: { edge: Edge }) {
  const teamId = edge.side === "home" ? edge.homeTeamId : edge.awayTeamId;

  return (
    <Card href={`/game/${edge.eventId}`} className="px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div
          className={`tabular flex h-11 w-14 shrink-0 flex-col items-center justify-center rounded-lg text-[15px] font-semibold ${
            edge.outsideNoise
              ? "bg-emerald-500/12 text-emerald-300"
              : "bg-slate-700/40 text-slate-500"
          }`}
        >
          +{edge.shrunkEdgePoints.toFixed(1)}
          <span className="text-[9px] font-normal opacity-70">pts</span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[14px] font-medium text-slate-100">
            <TeamLogo league={edge.league} teamId={teamId} name={edge.team} size={20} />
            <span className="min-w-0 truncate">{edge.team}</span>
            <span className="tabular shrink-0 text-slate-400">
              {formatPrice(edge.price)}
            </span>
          </p>

          <p className="mt-0.5 text-[11px] text-slate-500">
            {edge.awayTeam} <span className="text-slate-600">@</span> {edge.homeTeam}
          </p>

          <div className="tabular mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-slate-600">
            <Pill>{formatLeague(edge.league)}</Pill>
            <span>market {formatPercent(edge.market, 1)}</span>
            <span>model {formatPercent(edge.model, 1)}</span>
            <span title="What was observed, before correcting for the winner's curse">
              raw {edge.edgePoints.toFixed(1)}
            </span>
            <span>&plusmn;{edge.standardErrorPoints.toFixed(1)} noise</span>
            <span>{formatKickoff(edge.commenceTime)}</span>
          </div>

          {!edge.outsideNoise ? (
            <p className="mt-1 text-[10px] text-slate-600">
              Inside the model&rsquo;s own margin of error &mdash; not a finding.
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export default async function EdgesPage() {
  const data = getData();
  const [games, models, grades] = await Promise.all([
    data.games(),
    data.marginModels(),
    data.grades(),
  ]);

  const edges = buildEdges(games, models);
  const shrinkage = boardShrinkage(edges);
  const real = edges.filter((e) => e.outsideNoise);
  const calibrated = grades.length > 0;

  return (
    <>
      <PageHeader
        title="Edges"
        subtitle="Where the spread and the moneyline disagree, biggest first"
      />

      {!calibrated ? (
        <Banner tone="warn">
          <span className="font-medium">Nothing here has been tested yet.</span> The
          model is fitted to past seasons but has never predicted a game it did not
          already know the answer to. Until the Track Record fills, treat this as a list
          of things to look at, not things to bet.
        </Banner>
      ) : null}

      {edges.length === 0 ? (
        <Empty
          title="No comparable lines"
          detail="An edge needs both a spread and a two-sided moneyline on the same game, plus a fitted model for that league. Run the backfill workflow if the model is missing."
        />
      ) : (
        <>
          <div className="mb-3 grid grid-cols-2 gap-2">
            <Card className="px-3 py-2.5 text-center">
              <p className="tabular text-lg font-semibold text-slate-100">{edges.length}</p>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">compared</p>
            </Card>
            <Card className="px-3 py-2.5 text-center">
              <p
                className={`tabular text-lg font-semibold ${
                  shrinkage.factor > 0.3 ? "text-emerald-300" : "text-slate-500"
                }`}
              >
                {(shrinkage.factor * 100).toFixed(0)}%
              </p>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">
                signal kept
              </p>
            </Card>
          </div>

          <div className="space-y-1.5">
            {edges.slice(0, 40).map((edge) => (
              <EdgeRow key={`${edge.eventId}-${edge.side}`} edge={edge} />
            ))}
          </div>
        </>
      )}

      <Card className="mt-4 px-3.5 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Why the top of this list is not a bet
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          Taking the largest of {edges.length} noisy numbers selects the largest error.
          Simulated against a board where every true edge is exactly zero, the biggest
          figure visible on a typical week is still about 4 points. So the numbers here
          are shrunk: the scatter across the whole board is compared against the scatter
          sampling noise alone would produce, and only the excess survives &mdash;
          currently {(shrinkage.factor * 100).toFixed(0)}% of what was observed
          ({shrinkage.observedSd.toFixed(1)} observed against{" "}
          {shrinkage.noiseSd.toFixed(1)} expected from noise). When nothing is there,
          everything collapses toward zero, which is the correct answer.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          The model is a sample estimate, so every number it produces carries a standard
          error &mdash; about {edges[0]?.standardErrorPoints.toFixed(1) ?? "3"} points at
          the current sample size. An edge smaller than that is indistinguishable from
          the noise in the estimate that produced it.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          That is not theoretical. The largest edge this has ever shown was 6.6 points on
          one game. A single fix &mdash; pricing a juiced spread instead of reading the
          posted number literally &mdash; moved the same game, at the same prices, to 2.8.
          Ranking by an untested model surfaces where it is most wrong, not where the
          market is.
        </p>
      </Card>

      <NotAdvice className="mt-6" />
    </>
  );
}
