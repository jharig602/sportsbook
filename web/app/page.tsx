import { TeamLogo } from "@/components/TeamLogo";
import { Banner, Card, Empty, NotAdvice, PageHeader, Pill, Segmented } from "@/components/ui";
import { databaseStatus, getData } from "@/lib/data";
import { databaseUrl, databaseUrlSource, isPooled } from "@/lib/env";
import { formatDay, formatKickoff, formatLeague, formatLine, formatPrice, formatRelative } from "@/lib/format";
import type { Game, Side } from "@/lib/types";
import { boardGames } from "@/lib/ordering";
import { costToAmerican, effectiveAsk, isThin, type KalshiGame } from "@/lib/kalshi";
import { kalshiGames } from "@/lib/kalshi-db";

export const dynamic = "force-dynamic";

const LEAGUES = [
  { key: "all", label: "All" },
  { key: "ncaaf", label: "NCAAF" },
  { key: "nfl", label: "NFL" },
];

/**
 * Kalshi's price to BUY this side, fee included, as an American price -- what the
 * contract really costs, not its midpoint. "thin" when the market is too wide or shallow
 * to stand as a reference. A dash when Kalshi does not list the game (yet).
 */
function KalshiCell({ kalshi, side }: { kalshi: KalshiGame | undefined; side: "home" | "away" }) {
  const snap = kalshi?.[side];
  if (!snap) return <span className="tabular w-12 text-right text-[11px] text-slate-700">—</span>;
  const thin = isThin(snap);
  const price = costToAmerican(effectiveAsk(snap.yesAsk));
  return (
    <span
      className={`tabular w-12 text-right text-[11px] ${thin ? "text-slate-600" : "text-violet-300"}`}
      title={thin ? "Kalshi market too thin to trust" : "Kalshi, to buy, after its fee"}
    >
      {thin ? "thin" : formatPrice(price)}
    </span>
  );
}

function SideRow({ game, side, kalshi }: { game: Game; side: "home" | "away"; kalshi?: KalshiGame }) {
  const team = side === "home" ? game.homeTeam : game.awayTeam;
  const spread = game.spread[side];
  const moneyline = game.moneyline[side];
  const favourite =
    spread?.line !== null && spread?.line !== undefined && spread.line < 0;

  return (
    <div className="flex items-center gap-2.5 py-[5px]">
      <TeamLogo
        league={game.league}
        teamId={side === "home" ? game.homeTeamId : game.awayTeamId}
        name={team}
      />
      <span
        className={`min-w-0 flex-1 truncate text-[14px] ${
          favourite ? "font-medium text-slate-100" : "text-slate-300"
        }`}
      >
        {team ?? "?"}
      </span>
      <span className="tabular w-[72px] text-right text-[14px] font-medium text-slate-100">
        {formatLine("spread", side, spread?.line)}
        <span className="ml-1 text-[10px] font-normal text-slate-500">
          {formatPrice(spread?.price)}
        </span>
      </span>
      <span className="tabular w-14 text-right text-[13px] text-slate-400">
        {formatPrice(moneyline?.price)}
      </span>
      <KalshiCell kalshi={kalshi} side={side} />
    </div>
  );
}

function GameCard({ game, kalshi }: { game: Game; kalshi?: KalshiGame }) {
  const over = game.total.over;
  const under = game.total.under;

  return (
    <Card href={`/game/${game.eventId}`} className="px-3 py-2.5">
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Pill>{formatLeague(game.league)}</Pill>
          <span className="text-[11px] text-slate-500">
            {formatKickoff(game.commenceTime)}
          </span>
        </div>
        <span className="text-[10px] text-slate-600">
          {formatRelative(game.lastObserved)}
        </span>
      </div>

      <SideRow game={game} side="away" kalshi={kalshi} />
      <SideRow game={game} side="home" kalshi={kalshi} />

      {over || under ? (
        <div className="mt-2 flex items-center gap-2.5 border-t border-edge/70 pt-2 text-[11px]">
          <span className="flex-1 uppercase tracking-wider text-slate-600">Total</span>
          <span className="tabular text-slate-300">
            {formatLine("total", "over" as Side, over?.line)}
            <span className="ml-1 text-slate-500">{formatPrice(over?.price)}</span>
          </span>
          <span className="tabular text-slate-300">
            {formatLine("total", "under" as Side, under?.line)}
            <span className="ml-1 text-slate-500">{formatPrice(under?.price)}</span>
          </span>
        </div>
      ) : null}
    </Card>
  );
}

export default async function BoardPage({
  searchParams,
}: {
  searchParams: Promise<{ league?: string }>;
}) {
  const { league = "all" } = await searchParams;
  const data = getData();
  const [every, results, kalshi] = await Promise.all([
    data.games(),
    data.results(),
    data.backend === "postgres" ? kalshiGames().catch(() => new Map<string, KalshiGame>()) : Promise.resolve(new Map<string, KalshiGame>()),
  ]);
  // Only games still to play or under way; finished ones belong to the Record, not here.
  const all = boardGames(every, new Set(results.map((r) => r.event_id)));
  const issue = databaseStatus();
  const source = databaseUrlSource() ?? "none";
  // Surfaced on hover: an unpooled URL works but exhausts connections under
  // serverless load, which shows up as intermittent failures rather than an error.
  const backendDetail =
    data.backend === "postgres"
      ? `${source}${isPooled(databaseUrl()) ? " (pooled)" : " (NOT pooled)"}`
      : "No database URL set; serving the bundled fixture.";
  const games = league === "all" ? all : all.filter((g) => g.league === league);

  const byDay = new Map<string, Game[]>();
  for (const game of games) {
    const day = formatDay(game.commenceTime);
    byDay.set(day, [...(byDay.get(day) ?? []), game]);
  }

  return (
    <>
      <PageHeader title="Board" subtitle={`${all.length} games with live prices`}>
        <span className="text-[10px] text-slate-600" title={backendDetail}>
          {data.backend === "postgres" ? "live" : "sample"}
        </span>
      </PageHeader>

      {data.backend === "fixture" ? (
        <Banner tone="warn">
          Showing bundled sample data. No database URL is set, so these prices are a
          snapshot and will not update.
        </Banner>
      ) : null}

      {issue === "schema_missing" ? (
        <Banner tone="info">
          Database connected, but no tables yet — the collector has never run. Trigger the{" "}
          <span className="font-medium">collect</span> workflow in GitHub Actions once.
        </Banner>
      ) : null}

      {issue === "unreachable" ? (
        <Banner tone="error">
          Could not reach the database. Check the connection string is the pooled one and
          that the Neon project is not paused.
        </Banner>
      ) : null}

      <Segmented
        options={LEAGUES}
        active={league}
        hrefFor={(key) => (key === "all" ? "/" : `/?league=${key}`)}
      />

      {kalshi.size > 0 ? (
        <p className="-mt-1 mb-3 text-[11px] leading-relaxed text-slate-500">
          <span className="text-violet-300">Purple</span>, far right: Kalshi&rsquo;s price to buy that
          side after its fee. Reference only &mdash; Kalshi sports can&rsquo;t be traded from
          Michigan &mdash; but it joins every comparison as one more book.
        </p>
      ) : null}

      {games.length === 0 ? (
        <Empty
          title="No priced games"
          detail={
            <>
              Either nothing has been collected yet, or the book has not posted numbers
              for this slate. College lines appear late — only about 6% of NCAAF games
              are priced 13 days out, rising to roughly 59% at six days.
            </>
          }
        />
      ) : (
        <div className="space-y-5">
          {[...byDay.entries()].map(([day, dayGames]) => (
            <section key={day}>
              <h2 className="mb-2 flex items-baseline gap-2 px-0.5">
                <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                  {day}
                </span>
                <span className="text-[11px] text-slate-600">{dayGames.length}</span>
              </h2>
              <div className="space-y-1.5">
                {dayGames.map((game) => (
                  <GameCard key={game.eventId} game={game} kalshi={kalshi.get(game.eventId)} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}

      <NotAdvice className="mt-8" />
    </>
  );
}
