import { Card, Empty, NotAdvice, PageHeader } from "@/components/ui";
import { allBookLines, quotesForGame } from "@/lib/book-lines";
import { gameChance, bestWeeklyEntry, rankConfidence, tiebreakerTotal, TOP_POINTS, weekWindow, type ConfidenceGame } from "@/lib/confidence";
import { getData } from "@/lib/data";
import { formatKickoff } from "@/lib/format";

export const dynamic = "force-dynamic";

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** This week's confidence picks, ranked for the most expected points (confidence.ts). */
export default async function ConfidencePage() {
  const data = getData();
  const postgres = data.backend === "postgres";
  const [games, models, stored, results, scoreModels] = await Promise.all([
    data.games(),
    data.marginModels(),
    postgres ? allBookLines() : Promise.resolve(new Map()),
    data.results().catch(() => []),
    data.scoreModels().catch(() => ({}) as Awaited<ReturnType<typeof data.scoreModels>>),
  ]);
  const now = new Date();
  const { start, end } = weekWindow(now);
  const finals = new Map(results.map((r) => [r.event_id, r]));

  const week: ConfidenceGame[] = [];
  for (const game of games) {
    const t = Date.parse(game.commenceTime);
    if (game.league !== "nfl" || !(t >= start && t < end)) continue;
    const priced = gameChance(game, quotesForGame(game, stored.get(game.eventId) ?? [], "DraftKings", now), models.nfl ?? null);
    if (priced) week.push(priced);
  }

  if (week.length === 0) {
    return (
      <>
        <PageHeader title="Confidence" subtitle="Every game straight up, surest pick worth the most" />
        <Empty title="No priced NFL games this week" detail="This fills in once the collector has lines for the week's games." />
        <NotAdvice className="mt-6" />
      </>
    );
  }

  const { picks, expected, possible, sd } = rankConfidence(week);
  // Tiebreaker: the week's last game, Monday night.
  const monday = [...week].sort((a, b) => b.commenceTime.localeCompare(a.commenceTime))[0];
  const mondayGame = games.find((g) => g.eventId === monday?.eventId);
  const tiebreak = mondayGame
    ? tiebreakerTotal(quotesForGame(mondayGame, stored.get(mondayGame.eventId) ?? [], "DraftKings", now), scoreModels.nfl ?? null)
    : null;
  // Weekly winner: the owner plus the pool's eleven (its sheets). See `bestWeeklyEntry`
  // and `POOL_HABITS` for how rivals are modelled.
  const weekly = bestWeeklyEntry(picks, { rivals: 11, now: now.getTime() });
  const leverage = weekly.win > weekly.plain + 0.015 ? weekly : null;
  const dogs = weekly.picks.filter((p) => p.underdog);
  const moved = weekly.picks.filter((p) => !p.underdog && p.entryPoints !== p.points);
  // Plan B, an experiment for the practice season: the underdog in the two lowest-point
  // games, slots unchanged. Backtested on weeks 1, 2, 4 and 5 it scored within 3 points of
  // playing as ranked (369 vs 367) -- tracked against the sheet each week to see whether
  // it earns anything, not because it is known to.
  const planB = picks.slice(-2);
  const planBCost = planB.reduce((sum, p) => sum + p.flipCost, 0);
  const started = picks.filter((p) => Date.parse(p.game.commenceTime) <= now.getTime()).length;

  return (
    <>
      <PageHeader title="Confidence" subtitle="Every game straight up, surest pick worth the most" />

      <Card className="mb-3 px-3.5 py-3">
        <p className="text-[13px] text-slate-300">
          Expected <span className="tabular font-medium text-slate-100">{expected.toFixed(1)}</span> of{" "}
          <span className="tabular">{possible}</span> points
          <span className="text-slate-500">
            {" "}
            · usually {Math.max(0, expected - sd).toFixed(0)}–{Math.min(possible, expected + sd).toFixed(0)}
          </span>
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          Each game&rsquo;s likelier winner, ranked by how likely: {TOP_POINTS} points on the surest
          pick, one fewer on each after. No other order scores more on average. Chances are the
          books&rsquo; moneylines with their cut taken out (the spread model where none is posted).
          {" "}&ldquo;Dog &minus;X pts&rdquo; is what taking the underdog there costs on average; under
          1 point (amber) is a cheap way to differ from a pool that all takes the favourite.
          {started > 0 ? ` ${started} game${started === 1 ? " has" : "s have"} already kicked off; if your picks are in, those points are set.` : ""}
          {week.length < 16 ? ` ${week.length} games priced this week.` : ""}
        </p>
      </Card>

      {monday && tiebreak ? (
        <Card className="mb-3 px-3.5 py-3">
          <p className="text-[13px] text-slate-300">
            Tiebreaker, {monday.away} @ {monday.home}:{" "}
            <span className="tabular text-[15px] font-semibold text-slate-50">{tiebreak.guess}</span> total points
          </p>
          <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
            Line {tiebreak.line}, fair {tiebreak.fair.toFixed(1)} once the juice is read ({tiebreak.books}{" "}
            {tiebreak.books === 1 ? "book" : "books"}), plus the ~0.6 NFL finals land above the closing total.
          </p>
        </Card>
      ) : null}

      <Card className="mb-3 border-amber-700/40 px-3.5 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Weekly winner &middot; 12 players
        </h2>
        <p className="mt-1 text-[13px] text-slate-300">
          As ranked: wins the week{" "}
          <span className="tabular font-medium text-slate-100">{percent(weekly.plain)}</span> of the time.{" "}
          <span className="font-medium text-emerald-300">In the season race, play it as ranked.</span>
        </p>
        <p className="mt-1.5 text-[13px] text-slate-300">
          <span className="font-medium text-amber-300">Only this week&rsquo;s pot:</span>{" "}
          {leverage ? (
            <>
              {dogs.map((p, i) => (
                <span key={p.game.eventId}>
                  {i > 0 ? ", " : ""}take <span className="font-medium text-amber-300">{p.entryTeam}</span> over{" "}
                  {p.team} at {p.entryPoints}
                </span>
              ))}
              {moved.length > 0 ? `; ${moved.map((p) => `${p.team} to ${p.entryPoints}`).join(", ")}` : ""}
              {" "}&mdash; wins{" "}
              <span className="tabular font-medium text-amber-300">{percent(leverage.win)}</span>
            </>
          ) : (
            "nothing beats the ranking this week; play it as ranked"
          )}
          .
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          {leverage
            ? `A long shot on purpose: it costs ${leverage.cost.toFixed(1)} expected points and usually finishes near the bottom, but when it hits you are clear of a field that all scored the same favourites. `
            : ""}
          Searched over every underdog and slot swap against simulated weeks of this pool (its
          sheets: favourites near-unanimous, 76% on the favourite in close games), then checked
          on fresh simulated weeks. On weeks 1, 2, 4 and 5 the leverage entry lost all four &mdash;
          a 1-in-4 shot misses four straight about a third of the time, so that neither proves
          nor disproves it. For the season prize it is the wrong play: weekly wins up, season
          chance down, worth less over a year.
        </p>
      </Card>

      <Card className="mb-3 border-violet-700/40 px-3.5 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Plan B · experiment</h2>
        <p className="mt-1 text-[13px] text-slate-300">
          Same ranking, but take{" "}
          {planB.map((p, i) => (
            <span key={p.game.eventId}>
              {i > 0 ? " and " : ""}
              <span className="font-medium text-violet-300">{p.opponent}</span> ({p.points})
            </span>
          ))}
          .
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          Costs {planBCost.toFixed(1)} expected points. Over weeks 1, 2, 4 and 5 it scored 369 to
          the plain ranking&rsquo;s 367 &mdash; a tie, in other words. Run alongside the plain
          ranking this season to see whether it earns anything.
        </p>
      </Card>

      <div className="space-y-1.5">
        {picks.map((p) => {
          const kicked = Date.parse(p.game.commenceTime) <= now.getTime();
          const final = finals.get(p.game.eventId);
          const winner = final
            ? final.home_score > final.away_score ? p.game.home : final.away_score > final.home_score ? p.game.away : null
            : null;
          const verdict = final ? (winner === p.team ? "won" : "lost") : null;
          return (
            <Card key={p.game.eventId} className="flex items-center gap-3 px-3.5 py-2.5">
              <span
                className={`tabular w-9 shrink-0 rounded-md py-1 text-center text-[15px] font-semibold ${
                  verdict === "won" ? "bg-emerald-500/15 text-emerald-300" : verdict === "lost" ? "bg-rose-500/15 text-rose-300" : "bg-sky-500/10 text-sky-200"
                }`}
              >
                {p.points}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] text-slate-100">{p.team}</p>
                <p className="truncate text-[11px] text-slate-500">
                  {p.team === p.game.home ? "vs" : "@"} {p.opponent} · {kicked ? (verdict ?? "under way") : formatKickoff(p.game.commenceTime)}
                </p>
              </div>
              <div className="text-right">
                <p className="tabular text-[14px] text-slate-200">{percent(p.chance)}</p>
                <p className={`text-[10px] ${p.flipCost < 1 ? "text-amber-300/80" : "text-slate-600"}`}>
                  {kicked ? (p.game.source === "market" ? `${p.game.books} books` : "model") : `dog −${p.flipCost.toFixed(1)} pts`}
                </p>
              </div>
            </Card>
          );
        })}
      </div>

      <NotAdvice className="mt-6" />
    </>
  );
}
