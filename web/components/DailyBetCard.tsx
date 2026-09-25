import Link from "next/link";

import { LogParlay } from "./LogParlay";
import { betHref } from "@/lib/bet-link";
import type { BoardEdge } from "@/lib/board-shop";
import type { DailyBetView } from "@/lib/daily-bet-plan";
import { formatKickoff } from "@/lib/format";

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

const pct = (p: number) => `${(p * 100).toFixed(0)}%`;

/** "Detroit Lions -3", "Bills ML", "Over 45.5". */
function betLabel(row: BoardEdge): string {
  const who =
    row.side === "home"
      ? row.homeTeam
      : row.side === "away"
        ? row.awayTeam
        : row.side === "over"
          ? "Over"
          : "Under";
  const number =
    row.market === "moneyline" || row.line === null
      ? " ML"
      : ` ${row.market === "spread" && row.line > 0 ? "+" : ""}${row.line}`;
  return `${who}${number}`;
}

/**
 * The one bet worth making today, or a plain statement that there is none.
 *
 * "None" is shown rather than hidden because it is the most common and most useful
 * answer: a card that only appears on good days teaches you nothing on the others, and
 * a card that always recommends something is lying most days.
 */
export function DailyBetCard({ view }: { view: DailyBetView }) {
  const candidate = view.pick;

  return (
    <section className="mb-3 overflow-hidden rounded-xl border border-edge bg-surface">
      <header className="flex items-baseline justify-between border-b border-edge/70 px-3.5 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          Bet of the day
        </h2>
        <span className="text-[11px] text-slate-500">
          {view.qualifying > 0
            ? `${view.qualifying} bet${view.qualifying === 1 ? "" : "s"} clear the edge`
            : "none clear the edge"}
        </span>
      </header>

      {candidate ? (
        <div className="px-3.5 py-2.5">
          {(() => {
            const { row, p, edgePoints, roi, adjustment } = candidate;
            const cell = `${row.league.toUpperCase()} ${row.market}`;
            return (
              <>
                <p className="flex items-baseline gap-2 text-[15px] font-medium text-slate-100">
                  <span className="min-w-0 truncate">{betLabel(row)}</span>
                  <span className="tabular shrink-0 text-slate-400">
                    {signed(row.price ?? 0)} at {row.book}
                  </span>
                </p>
                <p className="mt-0.5 truncate text-[11px] text-slate-500">
                  {row.awayTeam} @ {row.homeTeam} &middot; {formatKickoff(row.commenceTime)}
                </p>

                <p className="tabular mt-1.5 text-[12px] text-slate-300">
                  Wins about <span className="font-semibold text-slate-100">{pct(p)}</span> of the
                  time &middot;{" "}
                  <span className="text-emerald-300">
                    +{(roi * 100).toFixed(1)}% expected
                  </span>{" "}
                  &middot; {edgePoints.toFixed(1)} pts over break-even
                </p>

                <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
                  {adjustment.n === 0
                    ? `No graded ${cell} picks yet, so nothing has been learned for this kind of bet.`
                    : `Learned from ${adjustment.n} graded ${cell} picks: predicted ${pct(
                        adjustment.expected / adjustment.n,
                      )}, won ${pct(adjustment.hits / adjustment.n)}, so this estimate moved ${
                        adjustment.shift >= 0 ? "+" : ""
                      }${(adjustment.shift * 100).toFixed(1)} pts.`}
                  {view.skippedOpen > 0
                    ? ` Skipped ${view.skippedOpen} price${view.skippedOpen === 1 ? "" : "s"} on games you already have money on.`
                    : ""}
                  {view.skippedFavourite > 0
                    ? ` Skipped ${view.skippedFavourite} against your team${
                        view.skippedFavourite === 1 ? "" : "s"
                      }.`
                    : ""}
                </p>

                <Link
                  href={betHref({
                    eventId: row.eventId,
                    market: row.market,
                    side: row.side,
                    line: row.line,
                    price: row.price,
                    book: row.book,
                  })}
                  className="mt-2 inline-block rounded-md bg-sky-500/10 px-2.5 py-1 text-[11px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/25"
                >
                  Log this bet
                </Link>
              </>
            );
          })()}
        </div>
      ) : (
        <p className="px-3.5 py-2.5 text-[13px] leading-relaxed text-slate-400">
          {view.reason}
          {view.skippedOpen > 0 && view.considered !== view.skippedOpen + view.skippedFavourite
            ? ` (${view.skippedOpen} price${view.skippedOpen === 1 ? "" : "s"} skipped on games you already hold.)`
            : ""}
          {/* Said out loud, like every filter here. A bet the app declined to mention
              without saying so is indistinguishable from one it never saw. */}
          {view.skippedFavourite > 0 &&
          view.considered !== view.skippedOpen + view.skippedFavourite
            ? ` (${view.skippedFavourite} skipped against your team${
                view.skippedFavourite === 1 ? "" : "s"
              }.)`
            : ""}
        </p>
      )}

      {candidate ? (
        <div className="border-t border-edge/70 px-3.5 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">Parlay of the day</p>
          {view.parlay ? (
            <>
              <ul className="mt-1 space-y-0.5">
                {view.parlay.legs.map((leg) => (
                  <li key={leg.row.eventId} className="flex items-baseline gap-2 text-[13px] text-slate-200">
                    <span className="min-w-0 truncate">{betLabel(leg.row)}</span>
                    <span className="tabular shrink-0 text-slate-500">
                      {signed(leg.row.price ?? 0)} &middot; {pct(leg.p)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="tabular mt-1 text-[12px] text-slate-300">
                <span className="font-semibold text-slate-100">
                  {signed(view.parlay.price)}
                </span>{" "}
                at {view.parlay.book} &middot; wins about{" "}
                <span className="font-semibold text-slate-100">{pct(view.parlay.p)}</span>{" "}
                &middot;{" "}
                <span className="text-emerald-300">
                  +{(view.parlay.roi * 100).toFixed(1)}% expected
                </span>
              </p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-slate-600">
                Different games, one book, and not the single above &mdash; take both and no
                game carries two of your tickets. Priced rounded down as books pay; enter
                the combined price your slip shows.
              </p>
              <LogParlay
                book={view.parlay.book}
                suggestedPrice={view.parlay.price}
                legs={view.parlay.legs.map((leg) => ({
                  eventId: leg.row.eventId,
                  league: leg.row.league,
                  homeTeam: leg.row.homeTeam,
                  awayTeam: leg.row.awayTeam,
                  commenceTime: leg.row.commenceTime,
                  market: leg.row.market,
                  side: leg.row.side,
                  line: leg.row.line,
                  price: leg.row.price,
                }))}
              />
            </>
          ) : (
            <p className="mt-0.5 text-[12px] leading-relaxed text-slate-400">
              None today: it needs two more games at one book that each clear the edge on
              their own, apart from the single above.
            </p>
          )}
        </div>
      ) : null}

      {/*
        The same-game ticket, which is a different KIND of suggestion from the two above
        and is labelled so. Those carry an expected return because both sides of the
        comparison are known. This carries a price to check, because no feed here holds a
        book's same-game price -- it has to be read off the slip. Showing a percentage
        next to it would be inventing the half of the sum that is missing.
      */}
      {candidate && !view.sameGame ? (
        <div className="border-t border-edge/70 px-3.5 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            Same-game parlay of the day
          </p>
          <p className="mt-0.5 text-[12px] leading-relaxed text-slate-400">
            None today: it needs two legs on one game that each clear the edge on their
            own, and that are not the same bet twice &mdash; a moneyline already contains
            every spread its side would cover.
          </p>
        </div>
      ) : null}

      {view.sameGame ? (
        <div className="border-t border-edge/70 px-3.5 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            Same-game parlay of the day &middot; at {view.sameGame.game.book}
          </p>
          <ul className="mt-1 space-y-0.5">
            {view.sameGame.legs.map((leg) => (
              <li
                key={`${leg.market}-${leg.side}-${leg.line}`}
                className="flex items-baseline gap-2 text-[13px] text-slate-200"
              >
                <span className="min-w-0 truncate">{leg.label}</span>
                <span className="tabular shrink-0 text-slate-500">{signed(leg.price)}</span>
              </li>
            ))}
          </ul>
          <p className="tabular mt-1 text-[12px] text-slate-300">
            Fair at{" "}
            <span className="font-semibold text-slate-100">
              {signed(view.sameGame.quote.fairAmerican ?? 0)}
            </span>{" "}
            &middot; lands {pct(view.sameGame.quote.win)} &middot; a bonus bet converts at{" "}
            {pct(view.sameGame.bonusConversion ?? 0)}
          </p>
          <p className="mt-0.5 text-[10px] leading-relaxed text-slate-600">
            {view.sameGame.game.awayTeam} @ {view.sameGame.game.homeTeam}, every leg at{" "}
            {view.sameGame.game.book} &mdash; a same-game parlay is placed in one app. From
            separate games these legs would pay {signed(view.sameGame.independentAmerican)}; the book
            will offer less for one scoreline, and anything better than{" "}
            {signed(view.sameGame.quote.fairAmerican ?? 0)} is worth taking. Good for a
            bonus bet, where only the profit ever comes back.
          </p>
        </div>
      ) : null}

      <p className="border-t border-edge/70 px-3.5 py-2 text-[10px] leading-relaxed text-slate-600">
        The likeliest winner among bets that beat the house edge by at least 1.5 points,
        at {view.myBooks.length > 0 ? "your books" : "any book (choose yours below)"}, never on a
        game you already hold. Each estimate is corrected by how that kind of pick has
        actually done — {view.gradedTotal} graded so far — shrunk so a hot or cold streak
        cannot swing it. More accurate over time is the goal; more wins every week is not
        something any honest system can promise.
      </p>
    </section>
  );
}
