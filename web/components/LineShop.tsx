import Link from "next/link";

import { Card } from "./ui";
import { betHref } from "@/lib/bet-link";
import { formatLine, formatPrice } from "@/lib/format";
import type { ShopResult } from "@/lib/shop";
import type { Side } from "@/lib/types";

/**
 * Which book has the best of it, and whether that is enough to bet.
 *
 * The headline is expected return per dollar, not the size of the gap, because the gap
 * is charged for in dollars. Rows that match the consensus land at about -4.5%, which
 * is the hold and the correct answer for a board with no disagreement on it.
 */
function label(side: Side, homeTeam: string, awayTeam: string): string {
  if (side === "home") return homeTeam;
  if (side === "away") return awayTeam;
  return side;
}

export function LineShop({
  rows,
  homeTeam,
  awayTeam,
  eventId,
}: {
  rows: ShopResult[];
  homeTeam: string;
  awayTeam: string;
  /** When given, each row links to the bet form filled in with that book's number. */
  eventId?: string;
}) {
  const comparable = rows.filter((row) => row.booksCompared > 0 || row.stale);
  const positive = comparable.filter((row) => (row.expectedRoi ?? -1) > 0);
  const books = new Set(rows.map((row) => row.book)).size;

  if (comparable.length === 0) {
    return (
      <Card className="px-3.5 py-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Line shopping
        </h2>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          Only one book has priced this game, so there is nothing to compare it against.
          Add what your own book shows below and the gap gets priced immediately.
        </p>
      </Card>
    );
  }

  return (
    <Card className="px-3.5 py-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          Line shopping
        </h2>
        <span
          className={`text-[11px] font-medium ${
            positive.length > 0 ? "text-emerald-300" : "text-slate-500"
          }`}
        >
          {books} book{books === 1 ? "" : "s"} &middot; {positive.length} beat
          {positive.length === 1 ? "s" : ""} the vig
        </span>
      </div>

      <div className="mt-2.5 space-y-1.5">
        {comparable.slice(0, 12).map((row) => {
          const good = (row.expectedRoi ?? -1) > 0;
          return (
            <div
              key={`${row.book}-${row.market}-${row.side}`}
              className="flex items-center gap-2.5 rounded-lg bg-slate-800/30 px-2.5 py-2"
            >
              <span
                className={`tabular flex h-9 w-14 shrink-0 flex-col items-center justify-center rounded-md text-[13px] font-semibold ${
                  good ? "bg-emerald-500/12 text-emerald-300" : "bg-slate-700/40 text-slate-500"
                }`}
              >
                {row.stale
                  ? "old"
                  : row.expectedRoi === null
                    ? "—"
                    : `${row.expectedRoi > 0 ? "+" : ""}${(row.expectedRoi * 100).toFixed(1)}%`}
              </span>

              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] text-slate-200">
                  <span className="font-medium">{row.book}</span>{" "}
                  <span className="text-slate-400">
                    {label(row.side, homeTeam, awayTeam)} {row.market}
                  </span>
                </p>
                <p className="tabular mt-0.5 flex flex-wrap items-center gap-x-2 text-[10px] text-slate-500">
                  <span className="text-slate-300">
                    {row.line !== null ? formatLine(row.market, row.side, row.line) : ""}{" "}
                    {formatPrice(row.price)}
                  </span>
                  {row.consensusLine !== null ? (
                    <span>
                      others {formatLine(row.market, row.side, row.consensusLine)}
                    </span>
                  ) : null}
                  {row.advantagePoints !== null && row.advantagePoints !== 0 ? (
                    <span className={row.advantagePoints > 0 ? "text-emerald-400/80" : ""}>
                      {row.advantagePoints > 0 ? "+" : ""}
                      {row.advantagePoints.toFixed(1)} pts
                    </span>
                  ) : null}
                  {row.stale ? (
                    <span className="text-amber-400/80">stale &mdash; not counted</span>
                  ) : (
                    <span>vs {row.booksCompared}</span>
                  )}
                </p>
              </div>

              {eventId && row.price !== null ? (
                <Link
                  href={betHref({
                    eventId,
                    market: row.market,
                    side: row.side,
                    line: row.line,
                    price: row.price,
                    book: row.book,
                  })}
                  className="shrink-0 rounded-md bg-sky-500/10 px-2 py-1.5 text-[11px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/25"
                >
                  log
                </Link>
              ) : null}
            </div>
          );
        })}
      </div>

      <p className="mt-2.5 text-[11px] leading-relaxed text-slate-600">
        Each book is measured against the median of the <em>others</em>, never including
        itself. A point of line is worth about 3.2 points of win probability in the NFL
        and 2.6 in college, against the 2.4 that &minus;110 charges &mdash; so a
        one-point disagreement clears the vig and half a point does not.
      </p>

      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-600">
        A quote older than a day is shown but left out of every consensus. Books move,
        and a gap against a number nobody is offering any more is elapsed time, not an
        edge.
      </p>
    </Card>
  );
}
