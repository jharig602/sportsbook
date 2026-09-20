"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

import {
  bestStake,
  DEFAULT_CONVERSION,
  evCurve,
  expiryState,
  formatAmerican,
  promoEv,
  type PromoTerms,
} from "@/lib/promo-ev";
import type { Promo } from "@/lib/types";

const TYPE_LABEL: Record<Promo["type"], string> = {
  stake_back: "Stake back",
  profit_boost: "Profit boost",
  odds_boost: "Odds boost",
  bonus_bet: "Bonus bet",
  deposit_match: "Deposit match",
};

function termsOf(promo: Promo): PromoTerms {
  return {
    type: promo.type,
    capRefund: promo.cap_refund,
    maxStake: promo.max_stake,
    boostPct: promo.boost_pct,
    bonusFace: promo.bonus_face,
    boostedPrice: promo.boosted_price,
    basePrice: promo.base_price,
    depositBonus: promo.deposit_bonus,
    rolloverMultiple: promo.rollover_multiple,
    minOddsAmerican: promo.min_odds_american,
    minLegs: promo.min_legs,
  };
}

/**
 * What a promo is worth if it is used well.
 *
 * The best qualifying price on the curve, not the price you happen to be looking at: a
 * token's value is a property of its terms, and quoting it at a short price would
 * understate every stake-back on the board. Fair pricing is assumed throughout — the
 * value comes from the structure, and pretending otherwise would smuggle a handicapping
 * claim into a calculator.
 */
function bestValue(promo: Promo): number {
  const terms = termsOf(promo);
  const stake = bestStake(terms);
  const curve = evCurve(terms, stake).filter((point) => point.qualifies);
  if (curve.length === 0) return 0;
  return Math.max(...curve.map((point) => point.ev));
}

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function countdown(hours: number): string {
  if (hours <= 0) return "expired";
  if (hours < 1) return `${Math.round(hours * 60)}m left`;
  if (hours < 48) return `${Math.floor(hours)}h left`;
  return `${Math.floor(hours / 24)}d left`;
}

export function PromoList({ promos, now }: { promos: Promo[]; now: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const clock = useMemo(() => new Date(now), [now]);

  const rows = useMemo(
    () =>
      promos
        .map((promo) => ({ promo, value: bestValue(promo), expiry: expiryState(promo.expires_at, clock) }))
        .sort((a, b) => new Date(a.promo.expires_at).getTime() - new Date(b.promo.expires_at).getTime()),
    [promos, clock],
  );

  const live = rows.filter((r) => r.promo.status === "available" && !r.expiry.expired);
  const gone = rows.filter((r) => r.promo.status !== "available" || r.expiry.expired);
  const total = live.reduce((sum, r) => sum + r.value, 0);
  const soon = live.filter((r) => r.expiry.hoursLeft <= 48);
  const soonValue = soon.reduce((sum, r) => sum + r.value, 0);

  async function act(promoId: string, body: Record<string, unknown>, method: "POST" | "DELETE" = "POST") {
    setBusy(promoId);
    try {
      await fetch(method === "DELETE" ? "/api/promos" : "/api/promos/use", {
        method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ promo_id: promoId, ...body }),
      });
      router.refresh();
    } finally {
      setBusy(null);
    }
  }

  if (promos.length === 0) {
    return (
      <p className="mb-3 rounded-xl border border-edge bg-surface px-3.5 py-3 text-[13px] leading-relaxed text-slate-400">
        No promos yet. Add one as the book words it — the expiry is the part that matters,
        because an unused token is the only way these actually lose money.
      </p>
    );
  }

  return (
    <>
      <div className="mb-3 rounded-xl border border-edge bg-surface px-3.5 py-3">
        <p className="text-[13px] text-slate-300">
          <span className="font-semibold text-slate-100">{money(total)}</span> of unused promos
          {soon.length > 0 ? (
            <>
              {" "}
              &middot;{" "}
              <span className="font-semibold text-amber-300">{money(soonValue)}</span> expiring
              within 48 hours
            </>
          ) : null}
        </p>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-600">
          Value assumes each token is used at the best qualifying price, priced fairly. It
          is what the terms are worth, not a prediction about any game.
        </p>
      </div>

      <ul className="space-y-1.5">
        {live.map(({ promo, value, expiry }) => (
          <li key={promo.promo_id} className="overflow-hidden rounded-xl border border-edge bg-surface">
            <button
              type="button"
              onClick={() => setOpen(open === promo.promo_id ? null : promo.promo_id)}
              className="flex w-full items-start gap-2.5 px-3.5 py-2.5 text-left"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px] font-medium text-slate-100">
                  {promo.title}
                </span>
                <span className="mt-0.5 block text-[11px] text-slate-500">
                  {promo.book} &middot; {TYPE_LABEL[promo.type]}
                </span>
              </span>
              <span className="shrink-0 text-right">
                <span className="tabular block text-[14px] font-semibold text-emerald-300">
                  {money(value)}
                </span>
                <span
                  className={`tabular mt-0.5 block text-[11px] ${
                    expiry.urgent ? "font-semibold text-rose-300" : "text-slate-500"
                  }`}
                >
                  {countdown(expiry.hoursLeft)}
                </span>
              </span>
            </button>

            {open === promo.promo_id ? (
              <Optimizer
                promo={promo}
                busy={busy === promo.promo_id}
                onUsed={(details) => act(promo.promo_id, details)}
                onRemove={() => act(promo.promo_id, {}, "DELETE")}
              />
            ) : null}
          </li>
        ))}
      </ul>

      {gone.length > 0 ? (
        <details className="mt-3">
          <summary className="cursor-pointer text-[11px] uppercase tracking-wide text-slate-500">
            {gone.length} used or expired
          </summary>
          <ul className="mt-1.5 space-y-1">
            {gone.map(({ promo, expiry }) => (
              <li
                key={promo.promo_id}
                className="flex items-baseline justify-between rounded-lg bg-raised/40 px-3 py-2 text-[12px] text-slate-500"
              >
                <span className="min-w-0 truncate">
                  {promo.title} &middot; {promo.book}
                </span>
                <span className="shrink-0">
                  {promo.status === "used" ? "used" : expiry.expired ? "expired unused" : ""}
                </span>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </>
  );
}

/**
 * EV for a price and stake you type, plus the shape across the range.
 *
 * The curve is here because the rule it teaches — longer qualifying odds are worth more,
 * for every type except a plain odds boost — lands faster from seeing it than from being
 * told. The binding constraint is named on every answer, since the mistake this is meant
 * to prevent is staking past a cap where the extra dollars are simply unprotected.
 */
function Optimizer({
  promo,
  busy,
  onUsed,
  onRemove,
}: {
  promo: Promo;
  busy: boolean;
  onUsed: (details: Record<string, unknown>) => void;
  onRemove: () => void;
}) {
  const terms = termsOf(promo);
  const [stake, setStake] = useState(String(bestStake(terms)));
  const [price, setPrice] = useState(String(promo.min_odds_american ?? 300));
  const [legs, setLegs] = useState(String(promo.min_legs ?? 1));
  const [conversion, setConversion] = useState(String(DEFAULT_CONVERSION));

  const stakeNumber = Number(stake) || 0;
  const priceNumber = Number(price) || 0;
  const curve = useMemo(
    () => evCurve(terms, stakeNumber, undefined, { conversion: Number(conversion) || DEFAULT_CONVERSION, legs: Number(legs) || 1 }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [promo.promo_id, stakeNumber, conversion, legs],
  );
  const atPrice = curve.find((c) => c.price === priceNumber);
  const fair = atPrice?.p ?? 0;
  const result = promoEv(terms, {
    p: fair,
    price: priceNumber || 100,
    stake: stakeNumber,
    legs: Number(legs) || 1,
    conversion: Number(conversion) || DEFAULT_CONVERSION,
  });

  const field =
    "tabular mt-0.5 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600";

  return (
    <div className="border-t border-edge/70 px-3.5 py-2.5">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Stake</span>
          <input value={stake} inputMode="decimal" onChange={(e) => setStake(e.target.value.replace(/[^0-9.]/g, ""))} className={field} />
        </label>
        <label className="block">
          <span className="text-[10px] uppercase tracking-wide text-slate-500">Price</span>
          <input value={price} inputMode="numeric" onChange={(e) => setPrice(e.target.value.replace(/[^0-9+-]/g, ""))} className={field} />
        </label>
        {promo.type === "profit_boost" ? (
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">Legs</span>
            <input value={legs} inputMode="numeric" onChange={(e) => setLegs(e.target.value.replace(/[^0-9]/g, ""))} className={field} />
          </label>
        ) : null}
        {promo.type === "stake_back" ? (
          <label className="block">
            <span className="text-[10px] uppercase tracking-wide text-slate-500">Refund converts at</span>
            <input value={conversion} inputMode="decimal" onChange={(e) => setConversion(e.target.value.replace(/[^0-9.]/g, ""))} className={field} />
          </label>
        ) : null}
      </div>

      <p className="tabular mt-2 text-[13px] text-slate-200">
        <span className={result.ev >= 0 ? "font-semibold text-emerald-300" : "font-semibold text-rose-300"}>
          {money(result.ev)}
        </span>{" "}
        at {formatAmerican(priceNumber)}
        {result.requiredTurnover ? ` · needs $${result.requiredTurnover.toFixed(0)} of bets` : ""}
      </p>
      {result.binding.length > 0 ? (
        <p className="mt-0.5 text-[11px] text-slate-500">Bound by: {result.binding.join("; ")}.</p>
      ) : null}
      {result.warnings.map((w) => (
        <p key={w} className="mt-0.5 text-[11px] leading-relaxed text-amber-300/90">{w}</p>
      ))}

      <div className="-mx-1 mt-2 overflow-x-auto">
        <table className="w-full min-w-[320px] text-[11px]">
          <tbody>
            <tr className="text-slate-500">
              {curve.map((c) => (
                <td key={c.price} className="px-1 py-0.5 text-right">{formatAmerican(c.price)}</td>
              ))}
            </tr>
            <tr className="tabular">
              {curve.map((c) => (
                <td
                  key={c.price}
                  className={`px-1 py-0.5 text-right ${
                    !c.qualifies ? "text-slate-700 line-through" : c.ev >= 0 ? "text-emerald-300" : "text-rose-300"
                  }`}
                >
                  {c.ev.toFixed(1)}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
      <p className="mt-1 text-[10px] leading-relaxed text-slate-600">
        Each column is a price, each number the value there at this stake, assuming the
        market is priced fairly. Struck-through prices do not qualify.
      </p>

      <div className="mt-2.5 flex gap-2">
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            onUsed({
              stake: stakeNumber,
              odds_american: priceNumber,
              legs: Number(legs) || 1,
              fair_prob: fair || null,
              ev_at_placement: result.ev,
            })
          }
          className="flex-1 rounded-lg bg-sky-500/15 py-1.5 text-[12px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 disabled:opacity-50"
        >
          Used it at these terms
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => onUsed({ detailsOnly: true })}
          className="flex-1 rounded-lg bg-raised py-1.5 text-[12px] font-medium text-slate-300 disabled:opacity-50"
        >
          Used elsewhere
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onRemove}
          className="rounded-lg bg-rose-500/10 px-3 py-1.5 text-[12px] font-medium text-rose-300 ring-1 ring-inset ring-rose-500/25 disabled:opacity-50"
        >
          Remove
        </button>
      </div>
    </div>
  );
}
