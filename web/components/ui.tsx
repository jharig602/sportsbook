import Link from "next/link";
import type { ReactNode } from "react";

export function PageHeader({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <header className="mb-4 mt-1">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-[22px] font-semibold tracking-tight text-slate-50">{title}</h1>
        {children}
      </div>
      {subtitle ? (
        <p className="mt-1 text-[13px] leading-relaxed text-slate-400">{subtitle}</p>
      ) : null}
    </header>
  );
}

export function Card({
  children,
  href,
  className = "",
}: {
  children: ReactNode;
  href?: string;
  className?: string;
}) {
  if (href) {
    return (
      <Link href={href} className={`card card-interactive block ${className}`}>
        {children}
      </Link>
    );
  }
  return <div className={`card ${className}`}>{children}</div>;
}

export function Pill({
  children,
  tone = "bg-raised text-slate-400",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${tone}`}
    >
      {children}
    </span>
  );
}

/** Segmented control. Reads as a native iOS control rather than a row of buttons. */
export function Segmented({
  options,
  active,
  hrefFor,
}: {
  options: Array<{ key: string; label: string }>;
  active: string;
  hrefFor: (key: string) => string;
}) {
  return (
    <div className="scroll-x -mx-3 mb-4 px-3">
      <div className="inline-flex w-max gap-1 rounded-xl bg-surface p-1">
        {options.map((option) => (
          <Link
            key={option.key}
            href={hrefFor(option.key)}
            className={`whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium transition-colors ${
              active === option.key
                ? "bg-raised text-slate-100 shadow-sm"
                : "text-slate-500"
            }`}
          >
            {option.label}
          </Link>
        ))}
      </div>
    </div>
  );
}

/**
 * Empty states carry real explanations. "No data" on a tracker that has been running
 * for a week is indistinguishable from a bug, so each one says what is missing and
 * when to expect it.
 */
export function Empty({ title, detail }: { title: string; detail: ReactNode }) {
  return (
    <div className="rounded-2xl border border-dashed border-edge bg-surface/50 px-5 py-12 text-center">
      <p className="text-[15px] font-medium text-slate-300">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-relaxed text-slate-500">
        {detail}
      </p>
    </div>
  );
}

export function Banner({
  tone,
  children,
}: {
  tone: "info" | "warn" | "error";
  children: ReactNode;
}) {
  const tones = {
    info: "border-sky-500/25 bg-sky-500/[0.07] text-sky-200/90",
    warn: "border-amber-500/25 bg-amber-500/[0.07] text-amber-200/90",
    error: "border-rose-500/25 bg-rose-500/[0.07] text-rose-200/90",
  };
  return (
    <p className={`mb-3 rounded-xl border px-3 py-2.5 text-[12px] leading-relaxed ${tones[tone]}`}>
      {children}
    </p>
  );
}

/**
 * Standing disclaimer. Move Strength ranks how unusual a move is; it says nothing about
 * whether a bet is good. This component exists so that claim is worded identically
 * everywhere and cannot quietly drift into sounding like a tip.
 */
export function NotAdvice({ className = "" }: { className?: string }) {
  return (
    <p className={`text-[11px] leading-relaxed text-slate-600 ${className}`}>
      Move Strength ranks how <em>unusual</em> a line move is — not how likely a bet is to
      win. Nothing here is a recommendation, and no expected value can be computed from a
      single sportsbook.{" "}
      <Link href="/about" className="text-slate-500 underline underline-offset-2">
        Why
      </Link>
    </p>
  );
}

/**
 * A compact row of headline numbers.
 *
 * Deliberately small. These are read once on arrival and then ignored, so they were
 * taking a card's worth of vertical space each to say three short things — pushing the
 * list you actually came for below the fold. One bordered strip instead of three cards,
 * and no number larger than the text it sits above.
 */
export function Stats({
  items,
}: {
  items: Array<{ value: string; label: string; tone?: "plain" | "good" | "bad" }>;
}) {
  return (
    <div className="mb-3 flex divide-x divide-edge/70 overflow-hidden rounded-xl border border-edge bg-surface">
      {items.map((item) => (
        <div key={item.label} className="flex-1 px-2 py-2 text-center">
          <p
            className={`tabular text-[15px] font-semibold leading-tight ${
              item.tone === "good"
                ? "text-emerald-300"
                : item.tone === "bad"
                  ? "text-rose-300"
                  : "text-slate-100"
            }`}
          >
            {item.value}
          </p>
          <p className="mt-0.5 truncate text-[9px] uppercase tracking-wide text-slate-500">
            {item.label}
          </p>
        </div>
      ))}
    </div>
  );
}

/**
 * Long-form explanation, folded away.
 *
 * The reasoning behind every number here is worth keeping and is not worth reading
 * daily. Collapsing it is the compromise: nothing is deleted, the page stops opening
 * with six paragraphs of prose, and anyone who wants to know why can still ask.
 *
 * A native <details> rather than state, so it costs no JavaScript and works in a server
 * component.
 */
export function Explainer({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <details className="mt-4 overflow-hidden rounded-xl border border-edge bg-surface">
      <summary className="cursor-pointer list-none px-3.5 py-2.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400 marker:hidden">
        {title}
        <span className="float-right font-normal normal-case tracking-normal text-slate-600">
          why
        </span>
      </summary>
      <div className="border-t border-edge/70 px-3.5 py-3">{children}</div>
    </details>
  );
}
