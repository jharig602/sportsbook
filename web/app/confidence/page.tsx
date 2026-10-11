import { Card, Empty, NotAdvice, PageHeader } from "@/components/ui";
import { allBookLines, quotesForGame } from "@/lib/book-lines";
import { gameChance, rankConfidence, TOP_POINTS, weeklyWin, weekWindow, type ConfidenceGame } from "@/lib/confidence";
import { getData } from "@/lib/data";
import { formatKickoff } from "@/lib/format";

export const dynamic = "force-dynamic";

const percent = (v: number) => `${Math.round(v * 100)}%`;

/** This week's confidence picks, ranked for the most expected points (confidence.ts). */
export default async function ConfidencePage() {
  const data = getData();
  const postgres = data.backend === "postgres";
  const [games, models, stored, results] = await Promise.all([
    data.games(),
    data.marginModels(),
    postgres ? allBookLines() : Promise.resolve(new Map()),
    data.results().catch(() => []),
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
  // Weekly winner: the owner joining a pool that is eleven players today (its week-5
  // sheet), so eleven rivals. See
  // `weeklyWin` for what is assumed about rivals -- that sheet matched it: 70% took the
  // favourite in 55-63% games (model 68%), points followed the odds at r ~ 0.75 (0.77).
  const weekly = weeklyWin(picks, { rivals: 11, now: now.getTime() });
  const bestFlip = weekly.flips[0] && weekly.flips[0].win > weekly.plain + 0.015 ? weekly.flips[0] : null;
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

      <Card className="mb-3 border-amber-700/40 px-3.5 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Weekly winner · {weekly.players} players
        </h2>
        <p className="mt-1 text-[13px] text-slate-300">
          As ranked: wins the week{" "}
          <span className="tabular font-medium text-slate-100">{percent(weekly.plain)}</span> of the time
          {bestFlip ? (
            <>
              . Take <span className="font-medium text-amber-300">{bestFlip.pick.opponent}</span> instead of{" "}
              {bestFlip.pick.team} for {bestFlip.pick.points}: wins{" "}
              <span className="tabular font-medium text-amber-300">{percent(bestFlip.win)}</span>
            </>
          ) : (
            " -- no single underdog does better this week"
          )}
          .
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          When the favourites all win, everyone who picked them ties, so copying the field rarely
          wins a week outright. One underdog in a middle slot is big enough to jump the pack when
          it hits; a low slot barely moves you, the top slots cost too much. Fair share is{" "}
          {percent(1 / weekly.players)}. It costs {bestFlip ? bestFlip.pick.flipCost.toFixed(1) : "0"} expected
          points. Rivals are modelled on this pool&rsquo;s week-5 sheet: big favourites near-unanimous, 70% on the favourite in closer games, points loosely in order.
        </p>
        {weekly.flips.length > 1 ? (
          <p className="mt-1 text-[11px] text-slate-500">
            Next best:{" "}
            {weekly.flips.slice(1, 4).map((f, i) => (
              <span key={f.pick.game.eventId}>
                {i > 0 ? " · " : ""}
                {f.pick.opponent} ({f.pick.points}) {percent(f.win)}
              </span>
            ))}
          </p>
        ) : null}
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
