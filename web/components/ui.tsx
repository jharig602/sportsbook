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
    <header className="mb-4">
      <div className="flex items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold tracking-tight text-slate-100">{title}</h1>
        {children}
      </div>
      {subtitle ? (
        <p className="mt-1 text-sm leading-relaxed text-slate-400">{subtitle}</p>
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
  const shell = `rounded-xl border border-edge bg-panel ${className}`;
  if (href) {
    return (
      <Link href={href} className={`${shell} block transition-colors hover:border-slate-600`}>
        {children}
      </Link>
    );
  }
  return <div className={shell}>{children}</div>;
}

export function Pill({
  children,
  tone = "bg-slate-700/40 text-slate-300 ring-slate-600/40",
}: {
  children: ReactNode;
  tone?: string;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${tone}`}
    >
      {children}
    </span>
  );
}

/**
 * Empty states carry real explanations. "No data" on a tracker that has been running
 * for a week is indistinguishable from a bug, so each one says what is missing and
 * when to expect it.
 */
export function Empty({ title, detail }: { title: string; detail: ReactNode }) {
  return (
    <div className="rounded-xl border border-dashed border-edge bg-panel/40 px-4 py-10 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-slate-500">
        {detail}
      </p>
    </div>
  );
}

/**
 * Standing disclaimer. Move Strength ranks how unusual a move is; it says nothing about
 * whether a bet is good. This component exists so that claim is worded identically
 * everywhere and cannot quietly drift into sounding like a tip.
 */
export function NotAdvice({ className = "" }: { className?: string }) {
  return (
    <p className={`text-xs leading-relaxed text-slate-500 ${className}`}>
      Move Strength ranks how <em>unusual</em> a line move is — not how likely a bet is to
      win. Nothing here is a recommendation, and no expected value can be computed from a
      single sportsbook.{" "}
      <Link href="/about" className="text-slate-400 underline underline-offset-2">
        Why
      </Link>
    </p>
  );
}
