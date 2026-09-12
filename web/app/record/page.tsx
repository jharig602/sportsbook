import { Card, Empty, PageHeader, Stats } from "@/components/ui";
import { buildTrackRecord, getData, MIN_SAMPLES } from "@/lib/data";
import { formatKind, formatPercent } from "@/lib/format";
import type { RecordRow } from "@/lib/types";

export const dynamic = "force-dynamic";

function RateCell({ value, sufficient }: { value: number | null; sufficient: boolean }) {
  if (value === null) {
    return (
      <span className="text-xs text-slate-600" title={`Needs ${MIN_SAMPLES} settled games`}>
        {sufficient ? "—" : "too few"}
      </span>
    );
  }
  return <span className="tabular text-sm text-slate-200">{formatPercent(value, 1)}</span>;
}

function RecordTable({ rows, caption }: { rows: RecordRow[]; caption: string }) {
  return (
    <Card className="overflow-hidden">
      <div className="border-b border-edge px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {caption}
        </h2>
      </div>
      <div className="scroll-x">
        <table className="w-full min-w-[30rem] text-left">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-2 font-medium">Slice</th>
              <th className="px-3 py-2 text-right font-medium">Fired</th>
              <th className="px-3 py-2 text-right font-medium">Settled</th>
              <th className="px-3 py-2 text-right font-medium">Push</th>
              <th className="px-3 py-2 text-right font-medium">Line value</th>
              <th className="px-3 py-2 text-right font-medium">Cover</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-edge">
                <td className="px-3 py-2 text-sm text-slate-200">
                  {formatKind(row.label)}
                </td>
                <td className="tabular px-3 py-2 text-right text-sm text-slate-400">
                  {row.fired}
                </td>
                <td className="tabular px-3 py-2 text-right text-sm text-slate-400">
                  {row.decided}
                </td>
                <td className="tabular px-3 py-2 text-right text-sm text-slate-500">
                  {row.pushes}
                </td>
                <td className="px-3 py-2 text-right">
                  <RateCell value={row.lineValueRate} sufficient={row.sufficient} />
                </td>
                <td className="px-3 py-2 text-right">
                  <RateCell value={row.coverRate} sufficient={row.sufficient} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export default async function RecordPage() {
  const data = getData();
  const [alerts, grades] = await Promise.all([data.alerts(), data.grades()]);
  const record = buildTrackRecord(alerts, grades);

  return (
    <>
      <PageHeader
        title="Track Record"
        subtitle="How the alerts have actually done. This page exists to tell you when they do not work."
      />

      <Stats
        items={[
          { value: String(record.totalAlerts), label: "alerts" },
          { value: String(record.totalGraded), label: "graded" },
          { value: String(record.awaitingResults), label: "awaiting" },
        ]}
      />

      {record.totalGraded === 0 ? (
        <Empty
          title="Nothing has been graded yet"
          detail={
            <>
              An alert can only be scored once its game has finished. Grades appear after
              the first slate settles, and no rate is published until a slice has at
              least {MIN_SAMPLES} decided games — a percentage from nine games looks
              exactly as authoritative as one from nine hundred, which is the problem.
            </>
          }
        />
      ) : (
        <div className="space-y-4">
          <RecordTable rows={record.byKind} caption="By alert kind" />
          <RecordTable rows={record.byStrength} caption="By Move Strength bucket" />

          <Card className="px-3 py-3">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
              Against the baseline
            </h2>
            <p className="mt-2 text-sm text-slate-300">
              Alerts:{" "}
              <span className="tabular">
                {formatPercent(record.baseline?.alerts ?? null, 1)}
              </span>{" "}
              <span className="text-slate-600">vs</span> coin flip:{" "}
              <span className="tabular">50.0%</span>
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              A rule that cannot beat a coin flip has demonstrated nothing, however
              plausible it looks. Spreads and totals are priced near 50/50 by design, so
              anything close to even here means the alerts are not finding an edge.
            </p>
          </Card>
        </div>
      )}

      <div className="mt-6 space-y-3 text-xs leading-relaxed text-slate-500">
        <p>
          <span className="font-medium text-slate-400">Line value</span> asks whether
          DraftKings&rsquo; own line kept moving the way the alert predicted. It is
          measurable with one book and settles faster than results. It is deliberately not
          called CLV — closing-line value compares against a sharp consensus, which is not
          available here.
        </p>
        <p>
          <span className="font-medium text-slate-400">Cover</span> asks whether the
          predicted side actually won against the number available when the alert fired.
          It is what you would have been paid on, and it is very high variance.
        </p>
        <p>
          Pushes are excluded from every rate rather than counted as losses. Rates are
          computed walk-forward, so a slice is never scored on the games used to tune it.
        </p>
      </div>
    </>
  );
}
