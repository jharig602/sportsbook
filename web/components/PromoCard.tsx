import Link from "next/link";

import { bookLink } from "@/lib/book-links";
import { formatKickoff } from "@/lib/format";
import type { PromoToday } from "@/lib/promo-plan";

function signed(price: number): string {
  return price > 0 ? `+${price}` : String(price);
}

/**
 * Today's qualifying bet and the bonus it earns, on the page rather than only in a push.
 *
 * The framing here is the opposite of everything else in this app, and the wording has
 * to carry that. Elsewhere the question is "is there a bet worth making" and the answer
 * is usually no. Here the bet is compulsory — not placing it forfeits the bonus — so the
 * question is what the cheapest way to satisfy it is, and the honest answer is
 * frequently a negative number that you should still act on.
 */
export function PromoCard({ promo }: { promo: PromoToday }) {
  const { qualifier, bonus, progress, worth, book, stake, face } = promo;
  if (progress.complete) {
    return (
      <section className="mb-3 rounded-xl border border-emerald-800/40 bg-emerald-500/[0.04] px-3.5 py-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-emerald-300">
          {book} promo &mdash; all {progress.required} days done
        </p>
        <p className="mt-1 text-[12px] leading-relaxed text-slate-400">
          Every qualifying bet is logged. Nothing left to place.
        </p>
      </section>
    );
  }

  const pick = qualifier.pick;
  const team =
    pick === null
      ? null
      : pick.side === "home"
        ? pick.homeTeam
        : pick.side === "away"
          ? pick.awayTeam
          : pick.side;
  const line =
    pick === null || pick.line === null
      ? ""
      : ` ${pick.line > 0 ? "+" : ""}${pick.line}`;
  const href = bookLink(book);

  return (
    <section className="mb-3 overflow-hidden rounded-xl border border-edge bg-surface">
      <header className="flex items-baseline justify-between border-b border-edge/70 px-3.5 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          {book} promo
        </h2>
        <span className="tabular text-[11px] text-slate-500">
          day {progress.today} of {progress.required}
        </span>
      </header>

      <div className="divide-y divide-edge/60">
        <div className="px-3.5 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            place ${stake}
          </p>
          {pick && team ? (
            <>
              <p className="mt-0.5 flex items-baseline gap-2 text-[15px] font-medium text-slate-100">
                <span className="min-w-0 truncate">
                  {team}
                  {line}
                </span>
                <span className="tabular shrink-0 text-slate-400">
                  {signed(pick.price ?? 0)}
                </span>
              </p>
              <p className="tabular mt-0.5 text-[11px] text-slate-500">
                {formatKickoff(pick.commenceTime)}
                <span
                  className={`ml-2 ${qualifier.beatsVig ? "text-emerald-400" : "text-slate-600"}`}
                >
                  {qualifier.beatsVig ? "+" : ""}
                  {((pick.expectedRoi ?? 0) * 100).toFixed(1)}%
                </span>
              </p>
            </>
          ) : (
            <p className="mt-0.5 text-[13px] text-slate-400">
              Nothing priced at {book} yet.
            </p>
          )}
        </div>

        <div className="px-3.5 py-2.5">
          <p className="text-[10px] uppercase tracking-wide text-slate-500">
            then put the ${face} bonus on
          </p>
          {bonus ? (
            <>
              <p className="mt-0.5 flex items-baseline gap-2 text-[15px] font-medium text-slate-100">
                <span className="min-w-0 truncate">{bonus.candidate.team}</span>
                <span className="tabular shrink-0 text-slate-400">
                  {signed(bonus.price)}
                </span>
              </p>
              <p className="tabular mt-0.5 text-[11px] text-slate-500">
                {formatKickoff(bonus.candidate.commenceTime)}
                <span className="ml-2 text-emerald-400">
                  worth ~${bonus.value.toFixed(0)} of ${face}
                </span>
              </p>
            </>
          ) : (
            <p className="mt-0.5 text-[13px] text-slate-400">
              No long-odds moneyline priced yet.
            </p>
          )}
        </div>
      </div>

      {href ? (
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="block border-t border-edge/70 bg-raised/60 py-2.5 text-center text-[13px] font-medium text-sky-300"
        >
          Open {book} &rarr;
        </a>
      ) : null}

      <p className="border-t border-edge/70 px-3.5 py-2 text-[10px] leading-relaxed text-slate-600">
        The ${stake} is compulsory, so this is the cheapest way to satisfy it rather than
        a bet worth making &mdash; {qualifier.beatsVig ? "today it happens to clear the vig" : "today it still loses in expectation"}.
        The bonus is where the money is: each ${stake} earns its own ${face}, and the
        whole promotion is worth about ${worth.toFixed(0)}. Counted from bets you have
        logged, so a day you did not log is a day this cannot see.{" "}
        <Link href="/bets" className="underline underline-offset-2">
          Log a bet
        </Link>
      </p>
    </section>
  );
}
