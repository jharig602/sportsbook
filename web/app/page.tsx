import Link from "next/link";

import { Card, Empty, NotAdvice, PageHeader, Pill } from "@/components/ui";
import { getData } from "@/lib/data";
import { databaseUrl, databaseUrlSource, isPooled } from "@/lib/env";
import {
  formatKickoff,
  formatLeague,
  formatLine,
  formatPrice,
  formatRelative,
  teamShort,
} from "@/lib/format";
import type { Game, Side } from "@/lib/types";

export const dynamic = "force-dynamic";

const LEAGUES = [
  { key: "all", label: "All" },
  { key: "ncaaf", label: "NCAAF" },
  { key: "nfl", label: "NFL" },
];

function SideRow({ game, side }: { game: Game; side: "home" | "away" }) {
  const team = side === "home" ? game.homeTeam : game.awayTeam;
  const spread = game.spread[side];
  const moneyline = game.moneyline[side];

  return (
    <div className="flex items-center gap-3 py-1">
      <span className="min-w-0 flex-1 truncate text-sm text-slate-200">
        {teamShort(team)}
        {side === "home" ? (
          <span className="ml-1 text-[11px] text-slate-500">(H)</span>
        ) : null}
      </span>
      <span className="tabular w-20 text-right text-sm text-slate-100">
        {formatLine("spread", side, spread?.line)}
        <span className="ml-1 text-[11px] text-slate-500">
          {formatPrice(spread?.price)}
        </span>
      </span>
      <span className="tabular w-14 text-right text-sm text-slate-300">
        {formatPrice(moneyline?.price)}
      </span>
    </div>
  );
}

function GameCard({ game }: { game: Game }) {
  const over = game.total.over;
  const under = game.total.under;

  return (
    <Card href={`/game/${game.eventId}`} className="px-3 py-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Pill>{formatLeague(game.league)}</Pill>
          <span className="text-[11px] text-slate-500">
            {formatKickoff(game.commenceTime)}
          </span>
        </div>
        <span className="text-[11px] text-slate-600">
          {formatRelative(game.lastObserved)}
        </span>
      </div>

      <SideRow game={game} side="away" />
      <SideRow game={game} side="home" />

      {over || under ? (
        <div className="mt-2 flex items-center gap-3 border-t border-edge pt-2 text-[11px] text-slate-400">
          <span className="flex-1">Total</span>
          <span className="tabular w-20 text-right">
            {formatLine("total", "over" as Side, over?.line)}{" "}
            <span className="text-slate-500">{formatPrice(over?.price)}</span>
          </span>
          <span className="tabular w-20 text-right">
            {formatLine("total", "under" as Side, under?.line)}{" "}
            <span className="text-slate-500">{formatPrice(under?.price)}</span>
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
  const all = await data.games();
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
    const day = new Date(game.commenceTime).toLocaleDateString(undefined, {
      weekday: "long",
      month: "short",
      day: "numeric",
    });
    byDay.set(day, [...(byDay.get(day) ?? []), game]);
  }

  return (
    <>
      <PageHeader
        title="Board"
        subtitle={`Current DraftKings prices. ${all.length} games with quotes.`}
      >
        <span className="text-[11px] text-slate-600" title={backendDetail}>
          {data.backend === "postgres" ? `db · ${source}` : "sample data"}
        </span>
      </PageHeader>

      {data.backend === "fixture" ? (
        <p className="mb-3 rounded-lg border border-amber-500/25 bg-amber-500/[0.06] px-3 py-2 text-[11px] leading-relaxed text-amber-200/90">
          Showing bundled sample data. No database URL is set, so these prices are a
          snapshot and will not update. Set <code>DATABASE_URL</code> (or{" "}
          <code>POSTGRES_URL</code>) to connect the live one.
        </p>
      ) : null}

      <div className="mb-4 flex gap-2">
        {LEAGUES.map((option) => (
          <Link
            key={option.key}
            href={option.key === "all" ? "/" : `/?league=${option.key}`}
            className={`rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition-colors ${
              league === option.key
                ? "bg-sky-500/15 text-sky-300 ring-sky-500/30"
                : "text-slate-400 ring-slate-700 hover:text-slate-200"
            }`}
          >
            {option.label}
          </Link>
        ))}
      </div>

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
        <div className="space-y-6">
          {[...byDay.entries()].map(([day, dayGames]) => (
            <section key={day}>
              <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                {day}
                <span className="ml-2 font-normal normal-case text-slate-600">
                  {dayGames.length} games
                </span>
              </h2>
              <div className="space-y-2">
                {dayGames.map((game) => (
                  <GameCard key={game.eventId} game={game} />
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
