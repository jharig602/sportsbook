import Link from "next/link";

import { betHref } from "@/lib/bet-link";
import type { DailyBetView } from "@/lib/daily-bet-plan";
import { formatKickoff } from "@/lib/format";

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

const pct = (p: number) => `${(p * 100).toFixed(0)}%`;

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
            const cell = `${row.league.toUpperCase()} ${row.market}`;
            return (
              <>
                <p className="flex items-baseline gap-2 text-[15px] font-medium text-slate-100">
                  <span className="min-w-0 truncate">
                    {who}
                    {number}
                  </span>
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
          {view.skippedOpen > 0 && view.considered !== view.skippedOpen
            ? ` (${view.skippedOpen} price${view.skippedOpen === 1 ? "" : "s"} skipped on games you already hold.)`
            : ""}
        </p>
      )}

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
