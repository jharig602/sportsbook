import Link from "next/link";

import { Card, Empty, NotAdvice, PageHeader } from "@/components/ui";
import { allBookLines, quotesForGame } from "@/lib/book-lines";
import { gameChance, rankConfidence, tiebreakerTotal, TOP_POINTS, weekWindow, weeklyPick, type ConfidenceGame, type ConfidencePick } from "@/lib/confidence";
import { getData } from "@/lib/data";
import { formatKickoff } from "@/lib/format";

export const dynamic = "force-dynamic";

const percent = (v: number) => `${Math.round(v * 100)}%`;

type Plan = "weekly" | "season" | "b";
const PLANS: Array<{ key: Plan; label: string }> = [
  { key: "weekly", label: "Weekly pot" },
  { key: "season", label: "Season" },
  { key: "b", label: "Plan B" },
];
/** One line of the card you would submit: which team, for how many points. */
type Row = { pick: ConfidencePick; team: string; opponent: string; points: number; chance: number; underdog: boolean };

/**
 * This week's confidence picks (confidence.ts), laid out as the card to submit under the
 * chosen plan: the weekly-pot rule by default (the owner plays the weekly pot), the plain
 * ranking for the season race, or the Plan B experiment.
 */
export default async function ConfidencePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const query = await searchParams;
  const raw = Array.isArray(query.plan) ? query.plan[0] : query.plan;
  const plan: Plan = raw === "season" || raw === "b" ? raw : "weekly";
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

  const { picks, expected, possible } = rankConfidence(week);
  // Tiebreaker: the week's last game, Monday night.
  const monday = [...week].sort((a, b) => b.commenceTime.localeCompare(a.commenceTime))[0];
  const mondayGame = games.find((g) => g.eventId === monday?.eventId);
  const tiebreak = mondayGame
    ? tiebreakerTotal(quotesForGame(mondayGame, stored.get(mondayGame.eventId) ?? [], "DraftKings", now), scoreModels.nfl ?? null)
    : null;
  // Weekly pot only: the backtested rule (`weeklyPick`).
  const weekly = weeklyPick(picks, now.getTime());
  // Plan B, an experiment for the practice season: the underdog in the two lowest-point
  // games, slots unchanged. Backtested on weeks 1, 2, 4 and 5 it scored within 3 points of
  // playing as ranked (369 vs 367) -- tracked against the sheet each week to see whether
  // it earns anything, not because it is known to.
  const planB = picks.slice(-2);
  const planBCost = planB.reduce((sum, p) => sum + p.flipCost, 0);
  const started = picks.filter((p) => Date.parse(p.game.commenceTime) <= now.getTime()).length;

  const asRanked = (p: ConfidencePick, underdog = false): Row => ({
    pick: p,
    team: underdog ? p.opponent : p.team,
    opponent: underdog ? p.team : p.opponent,
    points: p.points,
    chance: underdog ? 1 - p.chance : p.chance,
    underdog,
  });
  let rows: Row[];
  if (plan === "weekly" && weekly) {
    const placed = new Map(weekly.entry.map((e) => [e.pick.game.eventId, e]));
    rows = picks.map((p) => {
      const e = placed.get(p.game.eventId);
      return e ? { ...asRanked(p, e.underdog), points: e.points } : asRanked(p);
    });
  } else if (plan === "b") {
    const flipped = new Set(planB.map((p) => p.game.eventId));
    rows = picks.map((p) => asRanked(p, flipped.has(p.game.eventId)));
  } else {
    rows = picks.map((p) => asRanked(p));
  }
  rows.sort((a, b) => b.points - a.points);
  const planExpected = rows.reduce((sum, r) => sum + r.points * r.chance, 0);
  const planSd = Math.sqrt(rows.reduce((sum, r) => sum + r.points ** 2 * r.chance * (1 - r.chance), 0));

  return (
    <>
      <PageHeader title="Confidence" subtitle="Every game straight up, surest pick worth the most" />

      <nav className="mb-3 flex gap-1.5" aria-label="Plan">
        {PLANS.map((p) => (
          <Link
            key={p.key}
            href={p.key === "weekly" ? "/confidence" : `/confidence?plan=${p.key}`}
            aria-current={plan === p.key ? "page" : undefined}
            className={`flex-1 rounded-md border px-2 py-1.5 text-center text-[12px] ${
              plan === p.key ? "border-sky-600/60 bg-sky-500/15 text-sky-100" : "border-edge text-slate-400"
            }`}
          >
            {p.label}
          </Link>
        ))}
      </nav>

      <Card className="mb-3 px-3.5 py-3">
        <p className="text-[13px] text-slate-300">
          Expected <span className="tabular font-medium text-slate-100">{planExpected.toFixed(1)}</span> of{" "}
          <span className="tabular">{possible}</span> points
          <span className="text-slate-500">
            {" "}
            · usually {Math.max(0, planExpected - planSd).toFixed(0)}–{Math.min(possible, planExpected + planSd).toFixed(0)}
            {plan !== "season" ? ` · ${(expected - planExpected).toFixed(1)} under the plain ranking` : ""}
          </span>
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          Each game&rsquo;s likelier winner, ranked by how likely: {TOP_POINTS} points on the surest
          pick, one fewer on each after. No other order scores more on average. Chances are the
          books&rsquo; moneylines with their cut taken out (the spread model where none is posted).
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
          <span className="font-medium text-emerald-300">In the season race:</span> play it as ranked.
        </p>
        <p className="mt-0.5 text-[13px] text-slate-300">
          <span className="font-medium text-amber-300">Only this week&rsquo;s pot:</span>{" "}
          {weekly ? (
            <>
              take <span className="font-medium text-amber-300">{weekly.dog.team}</span> over {weekly.dog.pick.team} (
              {percent(1 - weekly.dog.pick.chance)}) on <span className="tabular font-medium">{weekly.dog.points}</span>, and
              move everything else down one.
            </>
          ) : (
            "every game has kicked off."
          )}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          Tested on 197 real NFL weeks (2015 to this season, closing odds and results) against
          eleven simulated players picking the way this pool does: as ranked won 4.8% of weeks,
          below a fair 8.3%; a ~35% underdog on the top slot won 12.7% &mdash; 13.6% in the
          seasons it was chosen on and 11.8% in the six it was not. It loses most weeks on
          purpose: when it hits, you are clear of a field that all scored the same favourites.
          {weekly ? ` Costs ${weekly.cost.toFixed(1)} expected points, which is why the season race plays it straight.` : ""}
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
        {rows.map((r) => {
          const p = r.pick;
          const kicked = Date.parse(p.game.commenceTime) <= now.getTime();
          const final = finals.get(p.game.eventId);
          const winner = final
            ? final.home_score > final.away_score ? p.game.home : final.away_score > final.home_score ? p.game.away : null
            : null;
          const verdict = final ? (winner === r.team ? "won" : "lost") : null;
          return (
            <Card key={p.game.eventId} className={`flex items-center gap-3 px-3.5 py-2.5 ${r.underdog ? "border-amber-600/50" : ""}`}>
              <span
                className={`tabular w-9 shrink-0 rounded-md py-1 text-center text-[15px] font-semibold ${
                  verdict === "won" ? "bg-emerald-500/15 text-emerald-300" : verdict === "lost" ? "bg-rose-500/15 text-rose-300" : r.underdog ? "bg-amber-500/15 text-amber-200" : "bg-sky-500/10 text-sky-200"
                }`}
              >
                {r.points}
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] text-slate-100">
                  {r.team}
                  {r.underdog ? <span className="ml-1.5 text-[10px] font-medium uppercase tracking-wide text-amber-300">underdog</span> : null}
                </p>
                <p className="truncate text-[11px] text-slate-500">
                  {r.team === p.game.home ? "vs" : "@"} {r.opponent} · {kicked ? (verdict ?? "under way") : formatKickoff(p.game.commenceTime)}
                </p>
              </div>
              <div className="text-right">
                <p className={`tabular text-[14px] ${r.underdog ? "text-amber-200" : "text-slate-200"}`}>{percent(r.chance)}</p>
                <p className="text-[10px] text-slate-600">{p.game.source === "market" ? `${p.game.books} books` : "model"}</p>
              </div>
            </Card>
          );
        })}
      </div>

      <NotAdvice className="mt-6" />
    </>
  );
}
