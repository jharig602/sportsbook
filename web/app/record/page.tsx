import { Freshness } from "@/components/Freshness";
import { Card, Empty, PageHeader, Segmented, Stats } from "@/components/ui";
import { calibrate, type Calibration } from "@/lib/calibration";
import { buildRoiBreakdown, collapseByOutcome, roiCell, type RoiBreakdown } from "@/lib/shop-record";
import {
  buildBreakdown,
  type Gradeable,
  filterGrades,
  LEAGUES,
  MARKETS,
  type Breakdown,
  type LeagueFilter,
  type MarketFilter,
} from "@/lib/breakdown";
import { buildTrackRecord, getData, MIN_SAMPLES } from "@/lib/data";
import { formatKind, formatPercent } from "@/lib/format";
import type { RecordRow } from "@/lib/types";
import type { MarginModel } from "@/lib/probability";
import { DEFAULT_MAX_SPREAD } from "@/lib/blowout";
import { judge, projectDate, type Judgement } from "@/lib/verdict";

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

/**
 * Whether a rate has earned a verdict, and when it will if it has not.
 *
 * The page could already show a percentage. What it could not say is whether that
 * percentage means anything, which is the only question worth asking of it — 61.4% from
 * a hundred games looks exactly as authoritative as 61.4% from ten thousand.
 */
function VerdictLine({
  j,
  what,
  gradesPerWeek,
}: {
  j: Judgement;
  what: string;
  gradesPerWeek: number;
}) {
  if (j.state === "no-data") {
    return <p className="text-[12px] text-slate-500">{what}: nothing settled yet.</p>;
  }
  const when = projectDate(j.moreNeeded, gradesPerWeek);
  const tone =
    j.state === "clears" ? "text-emerald-300" : j.state === "fails" ? "text-rose-300" : "text-amber-300";
  const headline =
    j.state === "clears"
      ? "clears the vig"
      : j.state === "fails"
        ? "does not clear the vig"
        : "not enough games yet";

  return (
    <p className="text-[12px] leading-relaxed text-slate-400">
      <span className={`font-medium ${tone}`}>
        {what} &mdash; {headline}.
      </span>{" "}
      <span className="tabular">
        {(j.rate! * 100).toFixed(1)}% over {j.n}, 95% range{" "}
        {(j.lo * 100).toFixed(1)}&ndash;{(j.hi * 100).toFixed(1)}%
      </span>
      {j.state === "undecided" ? (
        <>
          {" "}&mdash; which still contains break-even.{" "}
          {j.moreNeeded ? (
            <>
              Needs about{" "}
              <span className="tabular text-slate-300">{j.moreNeeded.toLocaleString()}</span>{" "}
              more settled
              {when ? (
                <>
                  , around{" "}
                  <span className="text-slate-300">
                    {when.toLocaleDateString("en-US", {
                      timeZone: "America/Chicago",
                      month: "long",
                      day: "numeric",
                    })}
                  </span>{" "}
                  at the last week&rsquo;s rate of {gradesPerWeek.toLocaleString()}.
                </>
              ) : gradesPerWeek > 0 ? (
                <> &mdash; more than a season away at the current rate.</>
              ) : (
                <>. Nothing has settled this week, so there is no rate to project from.</>
              )}
            </>
          ) : (
            <> It sits on break-even, so no sample size will separate them.</>
          )}
        </>
      ) : null}
    </p>
  );
}

/**
 * Every market against every league, and what reading the grid costs you.
 *
 * The grid is the feature; the paragraph under it is the reason the feature is safe to
 * have. Six cells of a hundred-alert record hold about seventeen games each, and
 * seventeen games hand you a 70% rate roughly one time in eight with no edge at all --
 * so a six-cell grid almost always contains something that looks like a discovery. The
 * only defence is to price the search itself, which is what `familyP` does.
 */
function MarketGrid({ breakdown, market, league }: { breakdown: Breakdown; market: MarketFilter; league: LeagueFilter }) {
  const { cells, selection } = breakdown;
  const pct = (value: number | null) => (value === null ? "—" : `${(value * 100).toFixed(1)}%`);

  return (
    <Card className="mb-3 px-3.5 py-3">
      <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        By market and league
      </h2>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[420px] text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-1 py-1 text-left font-medium">market</th>
              {LEAGUES.map((l) => (
                <th key={l} className="px-1 py-1 text-right font-medium">{l.toUpperCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MARKETS.map((m) => (
              <tr key={m} className="border-t border-edge/60">
                <td className="px-1 py-1.5 text-slate-300">{m}</td>
                {LEAGUES.map((l) => {
                  const c = cells.find((x) => x.market === m && x.league === l)!;
                  const isBest = selection.best?.market === m && selection.best?.league === l;
                  const highlighted = (market === m || market === "all") && (league === l || league === "all");
                  return (
                    <td
                      key={l}
                      className={`px-1 py-1.5 text-right tabular ${highlighted ? "" : "opacity-40"}`}
                    >
                      <span
                        className={
                          c.rate === null
                            ? "text-slate-600"
                            : c.adjusted.state === "clears"
                              ? "text-emerald-300"
                              : c.adjusted.state === "fails"
                                ? "text-rose-300"
                                : "text-slate-200"
                        }
                      >
                        {pct(c.rate)}
                      </span>
                      <span className="ml-1 text-[10px] text-slate-600">
                        {c.decided > 0 ? `n=${c.decided}` : "—"}
                      </span>
                      {isBest && c.decided > 0 ? (
                        <span className="ml-1 text-[10px] text-amber-400">best</span>
                      ) : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Green means the cell clears {(breakdown.breakEven * 100).toFixed(1)}% break-even
        even after paying for the fact that six cells were compared. Red means it fails
        the same way. Everything else is undecided, which at these sample sizes is almost
        everything.
      </p>

      {selection.best && selection.familyP !== null ? (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          Best cell is <span className="text-slate-200">{selection.best.label}</span> at{" "}
          <span className="tabular text-slate-200">{pct(selection.best.rate)}</span> over{" "}
          {selection.best.decided}.{" "}
          {selection.familyP > 0.2 ? (
            <>
              With no edge anywhere, at least one of the {selection.compared} cells reads
              that well{" "}
              <span className="text-amber-300">
                {(selection.familyP * 100).toFixed(0)}% of the time
              </span>
              . That is not a finding, it is the grid doing what grids do — betting it
              would be betting the search rather than the signal.
            </>
          ) : (
            <>
              With no edge anywhere, some cell reads that well{" "}
              <span className="text-emerald-300">
                {(selection.familyP * 100).toFixed(1)}% of the time
              </span>
              , which is low enough to be worth watching. Watching, not staking the
              season on: it is still one slice chosen out of {selection.compared}.
            </>
          )}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Did the probabilities tell the truth.
 *
 * Shown only for the shopping rule, because only it makes a probabilistic claim. An
 * alert names a side; a shop row says "this side, at this number, wins 56% of the time",
 * and that is a far sharper thing to be wrong about. It is also testable much sooner —
 * the cover record has been undecided for a season, and this needs dozens.
 */
/**
 * The line-shopping grid: return per dollar, one result per outcome.
 *
 * Win rate against 52.4% is the wrong question for these picks, most of which are not
 * -110 bets; see shop-record.ts. Each cell shows what $1 on every result actually made,
 * what the picks predicted, and a verdict that knows the prices.
 */
function RoiGrid({
  breakdown,
  market,
  league,
}: {
  breakdown: RoiBreakdown;
  market: MarketFilter;
  league: LeagueFilter;
}) {
  const signedPct = (v: number | null) =>
    v === null ? "—" : `${v > 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;
  const { best, familyP } = breakdown;
  return (
    <Card className="mb-3 px-3.5 py-3">
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        Return by market and league
      </h2>
      <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
        {breakdown.picks} recorded picks are {breakdown.results} separate results: when
        several books offered the same number on one game, that game is counted once.
      </p>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[440px] text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-1 py-1 text-left font-medium">market</th>
              {LEAGUES.map((l) => (
                <th key={l} className="px-1 py-1 text-right font-medium">{l.toUpperCase()}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MARKETS.map((m) => (
              <tr key={m} className="border-t border-edge/60">
                <td className="px-1 py-1.5 text-slate-300">{m}</td>
                {LEAGUES.map((l) => {
                  const c = breakdown.cells.find((x) => x.market === m && x.league === l)!;
                  const highlighted = (market === m || market === "all") && (league === l || league === "all");
                  const isBest = best?.market === m && best?.league === l;
                  return (
                    <td key={l} className={`px-1 py-1.5 text-right tabular ${highlighted ? "" : "opacity-40"}`}>
                      <span
                        className={
                          c.state === "clears"
                            ? "text-emerald-300"
                            : c.state === "fails"
                              ? "text-rose-300"
                              : c.roi === null
                                ? "text-slate-600"
                                : "text-slate-200"
                        }
                      >
                        {signedPct(c.roi)}
                      </span>
                      <span className="ml-1 text-[10px] text-slate-600">
                        {c.games > 0 ? `n=${c.games}` : ""}
                      </span>
                      {c.expectedRoi !== null ? (
                        <span className="block text-[10px] text-slate-600">
                          predicted {signedPct(c.expectedRoi)}
                        </span>
                      ) : null}
                      {isBest ? <span className="block text-[10px] text-amber-400">best</span> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
        Each number is what $1 on every result would have made, at the prices taken &mdash; a
        +300 underdog only needs to win a quarter of the time. Green means the whole likely
        range is profit even after allowing for six cells being compared; red means the
        whole range is a loss. Everything else is undecided.
      </p>
      {best && familyP !== null ? (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-400">
          Best cell is <span className="text-slate-200">{best.label}</span> at{" "}
          <span className="tabular text-slate-200">{signedPct(best.roi)}</span> over{" "}
          {best.games} results. If every pick had been priced fair, some cell would do at
          least that well{" "}
          <span className={familyP > 0.2 ? "text-amber-300" : "text-emerald-300"}>
            {(familyP * 100).toFixed(0)}% of the time
          </span>
          {familyP > 0.2
            ? " — that is luck, not a finding."
            : " — worth watching, not staking the season on."}
        </p>
      ) : null}
    </Card>
  );
}

function CalibrationTable({ calibration }: { calibration: Calibration }) {
  if (calibration.n === 0) return null;
  const pct = (v: number | null, digits = 1) => (v === null ? "—" : `${(v * 100).toFixed(digits)}%`);

  return (
    <Card className="mb-3 px-3.5 py-3">
      <h2 className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        Were the probabilities honest
      </h2>
      <p className="mb-2 text-[11px] leading-relaxed text-slate-500">
        Each band asks whether picks called at one probability actually landed at it. A
        band is judged against <em>its own claim</em>, not against break-even: predicting
        42% and delivering 42% is perfectly honest and still a losing bet, and confusing
        the two is how a working model gets thrown out.
      </p>
      <div className="-mx-1 overflow-x-auto">
        <table className="w-full min-w-[380px] text-[12px]">
          <thead>
            <tr className="text-[10px] uppercase tracking-wider text-slate-500">
              <th className="px-1 py-1 text-left font-medium">said</th>
              <th className="px-1 py-1 text-right font-medium">n</th>
              <th className="px-1 py-1 text-right font-medium">predicted</th>
              <th className="px-1 py-1 text-right font-medium">actual</th>
              <th className="px-1 py-1 text-right font-medium">gap</th>
            </tr>
          </thead>
          <tbody>
            {calibration.bands.map((band) => (
              <tr key={band.label} className="border-t border-edge/60">
                <td className="px-1 py-1.5 text-slate-300">{band.label}</td>
                <td className="tabular px-1 py-1.5 text-right text-slate-500">{band.n}</td>
                <td className="tabular px-1 py-1.5 text-right text-slate-400">{pct(band.predicted)}</td>
                <td className="tabular px-1 py-1.5 text-right text-slate-200">{pct(band.actual)}</td>
                <td
                  className={`tabular px-1 py-1.5 text-right ${
                    band.gap === null
                      ? "text-slate-600"
                      : band.verdict?.state === "fails"
                        ? "text-rose-300"
                        : "text-slate-500"
                  }`}
                >
                  {band.gap === null ? "—" : `${band.gap > 0 ? "+" : ""}${(band.gap * 100).toFixed(1)}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {calibration.brier !== null && calibration.brierBaseline !== null ? (
        <p className="mt-2 text-[11px] leading-relaxed text-slate-500">
          Brier score{" "}
          <span
            className={`tabular ${
              calibration.brier < calibration.brierBaseline ? "text-emerald-300" : "text-rose-300"
            }`}
          >
            {calibration.brier.toFixed(4)}
          </span>{" "}
          against {calibration.brierBaseline.toFixed(4)} for saying &ldquo;coin
          flip&rdquo; about every one of the same games. Carried because the table above
          cannot catch a rule that says 50% to everything &mdash; that rule is perfectly
          calibrated and perfectly useless, and only this number says so.
        </p>
      ) : null}
    </Card>
  );
}

export default async function RecordPage({
  searchParams,
}: {
  searchParams: Promise<{ market?: string; league?: string; source?: string }>;
}) {
  const params = await searchParams;
  // Which rule these numbers describe. It was never named before, and a page called
  // "Track Record" showing only the line-movement rule reads as a verdict on the whole
  // app -- which is exactly how it was read.
  const source: "movers" | "shop" = params.source === "shop" ? "shop" : "movers";
  const market: MarketFilter =
    params.market === "spread" || params.market === "total" || params.market === "moneyline"
      ? params.market
      : "all";
  const league: LeagueFilter =
    params.league === "nfl" || params.league === "ncaaf" ? params.league : "all";
  const data = getData();
  const [alerts, moverGrades, shopGrades, models, counts, freshness] = await Promise.all([
    data.alerts(),
    data.grades(),
    data.shopGrades(),
    data.marginModels(),
    data.alertCounts(),
    data.freshness(),
  ]);
  // Never pooled. They answer different questions, and one rate over both would
  // describe neither -- which is the confusion this whole toggle exists to end. Kept as
  // two separately typed lists rather than a union with casts at the bottom: a cast here
  // would compile and then read `move_strength` off a row that has none.
  const moverShown = filterGrades(moverGrades, market, league);
  // Several books on the same number are one result; see shop-record.ts.
  const outcomes = collapseByOutcome(shopGrades);
  const shopShown = filterGrades(outcomes, market, league);
  const shown: Gradeable[] = source === "shop" ? shopShown : moverShown;

  // The grid always shows every cell -- narrowing it would hide the thing it exists to
  // reveal -- but everything below reflects the filter.
  const breakdown = buildBreakdown(moverGrades);
  const roiBreakdown = buildRoiBreakdown(outcomes);
  const sliceReturn = roiCell(outcomes, market, league);
  const filtered = market !== "all" || league !== "all";

  // byKind and byStrength read `kind` and `move_strength`, which only an alert has, so
  // this structure is the movers' alone. Fed an empty list for the other source rather
  // than computed and quietly filled with zeros that would read as measured.
  const record = buildTrackRecord(
    alerts,
    source === "movers" ? moverShown : [],
    filtered || source !== "movers" ? undefined : counts,
  );

  // Only the shopping rule states a probability, so only it has a calibration to check.
  const calibration = calibrate(source === "shop" ? shopShown : []);
  const replayedCount = shopGrades.filter((g) => g.replayed).length;

  // Judged separately, because they currently disagree: cover looks strong and line
  // value does not, and showing only the flattering one would be the same failure this
  // page exists to prevent. Line value is a mover-only measure -- it asks whether the
  // book's own number kept moving the way the alert said.
  const decidedCover = shown.filter((g) => g.result_covered !== null);
  const decidedLine = moverShown.filter((g) => g.line_value_won !== null);
  const cover = judge(decidedCover.filter((g) => g.result_covered).length, decidedCover.length);
  const lineValue = judge(decidedLine.filter((g) => g.line_value_won).length, decidedLine.length);

  return (
    <>
      <PageHeader
        title="Track Record"
        subtitle={
          source === "shop"
            ? "How the cross-book edges have actually done — the disagreement this app is named after."
            : "How the line-movement alerts have actually done. Not the shopping rule; use the toggle."
        }
      />

      {/*
        Named first and always. Every number below belongs to exactly one rule, and for
        a long time the page showed one of them under a title that read as both.
      */}
      <Segmented
        options={[
          { key: "movers", label: "Line moves" },
          { key: "shop", label: "Line shopping" },
        ]}
        active={source}
        hrefFor={(key) =>
          `/record?source=${key}${market === "all" ? "" : `&market=${market}`}${
            league === "all" ? "" : `&league=${league}`
          }`
        }
      />

      <Stats
        items={
          source === "shop"
            ? [
                { value: String(shown.length), label: "results here" },
                {
                  value:
                    sliceReturn.roi === null
                      ? "—"
                      : `${sliceReturn.roi > 0 ? "+" : ""}${(sliceReturn.roi * 100).toFixed(1)}%`,
                  label: "return per $1",
                  tone:
                    sliceReturn.state === "clears"
                      ? ("good" as const)
                      : sliceReturn.state === "fails"
                        ? ("bad" as const)
                        : ("plain" as const),
                },
                {
                  value:
                    calibration.actual === null ? "—" : formatPercent(calibration.actual, 1),
                  label: "won",
                },
              ]
            : [
                { value: String(record.totalAlerts), label: "alerts" },
                { value: String(record.totalGraded), label: "graded" },
                { value: String(record.awaitingResults), label: "awaiting" },
              ]
        }
      />
      <div className="mb-2 space-y-1.5">
        <Segmented
          options={[
            { key: "all", label: "All markets" },
            ...MARKETS.map((m) => ({ key: m, label: m === "moneyline" ? "ML" : m })),
          ]}
          active={market}
          hrefFor={(key) =>
            `/record?source=${source}&market=${key}${league === "all" ? "" : `&league=${league}`}`
          }
        />
        <Segmented
          options={[
            { key: "all", label: "Both leagues" },
            ...LEAGUES.map((l) => ({ key: l, label: l.toUpperCase() })),
          ]}
          active={league}
          hrefFor={(key) =>
            `/record?source=${source}&league=${key}${market === "all" ? "" : `&market=${market}`}`
          }
        />
      </div>

      {source === "shop" ? (
        <RoiGrid breakdown={roiBreakdown} market={market} league={league} />
      ) : (
        <MarketGrid breakdown={breakdown} market={market} league={league} />
      )}

      {/*
        Backfilled rows are named rather than blended in. They are the real rule at real
        past moments, but priced with the model fitted today -- which, for a game already
        played, may have seen its own answer. Presenting 243 reconstructed grades as
        simply "the record" would be the same unlabelled number this page has been
        corrected for once already.
      */}
      {source === "shop" && replayedCount > 0 ? (
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          <span className="text-slate-300">{replayedCount}</span> of {shopGrades.length}{" "}
          graded {shopGrades.length === 1 ? "edge was" : "edges were"} reconstructed from
          stored history rather than seen live. The rule and the moment are real &mdash;
          the board was rebuilt from append-only quotes at their own timestamps &mdash;
          but the margin model pricing them is the one fitted today, so for a game
          already played it may have seen its own answer. If these ever read better than
          the live ones, that is the first thing to suspect.
        </p>
      ) : null}

      {source === "shop" ? <CalibrationTable calibration={calibration} /> : null}

      {source === "shop" && shopGrades.length === 0 ? (
        <Empty
          title="No cross-book edges scored yet"
          detail={
            <>
              Until now the board computed an expected return, showed it, sometimes sent
              a notification about it, and never checked. Nothing was stored that could
              settle the claim &mdash; `shop_notifications` kept the book, game, market
              and side, but no line and no price, so it could not be graded in either
              direction. Every number you have read on this page until now was the
              line-movement rule, not this one. Recording starts from the next collector
              run; grades follow once those games finish.
            </>
          }
        />
      ) : null}

      {filtered ? (
        <p className="mb-3 text-[11px] leading-relaxed text-slate-500">
          Showing {shown.length} {source === "shop" ? "result" : "alert"}
          {shown.length === 1 ? "" : "s"} in{" "}
          {market === "all" ? "every market" : market} ·{" "}
          {league === "all" ? "both leagues" : league.toUpperCase()}. Every number below
          is this slice only, and it is one of {MARKETS.length * LEAGUES.length} slices
          you could have picked &mdash; read it alongside the grid above, not instead of
          it. The count is every cell, not just the ones with data: a slice you skipped
          because it looked thin was still a slice you chose against.
        </p>
      ) : null}

      {Object.entries(models).map(([leagueKey, model]) => (
        <SpreadBands key={leagueKey} model={model} league={leagueKey} />
      ))}


      {/* Mover-only. Under the shopping source `record` is built from an empty list,
          so this fired alongside the shop empty state and the page showed two different
          explanations for the same blank screen. */}
      {source === "movers" && record.totalGraded === 0 ? (
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
          {/* Both read fields only an alert carries, so neither exists for the
              shopping rule. Rendering them empty would read as "measured, and zero". */}
          {source === "movers" ? (
            <>
              <RecordTable rows={record.byKind} caption="By alert kind" />
              <RecordTable rows={record.byStrength} caption="By Move Strength bucket" />
            </>
          ) : null}

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
            <div className="mt-3 space-y-2 border-t border-edge/60 pt-3">
              <VerdictLine j={cover} what="Cover" gradesPerWeek={counts.gradedLast7} />
              <VerdictLine j={lineValue} what="Line value" gradesPerWeek={counts.gradedLast7} />
            </div>

            <p className="mt-3 text-xs leading-relaxed text-slate-500">
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
      <Freshness data={freshness} />
    </>
  );
}
