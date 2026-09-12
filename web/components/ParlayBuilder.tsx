"use client";

import { useMemo, useState } from "react";

import type { BoardEdge } from "@/lib/board-shop";
import { bookLink } from "@/lib/book-links";
import { formatLine, formatPrice } from "@/lib/format";
import { buildParlay, oneInHowMany, typicalParlayRoi } from "@/lib/parlay";

/**
 * Build a parlay and watch what it does to the number.
 *
 * This exists because the compounding cuts both ways and almost nobody is shown the
 * bad direction. Adding a leg the board hates visibly drags the whole ticket down;
 * adding one it likes lifts it. That is the feature. A builder that only showed the
 * payout — which is what every sportsbook ships — is a device for making a small
 * negative into a large one while the number on screen gets more exciting.
 */
function keyOf(row: BoardEdge): string {
  return `${row.eventId}-${row.book}-${row.market}-${row.side}`;
}

function legLabel(row: BoardEdge): string {
  if (row.market === "total") {
    return `${row.awayTeam} @ ${row.homeTeam} ${formatLine("total", row.side, row.line)}`;
  }
  const team = row.side === "home" ? row.homeTeam : row.awayTeam;
  return row.market === "moneyline"
    ? `${team} ML`
    : `${team} ${formatLine("spread", row.side, row.line)}`;
}

export function ParlayBuilder({ rows }: { rows: BoardEdge[] }) {
  const [picked, setPicked] = useState<string[]>([]);
  const [open, setOpen] = useState(false);

  const byKey = useMemo(() => new Map(rows.map((r) => [keyOf(r), r])), [rows]);
  const legs = picked.map((k) => byKey.get(k)).filter((r): r is BoardEdge => Boolean(r));
  const parlay = buildParlay(legs);
  const typical = typicalParlayRoi(legs.length);

  function toggle(key: string) {
    setPicked((current) =>
      current.includes(key) ? current.filter((k) => k !== key) : [...current, key],
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mb-3 w-full rounded-xl border border-edge bg-surface py-2.5 text-[13px] font-medium text-slate-300"
      >
        Build a parlay
      </button>
    );
  }

  const good = parlay.priceable && parlay.expectedRoi > 0;
  const href = legs.length > 0 ? bookLink(legs[0].book) : null;
  const books = [...new Set(legs.map((l) => l.book))];

  return (
    <section className="mb-3 overflow-hidden rounded-xl border border-edge bg-surface">
      <header className="flex items-baseline justify-between border-b border-edge/70 px-3.5 py-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-300">
          Parlay &mdash; {legs.length} leg{legs.length === 1 ? "" : "s"}
        </h2>
        <button
          type="button"
          onClick={() => {
            setPicked([]);
            setOpen(false);
          }}
          className="text-[11px] text-slate-500"
        >
          close
        </button>
      </header>

      {legs.length > 0 ? (
        <div className="border-b border-edge/70 px-3.5 py-2.5">
          <div className="tabular grid grid-cols-3 gap-2 text-center">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">pays</p>
              <p className="text-[15px] font-semibold text-slate-100">
                {formatPrice(parlay.americanPrice)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">hits</p>
              <p className="text-[15px] font-semibold text-slate-100">
                1 in {oneInHowMany(parlay.winProbability).toFixed(1)}
              </p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-500">return</p>
              <p
                className={`text-[15px] font-semibold ${good ? "text-emerald-300" : "text-rose-300"}`}
              >
                {parlay.expectedRoi > 0 ? "+" : ""}
                {(parlay.expectedRoi * 100).toFixed(1)}%
              </p>
            </div>
          </div>

          <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
            A {legs.length}-leg parlay of ordinary prices returns{" "}
            <span className="tabular text-slate-400">{(typical * 100).toFixed(1)}%</span>.
            {good
              ? " This one is positive only because every leg was, and the compounding works both ways."
              : " Expected value compounds, so the vig is charged once per leg."}
          </p>

          {parlay.correlatedGames.length > 0 ? (
            <p className="mt-2 rounded-lg bg-rose-500/10 px-2 py-1.5 text-[11px] leading-relaxed text-rose-300">
              Two legs from the same game. These outcomes move together, so multiplying
              the prices is wrong &mdash; and your book will price it with its own
              same-game adjustment, not this number. Treat the figure above as void.
            </p>
          ) : null}

          {books.length > 1 ? (
            <p className="mt-2 text-[11px] text-amber-400/90">
              Legs sit at {books.length} different books ({books.join(", ")}) &mdash; this
              cannot be placed as one ticket.
            </p>
          ) : null}

          {href && books.length === 1 && parlay.correlatedGames.length === 0 ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="mt-2 block rounded-lg bg-raised/60 py-1.5 text-center text-[12px] font-medium text-sky-300"
            >
              Open {books[0]} &rarr;
            </a>
          ) : null}
        </div>
      ) : (
        <p className="border-b border-edge/70 px-3.5 py-2.5 text-[12px] text-slate-500">
          Pick legs below. Watch what each one does to the return &mdash; that is the
          part a sportsbook&rsquo;s builder does not show you.
        </p>
      )}

      <ul className="max-h-80 divide-y divide-edge/60 overflow-y-auto">
        {rows.slice(0, 30).map((row) => {
          const key = keyOf(row);
          const on = picked.includes(key);
          const roi = row.expectedRoi ?? 0;
          return (
            <li key={key}>
              <button
                type="button"
                onClick={() => toggle(key)}
                className={`flex w-full items-center gap-2.5 px-3.5 py-2 text-left ${
                  on ? "bg-sky-500/[0.07]" : ""
                }`}
              >
                <span
                  aria-hidden="true"
                  className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border text-[10px] ${
                    on
                      ? "border-sky-500 bg-sky-500/20 text-sky-300"
                      : "border-edge text-transparent"
                  }`}
                >
                  &#10003;
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] text-slate-200">
                    {legLabel(row)}
                  </span>
                  <span className="tabular block truncate text-[10px] text-slate-600">
                    {row.book} &middot; {formatPrice(row.price)} &middot;{" "}
                    {row.awayTeam} @ {row.homeTeam}
                  </span>
                </span>
                <span
                  className={`tabular shrink-0 text-[12px] font-medium ${
                    roi > 0 ? "text-emerald-400" : "text-slate-600"
                  }`}
                >
                  {roi > 0 ? "+" : ""}
                  {(roi * 100).toFixed(1)}%
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
