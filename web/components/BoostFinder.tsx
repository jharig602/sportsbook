import { Card } from "@/components/ui";
import { betHref } from "@/lib/bet-link";
import type { BoostPick } from "@/lib/boost-finder";
import { formatKickoff, formatPrice } from "@/lib/format";

const BOOSTS = [0.25, 0.3, 0.5, 1];

function money(value: number): string {
  return `${value >= 0 ? "+" : "-"}$${Math.abs(value).toFixed(2)}`;
}

/**
 * The boost finder: pick the book, the boost and the maximum stake, get the bets it is
 * worth most on. A plain GET form, so the choice lives in the URL and the page stays a
 * server render. Every row links to the ledger with the BOOSTED price filled in, because
 * logging the pre-boost price settles a winner at a fraction of what it paid.
 */
export function BoostFinder({
  books,
  book,
  boost,
  stake,
  checked,
  unchecked,
  gamesAtBook,
}: {
  books: string[];
  book: string;
  boost: number;
  stake: number;
  checked: BoostPick[];
  unchecked: number;
  gamesAtBook: number;
}) {
  const field = "mt-1 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100";
  const top = checked.filter((p) => p.boosted > 0).slice(0, 10);
  return (
    <Card className="mb-4 px-3.5 py-3">
      <h2 id="boost" className="scroll-mt-16 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        Boost finder
      </h2>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        Where a profit boost is worth the most right now: moneylines and game totals at one
        book, scored as one maximum-size bet with the boost on.
      </p>
      <form action="/promos#boost" method="get" className="mt-2 grid grid-cols-3 gap-2">
        <label className="block text-[10px] uppercase tracking-wide text-slate-500">
          Book
          <select name="book" defaultValue={book} className={field}>
            {books.map((b) => (
              <option key={b} value={b}>{b}</option>
            ))}
          </select>
        </label>
        <label className="block text-[10px] uppercase tracking-wide text-slate-500">
          Boost
          <select name="boost" defaultValue={String(boost)} className={field}>
            {BOOSTS.map((b) => (
              <option key={b} value={String(b)}>{Math.round(b * 100)}%</option>
            ))}
          </select>
        </label>
        <label className="block text-[10px] uppercase tracking-wide text-slate-500">
          Max stake
          <input name="stake" defaultValue={String(stake)} inputMode="decimal" className={`tabular ${field}`} />
        </label>
        <button
          type="submit"
          className="col-span-3 rounded border border-sky-700/60 bg-sky-500/10 py-1.5 text-[12px] text-sky-200"
        >
          Find the best bets for this boost
        </button>
      </form>

      {top.length === 0 ? (
        <p className="mt-3 text-[12px] text-slate-400">
          Nothing at {book} is worth a {Math.round(boost * 100)}% boost right now
          {gamesAtBook === 0 ? " — the app has no upcoming prices from this book" : ""}.
        </p>
      ) : (
        <ol className="mt-3 space-y-2">
          {top.map((p) => (
            <li key={`${p.eventId}${p.label}`} className="rounded-lg border border-edge/70 px-2.5 py-2">
              <div className="flex items-baseline justify-between gap-2">
                <p className="truncate text-[13px] font-medium text-slate-100">
                  {p.label}{" "}
                  <span className="tabular text-slate-400">{formatPrice(p.price)}</span>
                  <span className="tabular text-slate-500"> → {formatPrice(p.logPrice)}</span>
                </p>
                <p className="tabular shrink-0 text-[13px] font-semibold text-emerald-300">{money(p.boosted)}</p>
              </div>
              <p className="truncate text-[11px] text-slate-500">
                {p.game} · {p.league.toUpperCase()} · {formatKickoff(p.commenceTime)}
              </p>
              <p className="mt-0.5 text-[11px] leading-snug text-slate-500">
                Wins {(p.win * 100).toFixed(1)}%{p.push > 0.001 ? `, pushes ${(p.push * 100).toFixed(1)}%` : ""} ·
                without the boost {money(p.plain)} · {p.basis}.{" "}
                <a
                  className="text-sky-400 underline underline-offset-2"
                  href={betHref({
                    eventId: p.eventId,
                    market: p.market,
                    side: p.side,
                    line: p.line,
                    price: p.logPrice,
                    book,
                    stake,
                  })}
                >
                  Log it
                </a>
              </p>
            </li>
          ))}
        </ol>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-slate-600">
        Worth = the fair chance of winning times the boosted profit, less the stake times the
        chance of losing; a whole-number total that lands exactly returns the stake. Totals
        lean over because finals land a little above the closing total, so at the same number
        the over is worth more &mdash; but a better line on the under beats that. Arrows show
        the price to log. Only sides checked against two or more other books are ranked
        {unchecked > 0 ? `; ${unchecked} more could not be checked and are left out` : ""}.
        Never against a team in My teams.
      </p>
    </Card>
  );
}
