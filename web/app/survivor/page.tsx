import { fieldState } from "@/lib/pools";
import Link from "next/link";
import { LogPickButton } from "@/components/LogPickButton";
import { PinPicker } from "@/components/PinPicker";
import { PoolPicker } from "@/components/PoolPicker";
import {
  Card,
  Empty,
  Explainer,
  NotAdvice,
  PageHeader,
  Pill,
  Segmented,
  Stats,
} from "@/components/ui";
import { allBookLines, type BookLineRow } from "@/lib/book-lines";
import { getMyBooks, getPools, poolLabel } from "@/lib/settings-db";
import { toBettable, type BettablePick } from "@/lib/survivor-bet";
import { getData } from "@/lib/data";
import { formatKickoff } from "@/lib/format";
import { parsePins } from "@/lib/pins";
import { extraLifeMultiple, poolOdds } from "@/lib/pool-odds";
import { currentNflWeek, pickPopularity, seasonGames, seasonOpener } from "@/lib/season-db";
import { buildPoolWinPlans, crowdingFrom, poolWinStability } from "@/lib/pool-win";
import { buildPlan, buildWeeks, type Candidate, type Pick } from "@/lib/survivor";

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

function WeekRow({
  entry,
  first,
  bettable,
  options,
  pinned,
}: {
  entry: Pick;
  first: boolean;
  bettable: BettablePick | null;
  /** Teams playable this week that this entry has not already spent. */
  options: Array<{ team: string; winProbability: number }>;
  pinned: boolean;
}) {
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

          <PinPicker
            week={entry.week}
            options={options}
            current={pick.team}
            pinned={pinned}
          />

          {bettable?.eventId && bettable.price !== null && bettable.book ? (
            <LogPickButton
              eventId={bettable.eventId}
              league={bettable.league ?? "nfl"}
              homeTeam={pick.home ? pick.team : pick.opponent}
              awayTeam={pick.home ? pick.opponent : pick.team}
              commenceTime={pick.commenceTime}
              side={pick.home ? "home" : "away"}
              price={bettable.price}
              book={bettable.book}
              team={pick.team}
              expectedRoi={bettable.expectedRoi}
              week={entry.week}
            />
          ) : bettable?.blocked ? (
            <p className="mt-1.5 text-[10px] text-slate-600">{bettable.blocked}</p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export default async function SurvivorPage({
  searchParams,
}: {
  searchParams: Promise<{ weeks?: string; pool?: string; pin?: string }>;
}) {
  const { weeks: requested, pool: poolParam, pin: pinParam } = await searchParams;
  const data = getData();
  const postgres = data.backend === "postgres";
  const [models, games, board, quotes, myBooks, opener] = await Promise.all([
    data.marginModels(),
    postgres ? seasonGames("nfl") : Promise.resolve([]),
    data.games(),
    postgres ? allBookLines() : Promise.resolve(new Map()),
    postgres ? getMyBooks() : Promise.resolve([] as string[]),
    // Week numbers count from the opener, not from whatever fixtures remain.
    postgres ? seasonOpener("nfl") : Promise.resolve(null),
  ]);
  // The real NFL week, not the planner's index: the collector files pick shares under
  // the season week, and asking for 1 every week reads September's crowd in November.
  const popularity = postgres ? await pickPopularity(await currentNflWeek()) : {};
  const pools = postgres
    ? await getPools()
    : [{ used: [] as string[], size: 1, lossesAllowed: 0 }];

  // Only the moneyline matters for a survivor pick: the question is whether the team
  // wins, not by how much.
  const moneylines = new Map<string, Array<{ book: string; market: string; side: string; price: number | null }>>();
  for (const [eventId, rows] of quotes) {
    moneylines.set(
      eventId,
      rows.map((row: BookLineRow) => ({
        book: row.book,
        market: row.market,
        side: row.side,
        price: row.price,
      })),
    );
  }

  const weeks = buildWeeks(games, models.nfl ?? null, opener);
  const priced = weeks.filter((w) => w.candidates.length > 0).length;

  // The whole season by default. Capping it was a judgement about how much a
  // December line is worth, and making that judgement silently on your behalf is
  // worse than showing the season and saying what the later weeks are made of.
  const chosen = requested === undefined ? "all" : requested;
  const horizon =
    chosen === "all" ? priced : Math.min(priced, Math.max(1, Number(chosen) || priced));
  // How concentrated the field is, measured rather than assumed. `crowdingFrom` returns
  // null when the popularity feed has nothing, and null must become 0 rather than a
  // guess: with no measurement there is no basis for believing the field converges, and
  // at 0 the pool-win objective collapses back to plain survival. That is the right
  // behaviour when we do not know, and it is what ran before this model existed.
  const horizonWeeks = weeks.slice(0, horizon);
  const crowdTeam = buildPlan(horizonWeeks, horizon).greedyPicks[0]?.team ?? null;
  const measuredCrowding = crowdingFrom(popularity, crowdTeam);
  const crowding = measuredCrowding ?? 0;

  // Every entry planned at once, so the current week's picks can be kept apart. Two
  // entries on the same team is one bet paid for twice.
  //
  // Ranked on P(take the pool) rather than P(survive), which are different objectives
  // and only coincide when the field picks independently. See `pool-win.ts`: at the
  // 27.6% crowding the popularity feed actually reports, planning is worth about a
  // third again as much as the survival number alone can see.
  //
  // Pins are a what-if on the entry you are looking at, so they attach to that pool
  // only. The unpinned plan is computed alongside rather than instead: a pinned week is
  // only worth showing next to what the planner would have done and what the difference
  // costs, and without the baseline the page would just obey.
  const rawIndex = Math.max(0, Number(poolParam ?? 0) || 0);
  const viewing = Math.min(rawIndex, pools.length - 1);
  const requestedPins = parsePins(pinParam);

  // A pin can name a team that is not playing that week, or one this entry has already
  // spent. The planner refuses to substitute in that case and leaves the week empty,
  // which is right for a library but wrong for a page: what you get back is a season
  // with a hole in it and no explanation. So they are separated here -- only playable
  // pins are planned, and the rest are reported as not available.
  //
  // Doing this the other way round is how the first version was wrong: an impossible
  // pin on the opening week fell through to the planner's own pick and the page then
  // announced the change was "at least as good", which was true only because nothing
  // had happened.
  const spentByViewer = new Set(pools[viewing]?.used ?? []);
  const playableThatWeek = (week: number, team: string) =>
    !spentByViewer.has(team) &&
    (weeks.find((w) => w.week === week)?.candidates ?? []).some((c) => c.team === team);

  const pins = new Map<number, string>();
  const unavailablePins: Array<{ week: number; team: string }> = [];
  for (const [week, team] of requestedPins) {
    if (playableThatWeek(week, team)) pins.set(week, team);
    else unavailablePins.push({ week, team });
  }

  const withPins = pools.map((pool, i) => (i === viewing ? { ...pool, pinned: pins } : pool));

  const poolPlans = buildPoolWinPlans(horizonWeeks, withPins, {
    crowding,
    popularity,
    crowdingMeasured: measuredCrowding !== null,
  });
  const baseline =
    pins.size > 0 ? buildPoolWinPlans(horizonWeeks, pools, {
        crowding,
        popularity,
        crowdingMeasured: measuredCrowding !== null,
      }) : poolPlans;
  const hasWhatIf = pins.size > 0 || unavailablePins.length > 0;
  const survivals = poolPlans.map((p) => p.plan.survival).filter((s) => s > 0);
  const multi = {
    pools: poolPlans.map((p) => ({ pool: p.pool, plan: p.plan })),
    atLeastOne: survivals.length ? 1 - survivals.reduce((acc, s) => acc * (1 - s), 1) : 0,
    single: survivals[0] ?? 0,
  };
  const poolIndex = Math.min(viewing, multi.pools.length - 1);
  const plan = multi.pools[poolIndex]?.plan ?? multi.pools[0].plan;
  // Named apart from the `entry` prop WeekRow takes, and from the map below.
  const poolEntry = poolPlans[poolIndex] ?? poolPlans[0];

  // The odds that actually matter: survival with a spare life, and what surviving is
  // worth against a field of this size.
  const odds = multi.pools.map((entry) => {
    const probs = entry.plan.picks
      .map((pick) => pick.pick?.winProbability)
      .filter((v): v is number => v !== undefined);
    return {
      pool: entry.pool,
      probs,
      // The recorded field, so "field left" counts a rival on their last life as having
      // one life, not two.
      odds: poolOdds(
        probs,
        entry.pool.lossesAllowed ?? 0,
        entry.pool.size ?? 1,
        fieldState(entry.pool),
      ),
      // What a spare life is worth only means something if you still have one to spare.
      lifeMultiple: fieldState(entry.pool).livesLeft > 0 ? extraLifeMultiple(probs) : 1,
    };
  });
  const here = odds[poolIndex] ?? odds[0];
  const hereState = fieldState(here.pool);

  const ranking = poolEntry?.ranking ?? [];

  // What the season is worth with the pins, and what it was worth without them. The
  // survival figure has to be recomputed from the pinned plan's own weekly numbers --
  // reusing the unpinned one would show a constraint costing nothing at all.
  const spentHere = new Set(pools[poolIndex]?.used ?? []);
  const weekByNumber = new Map(horizonWeeks.map((w) => [w.week, w]));
  const optionsFor = (week: number) =>
    (weekByNumber.get(week)?.candidates ?? [])
      .filter((c) => !spentHere.has(c.team))
      .map((c) => ({ team: c.team, winProbability: c.winProbability }));

  const before = baseline[poolIndex] ?? baseline[0];
  const beforeProbs = (before?.plan.picks ?? [])
    .map((p) => p.pick?.winProbability)
    .filter((v): v is number => v !== undefined);
  const beforeOdds = poolOdds(
    beforeProbs,
    here.pool.lossesAllowed ?? 0,
    here.pool.size ?? 1,
    hereState,
  );
  const whatIf =
    hasWhatIf
      ? {
          survival: here.odds.survival,
          wasSurvival: beforeOdds.survival,
          poolWin: poolEntry?.poolWin ?? 0,
          wasPoolWin: before?.poolWin ?? 0,
          // Weeks where the pin actually moved the plan. Pinning the team the planner
          // already wanted changes nothing, and saying so is more useful than showing
          // a row of zeroes.
          moved: [...pins.entries()].filter(
            ([week, team]) =>
              before?.plan.picks.find((p) => p.week === week)?.pick?.team !== team,
          ).length,
          unavailable: unavailablePins,
        }
      : null;
  // The crowding the viewed pool was actually planned against: its own measured herding
  // when its sheets have been read, the national feed otherwise. Every sentence below
  // quotes this one number, so the text can never describe a different field than the
  // pick above it was ranked against.
  const viewedPool = pools[poolIndex];
  const ownCrowd = viewedPool?.crowd && viewedPool.crowd.picks > 0 ? viewedPool.crowd : null;
  const hereCrowding = poolEntry?.crowding ?? crowding;
  // Measured if either source exists: a pool's own sheets count as measuring the field.
  const havePopularity = measuredCrowding !== null || ownCrowd !== null;

  // Does this week's pick actually depend on how far ahead we look?
  // On the same objective as the headline pick. Reporting the survival-optimal team
  // here while the page recommends the pool-optimal one would have the card contradict
  // the pick sitting directly above it.
  const stability = poolWinStability(weeks, [...HORIZONS, priced], {
    used: new Set(pools[poolIndex]?.used ?? []),
    lossesAllowed: pools[poolIndex]?.lossesAllowed ?? 0,
    // Same field the headline pick was ranked against, or the card would be answering
    // the question for an unbeaten pool while the pick above it answers the real one.
    poolSize: hereState.rivals + 1,
    rivalLosses: hereState.rivalLosses,
    myLosses: hereState.myLosses,
    crowding: hereCrowding,
    popularity,
  });
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

      <Stats
        items={[
          { value: String(plan.weeksPlanned), label: "weeks" },
          {
            value: percent(here.odds.survival),
            label:
              hereState.livesLeft > 0
                ? `survive · ${hereState.livesLeft + 1} lives`
                : "survive all",
          },
          {
            value: percent(poolEntry?.poolWin ?? here.odds.winChance),
            label: "last standing",
            tone: "good" as const,
          },
        ]}
      />

      {multi.pools.length > 1 ? (
        <Card className="mb-3 px-3.5 py-2.5">
          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            This week
          </p>
          <div className="mt-1.5 space-y-1">
            {multi.pools.map((entry, i) => (
              <p key={i} className="flex items-baseline justify-between text-[12px]">
                <span className="text-slate-400">{poolLabel(pools[i], i, pools)}</span>
                <span className="tabular text-slate-200">
                  {entry.plan.picks[0]?.pick
                    ? `${entry.plan.picks[0].pick.team} (${percent(entry.plan.picks[0].pick.winProbability)})`
                    : "nothing available"}
                </span>
              </p>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-slate-600">
            Different teams on purpose &mdash; at least one survives{" "}
            {percent(multi.atLeastOne)} against {percent(multi.single)} alone.
          </p>
        </Card>
      ) : null}

      <Card className="mb-3 px-3.5 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {poolLabel(pools[poolIndex], poolIndex, pools)}: {here.pool.size} entrants,{" "}
          {(here.pool.lossesAllowed ?? 0) === 0
            ? "out on the first loss"
            : `out on loss ${(here.pool.lossesAllowed ?? 0) + 1}`}
        </h2>
        {/*
          The field as it stands, said out loud. Every number on this card and the pick
          above it turn on it, and an unrecorded field silently plans against a pool in
          which nobody has lost -- true for exactly one week of the season.
        */}
        <p
          className={`mt-1 text-[11px] leading-relaxed ${
            hereState.recorded && !hereState.problem ? "text-slate-500" : "text-amber-300/90"
          }`}
        >
          {hereState.recorded ? (
            <>
              Against {hereState.rivals} rival{hereState.rivals === 1 ? "" : "s"}:{" "}
              {hereState.rivalLosses
                .map((n, k) =>
                  k === 0
                    ? `${n} unbeaten`
                    : k === (here.pool.lossesAllowed ?? 0)
                      ? `${n} on their last life`
                      : `${n} on ${k} loss${k === 1 ? "" : "es"}`,
                )
                .join(", ")}
              . You{" "}
              {hereState.livesLeft < 0
                ? "are out of this pool."
                : hereState.myLosses === 0
                  ? "are unbeaten."
                  : hereState.livesLeft === 0
                    ? "are on your last life."
                    : `have ${hereState.myLosses} loss${hereState.myLosses === 1 ? "" : "es"}.`}
            </>
          ) : (
            <>
              Field not recorded, so every rival is treated as unbeaten. After week 1 that
              overstates how long the pool lasts &mdash; record it under &ldquo;edit&rdquo;.
            </>
          )}
          {hereState.problem ? <> {hereState.problem}</> : null}
        </p>

        <div className="tabular mt-2 space-y-1 text-[12px]">
          {[4, 8, 12, 18]
            .filter((w) => w <= here.odds.alive.length)
            .map((w) => (
              <p key={w} className="flex items-baseline justify-between">
                <span className="text-slate-500">after week {w}</span>
                <span className="text-slate-300">
                  you {percent(here.odds.alive[w - 1])}
                  <span className="ml-2 text-slate-500">
                    field {here.odds.fieldAlive[w - 1].toFixed(1)} left
                  </span>
                </span>
              </p>
            ))}
        </div>

        <p className="mt-2 text-[11px] text-slate-500">
          {hereState.livesLeft > 0 ? (
            <>
              Spare life worth{" "}
              <span className="font-medium text-slate-300">
                {here.lifeMultiple.toFixed(1)}&times;
              </span>
              .{" "}
            </>
          ) : null}
          {here.odds.likelyEndWeek === null ? (
            <span className="text-amber-400/90">
              Does not resolve inside the season &mdash; about{" "}
              {here.odds.fieldAlive[here.odds.fieldAlive.length - 1].toFixed(0)} rivals
              still standing, so separation decides it, not survival.
            </span>
          ) : (
            <>
              Field drops under one rival by week{" "}
              <span className="font-medium text-slate-300">
                {here.odds.likelyEndWeek}
              </span>
              .
            </>
          )}
        </p>
      </Card>

      {multi.pools.length > 1 ? (
        <Segmented
          options={multi.pools.map((entry, i) => ({
            key: String(i),
            label: poolLabel(pools[i], i, pools),
          }))}
          active={String(poolIndex)}
          hrefFor={(key) => `/survivor?pool=${key}&weeks=${chosen}`}
        />
      ) : null}

      <PoolPicker
        pools={pools}
        index={poolIndex}
        suggestion={plan.picks[0]?.pick?.team ?? null}
        teams={[...new Set(weeks.flatMap((w) => w.candidates.map((c) => c.team)))].sort()}
      />

      <Segmented
        options={[
          ...HORIZONS.filter((h) => h < priced).map((h) => ({
            key: String(h),
            label: `${h} weeks`,
          })),
          { key: "all", label: `All ${priced}` },
        ]}
        active={chosen === "all" ? "all" : String(horizon)}
        hrefFor={(key) => `/survivor?pool=${poolIndex}&weeks=${key}`}
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

      {whatIf ? (
        <Card className="mb-3 border-amber-700/40 px-3.5 py-3">
          <div className="flex items-baseline justify-between">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-amber-300">
              {pins.size > 0
                ? `What if — ${pins.size} week${pins.size === 1 ? "" : "s"} pinned`
                : "What if — pin not available"}
            </h2>
            <Link
              href={`/survivor?${new URLSearchParams({
                ...(requested !== undefined ? { weeks: chosen } : {}),
                ...(poolIndex > 0 ? { pool: String(poolIndex) } : {}),
              }).toString()}`}
              className="text-[11px] text-slate-500 underline underline-offset-2"
            >
              clear
            </Link>
          </div>

          {pins.size > 0 ? (
          <div className="tabular mt-2 grid grid-cols-2 gap-2 text-[12px]">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">survive</p>
              <p className="text-slate-200">
                {percent(whatIf.survival)}{" "}
                <span className="text-slate-600">was {percent(whatIf.wasSurvival)}</span>
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">
                win the pool
              </p>
              <p className="text-slate-200">
                {percent(whatIf.poolWin)}{" "}
                <span className="text-slate-600">was {percent(whatIf.wasPoolWin)}</span>
              </p>
            </div>
          </div>
          ) : null}

          <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
            {whatIf.unavailable.length > 0 ? (
              <span className="text-rose-300">
                {whatIf.unavailable
                  .map((u) => `${u.team} in week ${u.week}`)
                  .join(", ")}{" "}
                {whatIf.unavailable.length === 1 ? "is" : "are"} not available &mdash; not
                playing that week, or already spent. Left out rather than quietly
                replaced.
                {pins.size > 0
                  ? " The other pins were applied, and the figures above are for those alone."
                  : " Nothing else was pinned, so the plan below is the ordinary one."}
              </span>
            ) : whatIf.moved === 0 ? (
              <>
                These are the teams the planner already wanted, so nothing changed. That
                is a real answer: the pick was not finely balanced against the
                alternatives you tried.
              </>
            ) : (
              <>
                {whatIf.poolWin >= whatIf.wasPoolWin ? (
                  <span className="font-medium text-emerald-300">
                    This is at least as good.
                  </span>
                ) : (
                  <span className="font-medium text-amber-300">
                    This costs{" "}
                    {((whatIf.wasPoolWin - whatIf.poolWin) * 100).toFixed(2)} points of
                    pool win.
                  </span>
                )}{" "}
                The rest of the season is re-planned around the pin, so the figures above
                are for the whole line, not just the week you changed &mdash; a week you
                fix early is a team December no longer has.
              </>
            )}
          </p>
        </Card>
      ) : null}

      <div className="space-y-1.5">
        {plan.picks.map((entry, index) => (
          <WeekRow
            key={entry.week}
            entry={entry}
            first={index === 0}
            bettable={
              entry.pick ? toBettable(entry.pick, board, moneylines, myBooks) : null
            }
            options={optionsFor(entry.week)}
            pinned={pins.has(entry.week)}
          />
        ))}
      </div>

      {ranking.length > 0 ? (
        <Card className="mt-3 px-3.5 py-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Against the field ({here.pool.size} entrants)
          </h2>

          <div className="tabular mt-2 space-y-1 text-[12px]">
            {ranking.slice(0, 5).map((row) => (
              <p key={row.candidate.team} className="flex items-baseline justify-between">
                <span className="min-w-0 truncate text-slate-300">
                  {row.candidate.team}
                  <span className="ml-1.5 text-slate-600">
                    {percent(row.candidate.winProbability)} win
                  </span>
                </span>
                <span className="shrink-0 pl-2 text-slate-500">
                  {row.share !== null ? `${(row.share * 100).toFixed(1)}% picked` : ""}
                  <span className="ml-2 text-slate-300">{percent(row.poolWin)}</span>
                </span>
              </p>
            ))}
          </div>

          {/*
            Stated because the effect is visible and the cause was not: entries are kept
            off each other's team for the current week, so changing one pool's pick moves
            another's, and which entry wins a contested team depends only on the order the
            pools are stored in. Unexplained, that reads as the page changing your other
            entry by itself.
          */}
          {poolEntry?.keptOff?.length ? (
            <p className="mt-2 rounded-lg bg-raised/50 px-2.5 py-2 text-[11px] leading-relaxed text-slate-400">
              <span className="font-medium text-slate-300">
                Kept off {poolEntry.keptOff.join(", ")} this week.
              </span>{" "}
              {pools.length > 1 ? "Another of your entries" : "Another entry"} has{" "}
              {poolEntry.keptOff.length === 1 ? "that team" : "those teams"}, and two
              entries on one team is a single bet paid for twice. Only this week is
              reserved &mdash; the rest of the season is planned freely, because
              re-planning next week undoes any cost.
            </p>
          ) : null}

          <p className="mt-2.5 text-[12px] leading-relaxed text-slate-400">
            {!havePopularity ? (
              <>
                <span className="font-medium text-slate-300">
                  Ranked on survival, because the field is unmeasured.
                </span>{" "}
                Nothing has been collected from the popularity feed this week, so there
                is no basis for assuming the pool converges on a team &mdash; and with an
                uncorrelated field, separating from it is worth nothing. This is the
                safest pick, and that is the honest answer without the data.
              </>
            ) : poolEntry?.insteadOf ? (
              <>
                <span className="font-medium text-amber-300">
                  Going against the field pays here.
                </span>{" "}
                {ranking[0].candidate.team} takes the pool more often than{" "}
                {poolEntry.insteadOf.team} despite winning{" "}
                {percent(poolEntry.insteadOf.winProbability - ranking[0].candidate.winProbability)}{" "}
                less often. Surviving alongside {(hereCrowding * 100).toFixed(0)}% of the
                pool does not decide anything; the weeks they lose and you do not are the
                weeks you gain the whole field.{" "}
                {poolEntry.crossover !== null ? (
                  <span className="text-slate-500">
                    It needs the field above {(poolEntry.crossover * 100).toFixed(0)}% on
                    one team to be the better play, and{" "}
                    {(hereCrowding * 100).toFixed(0)}% is measured
                    {hereCrowding - poolEntry.crossover < 0.05
                      ? " — close enough that a quiet week would flip it back."
                      : "."}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <span className="font-medium text-emerald-300">
                  The safest pick is also the best one here.
                </span>{" "}
                At {(hereCrowding * 100).toFixed(0)}% on one team the field is not crowded
                enough to be worth avoiding &mdash; separating would cost more survival
                than it trims off the pool. That flips once one team is on most of the
                tickets, which is what this card is watching for.
              </>
            )}
          </p>

          <p className="mt-1.5 text-[11px] text-slate-600">
            Ranked on last-one-standing over {plan.weeksPlanned} weeks.{" "}
            {ownCrowd
              ? `${(hereCrowding * 100).toFixed(0)}% crowding: this pool's own picks (${Math.round(
                  (ownCrowd.top / ownCrowd.picks) * 100,
                )}% on the top team over ${ownCrowd.picks} picks)${
                  measuredCrowding !== null
                    ? `, blended with the national ${Math.round(measuredCrowding * 100)}%`
                    : ""
                }.`
              : havePopularity
                ? `${(hereCrowding * 100).toFixed(0)}% crowding measured this week, assumed to hold.`
                : "No popularity collected, so no crowding is assumed."}
          </p>
        </Card>
      ) : null}

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

      <Explainer title="How this is chosen">
        <p className="text-[12px] leading-relaxed text-slate-400">
          The trap is picking greedily. Taking the biggest favourite every week spends
          your best teams in September against opponents you would have beaten with
          anyone, and leaves December holding only teams you have already used.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          So it does not maximise survival. It maximises the chance you are the{" "}
          <em>last entrant standing</em> &mdash; which is the actual rule, and a
          different question, because this pool empties entirely a good share of seasons
          and every one of those still has a winner. Against picking the biggest
          available favourite each week, the plan is worth{" "}
          {((plan.survival - plan.greedySurvival) * 100).toFixed(1)} points of survival
          over {plan.weeksPlanned} weeks &mdash; but survival is only part of what it is
          buying. The rest is not sharing a ticket with the crowd, because a week you
          both win decides nothing and a week you both lose ends you together.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          Win probabilities come from the median spread across{" "}
          {games[0]?.books ?? "several"} books, converted using the residual distribution
          fitted to {(models.nfl?.games ?? 0).toLocaleString()} completed NFL games. No
          power rating of ours is involved: this is the market&rsquo;s opinion, priced.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          Two limits. Lines beyond the next week or two are early and will move by
          several points, so treat this as a way of choosing <em>this</em> week with the
          season in view rather than a commitment to week{" "}
          {plan.picks[plan.picks.length - 1]?.week}. And the crowding rate is measured
          once, on this week&rsquo;s popularity, then assumed to hold &mdash; the softest
          input here by some distance.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          <span className="font-medium text-slate-300">On betting these picks.</span> A
          survivor pick and a good moneyline bet are chosen by opposite rules. Survivor
          wants the highest chance of winning and does not care what it pays. A bet wants
          the largest gap between what a team is worth and what it costs &mdash; and a
          heavy favourite is where that gap is smallest. So the expected return is shown
          on every button, and it is usually negative.
        </p>
        <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
          {priced} of {weeks.length} weeks on the schedule are priced
          {plan.unplannedWeeks > 0
            ? `; this plan covers ${plan.weeksPlanned} of them`
            : ", and all of them are planned here"}
          .
        </p>
      </Explainer>

      <NotAdvice className="mt-6" />
    </>
  );
}
