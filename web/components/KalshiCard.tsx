import { Card } from "@/components/ui";
import { formatPrice, formatRelative } from "@/lib/format";
import { costToAmerican, effectiveAsk, isThin, kalshiFair, type KalshiFlag, type KalshiGame } from "@/lib/kalshi";

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const cents = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)}¢`);

const KIND_LABEL: Record<KalshiFlag["kind"], string> = {
  stale_book: "Stale book",
  kalshi_value: "Kalshi value",
  arb: "Arb",
};

/**
 * One game on Kalshi: its fair chance (the midpoints), the book for each team, and what
 * buying really costs after the fee. Then the flags on this game the viewer may see, and
 * a count of the ones held back in their state -- hidden, not deleted, never pretended
 * away.
 */
export function KalshiCard({
  kalshi,
  flags,
  hidden,
  homeTeam,
  awayTeam,
}: {
  kalshi: KalshiGame | null;
  flags: KalshiFlag[];
  hidden: number;
  homeTeam: string;
  awayTeam: string;
}) {
  if (!kalshi) return null;
  const fair = kalshiFair(kalshi);
  const thin = isThin(kalshi.home) || isThin(kalshi.away);
  const team = (side: "home" | "away") => (side === "home" ? homeTeam : awayTeam);

  return (
    <Card className="px-3.5 py-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Kalshi</h2>
        <span className="text-[10px] text-slate-600">{formatRelative(kalshi.home.observedAt)}</span>
      </div>
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-[10px] uppercase tracking-wide text-slate-600">
            <th className="text-left font-normal">Team</th>
            <th className="text-right font-normal">Fair</th>
            <th className="text-right font-normal">Bid / ask</th>
            <th className="text-right font-normal">Depth</th>
            <th className="text-right font-normal">Buy, fee in</th>
          </tr>
        </thead>
        <tbody>
          {(["away", "home"] as const).map((side) => {
            const s = kalshi[side];
            const sideFair = fair === null ? null : side === "home" ? fair : 1 - fair;
            return (
              <tr key={side} className="text-slate-300">
                <td className="truncate py-0.5 pr-2">{team(side)}</td>
                <td className="tabular text-right">{pct(sideFair)}</td>
                <td className="tabular text-right text-slate-400">
                  {cents(s.yesBid)} / {cents(s.yesAsk)}
                </td>
                <td className="tabular text-right text-slate-500">
                  {Math.round(Math.min(s.bidSize ?? 0, s.askSize ?? 0)).toLocaleString()}
                </td>
                <td className="tabular text-right text-violet-300">{formatPrice(costToAmerican(effectiveAsk(s.yesAsk)))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
        {thin
          ? "Too thin to trust: the spread is wide or few contracts rest at the best price, so this game's Kalshi price stays out of every comparison."
          : "Fair is the midpoint, no vig, and joins this game's comparisons as one more book. Buy is the ask plus Kalshi's fee. Pregame snapshots only: Kalshi keeps trading through the game."}
      </p>

      {flags.length > 0 ? (
        <ul className="mt-2 space-y-1 border-t border-edge/70 pt-2">
          {flags.map((f) => (
            <li key={f.flagId} className="text-[12px] text-slate-300">
              <span className="font-medium text-amber-300">{KIND_LABEL[f.kind]}</span>{" "}
              {f.kind === "stale_book" ? (
                <>
                  {f.book} has {team(f.side)} at {formatPrice(f.bookPrice)} ({pct(f.bookFair)} no-vig) against Kalshi&rsquo;s{" "}
                  {pct(f.kalshiFair)}: {f.edgePoints.toFixed(1)} points.
                </>
              ) : f.kind === "kalshi_value" ? (
                <>
                  {team(f.side)} costs {cents(f.kalshiCost)} on Kalshi after the fee; {f.books} books make it {pct(f.consensus)}.
                </>
              ) : (
                <>
                  {team(f.side)} at {f.book} {formatPrice(f.bookPrice)} plus the other side on Kalshi at {cents(f.kalshiCost)}:{" "}
                  {f.edgePoints.toFixed(1)}¢ per $1 locked in.
                </>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      {hidden > 0 ? (
        <p className="mt-1.5 text-[11px] text-slate-500">
          {hidden} flag{hidden === 1 ? "" : "s"} that buy on Kalshi hidden in your state and logged in Settings.
        </p>
      ) : null}
    </Card>
  );
}
