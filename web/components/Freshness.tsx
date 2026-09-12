import type { Freshness as FreshnessData } from "@/lib/data";

/**
 * How current the numbers are.
 *
 * A countdown was the obvious thing to build and would have been wrong. The collector
 * runs from a GitHub cron that asks for five runs a day midweek and about forty-eight
 * at a weekend; measured over five days, GitHub delivered three to five, at arbitrary
 * minutes. A timer ticking down to the next scheduled minute would be confidently
 * wrong most of the time — the same failure as the "397 awaiting" that turned out to be
 * a query cap rather than a backlog.
 *
 * So: when it last ran, which is a fact, and how often it typically does, which is a
 * median over recent runs rather than a promise. If the gap since the last run has
 * grown well past that median, the loop is probably stuck, and THAT is the thing worth
 * knowing — a countdown would have hidden it behind a reassuring number.
 */
function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(hours < 10 ? 1 : 0)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function Freshness({ data }: { data: FreshnessData }) {
  if (!data.lastRun) {
    return (
      <p className="mt-4 text-[11px] text-slate-600">
        The collector has not recorded a run yet.
      </p>
    );
  }

  const now = Date.now();
  const sinceHours = (now - new Date(data.lastRun).getTime()) / 3600000;
  // Twice the usual gap is where "it is between runs" stops being the explanation.
  const stale = data.medianGapHours !== null && sinceHours > data.medianGapHours * 2;

  return (
    <p className={`mt-4 text-[11px] ${stale ? "text-amber-500/90" : "text-slate-600"}`}>
      Collector last ran{" "}
      <span className="tabular text-slate-500">{ago(data.lastRun, now)}</span>
      {data.medianGapHours !== null ? (
        <>
          {" "}
          &middot; typically every{" "}
          <span className="tabular text-slate-500">
            {data.medianGapHours < 1
              ? `${Math.round(data.medianGapHours * 60)}m`
              : `${data.medianGapHours.toFixed(1)}h`}
          </span>{" "}
          over the last {data.runsSeen} runs
        </>
      ) : null}
      {stale ? " — longer than usual, so the numbers above may be behind." : "."}
      {!stale ? (
        <>
          {" "}
          No countdown, because the schedule is not kept: GitHub delivers a handful of
          the requested runs a day, at times nobody controls.
        </>
      ) : null}
    </p>
  );
}
