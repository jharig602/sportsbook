import { Card, Empty, NotAdvice, PageHeader, Pill, Segmented } from "@/components/ui";
import { getData } from "@/lib/data";
import { formatKickoff } from "@/lib/format";
import { seasonGames } from "@/lib/season-db";
import {
  buildPlan,
  buildWeeks,
  horizonStability,
  type Candidate,
  type Pick,
} from "@/lib/survivor";

export const dynamic = "force-dynamic";

/** Horizons offered. "all" plans every priced week the feed has returned. */
const HORIZONS = [4, 8, 12] as const;

function percent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function line(candidate: Candidate): string {
  const number = candidate.spread > 0 ? `+${candidate.spread}` : `${candidate.spread}`;
  return `${candidate.home ? "vs" : "at"} ${candidate.opponent}, ${number}`;
}

function WeekRow({ entry, first }: { entry: Pick; first: boolean }) {
  const { pick, greedy, sacrifice } = entry;
  if (!pick) return null;

  return (
    <Card className={`px-3 py-2.5 ${first ? "ring-1 ring-inset ring-sky-500/40" : ""}`}>
      <div className="flex items-start gap-2.5">
        <div className="tabular flex h-11 w-16 shrink-0 flex-col items-center justify-center rounded-lg bg-slate-800/60 text-[13px] font-semibold text-slate-200">
          {percent(pick.winProbability)}
          <span className="text-[9px] font-normal opacity-70">to win</span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[14px] font-medium text-slate-100">
            <span className="min-w-0 truncate">{pick.team}</span>
            {first ? <Pill>this week</Pill> : null}
          </p>
          <p className="mt-0.5 truncate text-[11px] text-slate-500">{line(pick)}</p>
          <div className="tabular mt-1 flex flex-wrap items-center gap-x-2.5 text-[10px] text-slate-600">
            <span>week {entry.week}</span>
            <span>{formatKickoff(pick.commenceTime)}</span>
            {sacrifice > 0.005 && greedy ? (
              <span className="text-amber-400/80">
                saving {greedy.team} ({percent(sacrifice)} given up)
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </Card>
  );
}

export default async function SurvivorPage({
  searchParams,
}: {
  searchParams: Promise<{ weeks?: string }>;
}) {
  const { weeks: requested } = await searchParams;
  const data = getData();
  const [models, games] = await Promise.all([
    data.marginModels(),
    data.backend === "postgres" ? seasonGames("nfl") : Promise.resolve([]),
  ]);

  const weeks = buildWeeks(games, models.nfl ?? null);
  const priced = weeks.filter((w) => w.candidates.length > 0).length;

  // The whole season by default. Capping it was a judgement about how much a
  // December line is worth, and making that judgement silently on your behalf is
  // worse than showing the season and saying what the later weeks are made of.
  const chosen = requested === undefined ? "all" : requested;
  const horizon =
    chosen === "all" ? priced : Math.min(priced, Math.max(1, Number(chosen) || priced));
  const plan = buildPlan(weeks, horizon);

  // Does this week's pick actually depend on how far ahead we look?
  const stability = horizonStability(weeks, [...HORIZONS, priced]);
  const distinct = new Set(stability.map((s) => s.team).filter(Boolean));
  const stable = distinct.size <= 1;

  if (plan.weeksPlanned === 0) {
    return (
      <>
        <PageHeader title="Survivor" subtitle="One team a week, each team only once" />
        <Empty
          title="No priced season yet"
          detail="The odds feed has not returned upcoming NFL fixtures with lines. This fills in once the collector has polled."
        />
        <NotAdvice className="mt-6" />
      </>
    );
  }

  const thisWeek = plan.picks[0];
  const alternatives = (weeks[0]?.candidates ?? [])
    .filter((c) => c.team !== thisWeek?.pick?.team)
    .slice(0, 4);

  return (
    <>
      <PageHeader title="Survivor" subtitle="One team a week, each team only once" />

      <div className="mb-3 grid grid-cols-3 gap-2">
        <Card className="px-2 py-2.5 text-center">
          <p className="tabular text-lg font-semibold text-slate-100">{plan.weeksPlanned}</p>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">weeks</p>
        </Card>
        <Card className="px-2 py-2.5 text-center">
          <p className="tabular text-lg font-semibold text-slate-100">
            {percent(plan.survival)}
          </p>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">survive all</p>
        </Card>
        <Card className="px-2 py-2.5 text-center">
          <p
            className={`tabular text-lg font-semibold ${
              plan.survival > plan.greedySurvival ? "text-emerald-300" : "text-slate-500"
            }`}
          >
            +{((plan.survival - plan.greedySurvival) * 100).toFixed(1)}
          </p>
          <p className="text-[10px] uppercase tracking-wide text-slate-500">vs greedy</p>
        </Card>
      </div>

      <Segmented
        options={[
          ...HORIZONS.filter((h) => h < priced).map((h) => ({
            key: String(h),
            label: `${h} weeks`,
          })),
          { key: "all", label: `All ${priced}` },
        ]}
        active={chosen === "all" ? "all" : String(horizon)}
        hrefFor={(key) => `/survivor?weeks=${key}`}
      />

      <Card className="mb-3 px-3.5 py-2.5">
        <p className="text-[12px] leading-relaxed text-slate-400">
          {stable ? (
            <>
              <span className="font-medium text-emerald-300">
                This week&rsquo;s pick does not depend on the horizon.
              </span>{" "}
              {plan.picks[0]?.pick?.team} is chosen whether you plan four weeks ahead or
              all {priced}, which is the strongest thing that can be said for it.
            </>
          ) : (
            <>
              <span className="font-medium text-amber-300">
                This week&rsquo;s pick changes with the horizon.
              </span>{" "}
              {stability
                .map((s) => `${s.horizon}wk: ${s.team ?? "none"}`)
                .join(" · ")}
              . The plan is balanced on a line somewhere later in the season that has not
              been bet into yet, so trust it less, not more.
            </>
          )}
        </p>
      </Card>

      <div className="space-y-1.5">
        {plan.picks.map((entry, index) => (
          <WeekRow key={entry.week} entry={entry} first={index === 0} />
        ))}
      </div>

      {alternatives.length > 0 ? (
        <Card className="mt-3 px-3.5 py-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Other options this week
          </h2>
          <div className="mt-2 space-y-1">
            {alternatives.map((candidate) => (
              <p
                key={candidate.team}
                className="tabular flex items-baseline justify-between text-[12px]"
              >
                <span className="min-w-0 truncate text-slate-300">
                  {candidate.team}{" "}
                  <span className="text-slate-600">{line(candidate)}</span>
                </span>
                <span className="shrink-0 pl-2 text-slate-400">
                  {percent(candidate.winProbability)}
                </span>
              </p>
            ))}
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
            A higher number here is not a better pick. The plan gives up probability this
            week when the team is worth more in a week where nothing else is.
          </p>
        </Card>
      ) : null}

      <Card className="mt-4 px-3.5 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          How this is chosen
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          The trap is picking greedily. Taking the biggest favourite every week spends
          your best teams in September against opponents you would have beaten with
          anyone, and leaves December holding only teams you have already used. The
          question is not who is safest this week but{" "}
          <em>which week each team is worth spending in</em>, which is an assignment
          problem rather than a ranking.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          So this maximises the chance of surviving <em>every</em> planned week at once
          &mdash; the product of the chosen probabilities &mdash; solved exactly, not
          approximated. Against picking the biggest available favourite each week it is
          worth {((plan.survival - plan.greedySurvival) * 100).toFixed(1)} points of
          survival over {plan.weeksPlanned} weeks.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          Win probabilities come from the median spread across {" "}
          {games[0]?.books ?? "several"} books, converted using the residual
          distribution fitted to{" "}
          {(models.nfl?.games ?? 0).toLocaleString()} completed NFL games. No power
          rating of ours is involved: this is the market&rsquo;s opinion, priced.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          Two limits worth holding onto. Lines beyond the next week or two are early and
          will move, often by several points &mdash; so treat this as a way of choosing{" "}
          <em>this</em> week with the rest of the season in view, not a commitment to
          week {plan.picks[plan.picks.length - 1]?.week}. And the plan assumes you
          survive; a real pool ends the moment you lose, which means the early weeks
          deserve more weight than the arithmetic alone gives them.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          That is why the horizon is a control rather than a hidden constant. Planning
          further satisfies more constraints, which is the point &mdash; but it does so
          using numbers nobody has bet into. The line above says whether it actually
          matters here: if this week&rsquo;s pick is the same at four weeks and at{" "}
          {priced}, the horizon is not doing the work and you can stop worrying about it.
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
          {priced} of {weeks.length} weeks on the schedule are priced
          {plan.unplannedWeeks > 0
            ? `; this plan covers ${plan.weeksPlanned} of them`
            : ", and all of them are planned here"}
          .
        </p>
      </Card>

      <NotAdvice className="mt-6" />
    </>
  );
}
