"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";



/**
 * Which books you hold an account at.
 *
 * Stored server-side, not in the browser. The page could have used a cookie, but the
 * notification dispatcher runs from cron with no request behind it and cannot read
 * one -- and this is the setting that decides which prices are worth interrupting you
 * for. Keeping it in one place means the board you read and the alerts you get can
 * never disagree about which books are yours.
 */
export function MyBooksPicker({
  books,
  selected,
}: {
  books: string[];
  selected: string[];
}) {
  const router = useRouter();
  const [chosen, setChosen] = useState<string[]>(selected);
  const [open, setOpen] = useState(selected.length === 0);

  async function save(next: string[]) {
    // Optimistic: the chips respond immediately, and the refresh below reconciles with
    // whatever actually saved.
    setChosen(next);
    try {
      await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ books: next }),
      });
    } catch {
      // Leave the optimistic state; the refresh will show the truth.
    }
    router.refresh();
  }

  function toggle(book: string) {
    save(chosen.includes(book) ? chosen.filter((b) => b !== book) : [...chosen, book]);
  }

  return (
    <div className="mb-3 rounded-xl border border-edge bg-surface px-3 py-2.5">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-baseline justify-between text-left"
      >
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
          My books
        </span>
        <span className="text-[11px] text-slate-500">
          {chosen.length === 0 ? "none chosen" : chosen.join(", ")}
          <span className="ml-1.5 text-slate-600">{open ? "hide" : "edit"}</span>
        </span>
      </button>

      {open ? (
        <>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {books.map((book) => {
              const on = chosen.includes(book);
              return (
                <button
                  key={book}
                  type="button"
                  onClick={() => toggle(book)}
                  aria-pressed={on}
                  className={`rounded-lg px-2.5 py-1.5 text-[12px] font-medium transition-colors ${
                    on
                      ? "bg-sky-500/20 text-sky-300 ring-1 ring-inset ring-sky-500/40"
                      : "bg-raised text-slate-500"
                  }`}
                >
                  {book}
                </button>
              );
            })}
          </div>

          {chosen.length > 0 ? (
            <button
              type="button"
              onClick={() => save([])}
              className="mt-2 text-[11px] text-slate-500 underline underline-offset-2"
            >
              Clear
            </button>
          ) : null}

          <p className="mt-2 text-[11px] leading-relaxed text-slate-600">
            Only changes whose price you are shown. The consensus every price is measured
            against still uses every book, including ones you cannot reach &mdash; those
            opinions are what locate the fair number, and dropping them would make every
            gap look smaller than it is.
          </p>
        </>
      ) : null}
    </div>
  );
}
