import { formatPercent } from "@/lib/format";
import type { LineProbability } from "@/lib/probability";

/**
 * The two probabilities for one line, side by side.
 *
 * "Market" is the book's own price with its margin removed — not our opinion, and it
 * moves whenever the price moves. "Model" appears only where the spread gives a second,
 * independent read on the same question, which is the moneyline and nothing else. On a
 * spread or a total the model deliberately shows nothing rather than a decorative 50%.
 */
export function Probability({ value }: { value: LineProbability }) {
  if (value.market === null) return null;

  const edge = value.edgePoints;
  const meaningful = edge !== null && Math.abs(edge) >= 2;

  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
      <span className="text-slate-500">
        market{" "}
        <span className="tabular font-medium text-slate-300">
          {formatPercent(value.market, 1)}
        </span>
      </span>

      {value.model !== null ? (
        <span className="text-slate-500">
          model{" "}
          <span className="tabular font-medium text-slate-300">
            {formatPercent(value.model, 1)}
          </span>
        </span>
      ) : null}

      {edge !== null ? (
        <span
          className={
            meaningful
              ? edge > 0
                ? "tabular font-medium text-emerald-400"
                : "tabular font-medium text-rose-400"
              : "tabular text-slate-600"
          }
          title="Model probability minus de-vigged market probability, in percentage points"
        >
          {edge > 0 ? "+" : ""}
          {edge.toFixed(1)} pts
        </span>
      ) : null}

      {value.hold !== null ? (
        <span className="tabular text-slate-600" title="The book's margin on this market">
          hold {formatPercent(value.hold, 1)}
        </span>
      ) : null}
    </div>
  );
}
