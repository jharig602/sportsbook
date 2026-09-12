import { bookLink } from "@/lib/book-links";
import { formatKickoff, formatLine, formatPrice } from "@/lib/format";
import type { BackingPlan } from "@/lib/backing";
import { spreadOfOptions } from "@/lib/backing";

/**
 * Every way to back your team this week, cheapest first.
 *
 * The honest framing matters more than the numbers here. This is not advice to bet —
 * the bet is already decided — so the card never says "good" or "bad". It says which of
 * the available ways costs least, and it says plainly when they all cost something,
 * which is most weeks.
 */
export function BackingCard({ plan }: { plan: BackingPlan }) {
  if (plan.options.length === 0) {
    return (
      <section className="mb-3 rounded-xl border border-edge bg-surface px-3.5 py-2.5">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          {plan.team}
        </p>
        <p className="mt-1 text-[12px] text-slate-500">
          Not on the board this week, or not priced by a second book yet.
        </p>
      </section>
    );
  }

  const best = plan.best!;
  const gap = spreadOfOptions(plan);
  const href = bookLink(best.row.book);
  const label = (o: typeof best) =>
    o.row.market === "moneyline"
      ? "moneyline"
      : `spread ${formatLine("spread", o.row.side, o.row.line)}`;

  return (
    <section className="mb-3 overflow-hidden rounded-xl border border-edge bg-surface">
      <header className="flex items-baseline justify-between border-b border-edge/70 px-3.5 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          Backing {plan.team}
        </h2>
        <span className="tabular text-[11px] text-slate-500">
          {formatKickoff(best.row.commenceTime)}
        </span>
      </header>

      <ul className="divide-y divide-edge/60">
        {plan.options.slice(0, 6).map((o, i) => {
          const reachable = plan.atMyBooks.includes(o);
          return (
            <li
              key={`${o.row.book}-${o.row.market}-${o.row.side}`}
              className={`flex items-baseline justify-between px-3.5 py-2 ${
                o === best ? "bg-emerald-500/[0.05]" : ""
              }`}
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-slate-200">
                {label(o)}{" "}
                <span className="tabular text-slate-400">{formatPrice(o.row.price)}</span>
                <span className={`ml-1.5 text-[11px] ${reachable ? "text-slate-500" : "text-slate-600"}`}>
                  {o.row.book}
                  {reachable ? "" : " (no account)"}
                </span>
              </span>
              <span
                className={`tabular shrink-0 pl-2 text-[12px] font-medium ${
                  o.expectedRoi > 0 ? "text-emerald-400" : i === 0 ? "text-slate-300" : "text-slate-600"
                }`}
              >
                {o.expectedRoi > 0 ? "+" : ""}
                {(o.expectedRoi * 100).toFixed(1)}%
              </span>
            </li>
          );
        })}
      </ul>

      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="block border-t border-edge/70 bg-raised/60 py-2 text-center text-[12px] font-medium text-sky-300"
        >
          Open {best.row.book} &rarr;
        </a>
      ) : null}

      <p className="border-t border-edge/70 px-3.5 py-2 text-[10px] leading-relaxed text-slate-600">
        {plan.allNegative
          ? "Every way in loses money in expectation — this is which loses least, not whether to bet."
          : "One of these actually clears the vig, which is rare enough to be worth noticing."}
        {gap !== null ? (
          <>
            {" "}
            Choosing the top row over the bottom is worth{" "}
            <span className="tabular text-slate-500">{(gap * 100).toFixed(1)}</span> cents
            per dollar &mdash; on a bet you were placing anyway.
          </>
        ) : null}
      </p>
    </section>
  );
}
