import { Card, Empty, PageHeader, Stats } from "@/components/ui";
import { buildTrackRecord, getData, MIN_SAMPLES } from "@/lib/data";
import { formatKind, formatPercent } from "@/lib/format";
import type { RecordRow } from "@/lib/types";
import type { MarginModel } from "@/lib/probability";
import { DEFAULT_MAX_SPREAD } from "@/lib/blowout";

export const dynamic = "force-dynamic";

/**
 * What a cover rate has to clear before it is worth anything.
 *
 * At -110 a winner returns 100/110 and a loser costs the stake, so break-even is
 * 110/210. Comparing against a coin flip instead — which this page used to do — sets
 * the bar two and a half points too low and makes a losing rule look like a finding.
 */
const BREAK_EVEN = 110 / 210;

/** Return per dollar staked at -110, given how often the pick covers. */
function coverRoi(coverRate: number): number {
  return coverRate * (100 / 110) - (1 - coverRate);
}

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

/**
 * How well each band of spread size is actually priced.
 *
 * This is the answer to "are blowouts guessed accurately", and it comes from the whole
 * historical fit rather than from the handful of alerts graded so far. Two columns
 * carry it:
 *
 * `measured sd` is how far results land from the number in that band. Flat across the
 * range means a 40-point favourite is no less predictable than a 3-point one, which is
 * what the data says and is the opposite of the usual assumption.
 *
 * `priced` is the one that matters. False means the band has too few games to have
 * fitted its own dispersion, so the model substitutes the league-wide figure — it is
 * not pricing that band, it is assuming it behaves like the others. That assumption may
 * well be right; it has simply never been checked there, which is a different thing
 * from being checked and passing.
 *
 * The mean is shown against its own standard error rather than as a bare number. A
 * per-band mean is a directional claim — "big favourites beat their number" — and this
 * project has been caught once already treating a small-sample tilt as forty separate
 * opportunities.
 */
function SpreadBands({ model, league }: { model: MarginModel; league: string }) {
  const buckets = model.buckets ?? [];
  if (buckets.length === 0) return null;

  return (
    <Card className="mt-4 overflow-hidden">
      <div className="border-b border-edge px-3 py-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-slate-400">
          {league.toUpperCase()} &mdash; how each spread size is priced
        </h2>
      </div>
      <div className="scroll-x">
        <table className="w-full min-w-[30rem] text-left">
          <thead>
            <tr className="text-[11px] uppercase tracking-wide text-slate-500">
              <th className="px-3 py-1.5 font-medium">Spread</th>
              <th className="px-3 py-1.5 text-right font-medium">Games</th>
              <th className="px-3 py-1.5 text-right font-medium">Measured sd</th>
              <th className="px-3 py-1.5 text-right font-medium">Mean miss</th>
              <th className="px-3 py-1.5 text-right font-medium">Priced</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => {
              const se = b.mean_se ?? 0;
              const z = se > 0 ? Math.abs(b.mean / se) : 0;
              const hidden = b.lo >= DEFAULT_MAX_SPREAD;
              return (
                <tr
                  key={`${b.lo}-${b.hi}`}
                  className={`border-t border-edge/60 text-[13px] ${hidden ? "opacity-60" : ""}`}
                >
                  <td className="px-3 py-1.5 text-slate-300">
                    {b.lo}&ndash;{b.hi > 900 ? "+" : b.hi}
                    {hidden ? (
                      <span className="ml-1.5 text-[10px] uppercase text-slate-600">hidden</span>
                    ) : null}
                  </td>
                  <td className="tabular px-3 py-1.5 text-right text-slate-400">{b.games}</td>
                  <td className="tabular px-3 py-1.5 text-right text-slate-300">
                    {(b.measured_sd ?? b.sd).toFixed(2)}
                  </td>
                  <td className="tabular px-3 py-1.5 text-right text-slate-400">
                    {b.mean > 0 ? "+" : ""}
                    {b.mean.toFixed(2)}
                    <span className={`ml-1 text-[10px] ${z >= 2 ? "text-amber-400" : "text-slate-600"}`}>
                      &plusmn;{se.toFixed(2)}
                    </span>
                  </td>
                  <td className="px-3 py-1.5 text-right text-[12px]">
                    {b.usable ? (
                      <span className="text-emerald-400">yes</span>
                    ) : (
                      <span className="text-amber-400">assumed</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-edge/60 px-3 py-2 text-[11px] leading-relaxed text-slate-500">
        <span className="text-slate-400">Measured sd</span> is how far results land from
        the number. Flat across the range means a big favourite is no harder to predict
        than a small one &mdash; which is what the data says, and the opposite of the
        usual assumption.{" "}
        <span className="text-slate-400">Assumed</span> means the band has too few games
        to have fitted its own figure, so the league-wide one is substituted: the model
        is not pricing that band, it is guessing it behaves like the rest. That is why
        games of {DEFAULT_MAX_SPREAD}+ points are hidden from the board by default.
      </p>
    </Card>
  );
}

export default async function RecordPage() {
  const data = getData();
  const [alerts, grades, models] = await Promise.all([
    data.alerts(),
    data.grades(),
    data.marginModels(),
  ]);
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
      {Object.entries(models).map(([league, model]) => (
        <SpreadBands key={league} model={model} league={league} />
      ))}


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
              <span className="text-slate-600">vs</span> break-even:{" "}
              <span className="tabular">{formatPercent(BREAK_EVEN, 2)}</span>
              {record.baseline?.alerts !== null && record.baseline?.alerts !== undefined ? (
                <span
                  className={`ml-2 tabular text-xs ${
                    coverRoi(record.baseline.alerts) > 0 ? "text-emerald-400" : "text-rose-400"
                  }`}
                >
                  {coverRoi(record.baseline.alerts) > 0 ? "+" : ""}
                  {(coverRoi(record.baseline.alerts) * 100).toFixed(1)}% per dollar
                </span>
              ) : null}
            </p>
            <p className="mt-2 text-xs leading-relaxed text-slate-500">
              A coin flip is <span className="text-slate-400">not</span> the bar, and
              comparing against one flatters every rule on this page. At &minus;110 you
              risk $1.10 to win $1.00, so 50% loses 4.5 cents of every dollar staked and{" "}
              <span className="tabular text-slate-400">{formatPercent(BREAK_EVEN, 2)}</span>{" "}
              is where a rule stops costing money. The gap between the two is the vig, and
              it is charged whether the pick was right or wrong.
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
