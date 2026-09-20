"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { PromoType } from "@/lib/promo-ev";
import type { Promo } from "@/lib/types";

const TYPES: Array<{ key: PromoType; label: string; hint: string }> = [
  { key: "stake_back", label: "Stake back", hint: "Lose and the stake returns as bonus bets" },
  { key: "profit_boost", label: "Profit boost", hint: "A percentage added to winnings" },
  { key: "odds_boost", label: "Odds boost", hint: "One market at an enhanced price" },
  { key: "bonus_bet", label: "Bonus bet", hint: "Stake is not returned on a win" },
  { key: "deposit_match", label: "Deposit match", hint: "Bonus with a rollover requirement" },
];

const FIELD =
  "mt-0.5 w-full rounded border border-edge bg-ink px-2 py-1 text-[12px] text-slate-100 outline-none focus:border-sky-600";

/**
 * One labelled input.
 *
 * Defined here rather than inside the form: a component created during render is a new
 * component type on every keystroke, so React unmounts the old one and the input loses
 * focus after each character.
 */
function Text({
  name,
  label,
  placeholder,
  values,
  onSet,
}: {
  name: string;
  label: string;
  placeholder?: string;
  values: Record<string, string>;
  onSet: (key: string, value: string) => void;
}) {
  return (
    <label className="block">
      <span className="text-[10px] uppercase tracking-wide text-slate-500">{label}</span>
      <input
        value={values[name] ?? ""}
        placeholder={placeholder}
        onChange={(e) => onSet(name, e.target.value)}
        className={FIELD}
      />
    </label>
  );
}

/**
 * Terms entry.
 *
 * Type first, then only the fields that type needs: a form showing every field for every
 * promo is a form nobody finishes in thirty seconds, which is the whole case for typing
 * these in rather than trying to scrape them.
 *
 * Nothing is prefilled except when duplicating a previous promo. A wrong default here is
 * worse than a blank: it changes what the promo is worth and reads exactly like a term
 * that was actually on the screen.
 */
export function AddPromo({ recent }: { recent: Promo[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<PromoType | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const set = (key: string, value: string) => setValues((v) => ({ ...v, [key]: value }));

  function duplicate(promo: Promo) {
    setType(promo.type);
    setValues({
      book: promo.book,
      title: promo.title,
      cap_refund: promo.cap_refund?.toString() ?? "",
      max_stake: promo.max_stake?.toString() ?? "",
      boost_pct: promo.boost_pct?.toString() ?? "",
      bonus_face: promo.bonus_face?.toString() ?? "",
      boosted_price: promo.boosted_price?.toString() ?? "",
      deposit_bonus: promo.deposit_bonus?.toString() ?? "",
      rollover_multiple: promo.rollover_multiple?.toString() ?? "",
      min_odds_american: promo.min_odds_american?.toString() ?? "",
      min_legs: promo.min_legs?.toString() ?? "",
      // Deliberately not copied: last week's expiry is the one term that is certainly
      // wrong this week, and a stale one would quietly drop the token off the dashboard.
      expires_at: "",
    });
    setOpen(true);
  }

  async function save() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch("/api/promos", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...values,
          type,
          eligible_markets: (values.eligible_markets ?? "")
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setMessage(body.error ?? "Could not save.");
      } else {
        setOpen(false);
        setType(null);
        setValues({});
        router.refresh();
      }
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }


  if (!open) {
    return (
      <div className="mb-3 flex gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex-1 rounded-xl border border-edge bg-surface py-2.5 text-[13px] font-medium text-slate-300"
        >
          Add a promo
        </button>
        {recent.length > 0 ? (
          <button
            type="button"
            onClick={() => duplicate(recent[0])}
            className="rounded-xl border border-edge bg-surface px-3 py-2.5 text-[13px] text-slate-400"
            title={`Duplicate: ${recent[0].title}`}
          >
            Duplicate last
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <div className="mb-3 rounded-xl border border-edge bg-surface px-3.5 py-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">Add a promo</h2>
        <button type="button" onClick={() => setOpen(false)} className="text-[11px] text-slate-500">
          close
        </button>
      </div>

      {type === null ? (
        <ul className="mt-2 space-y-1">
          {TYPES.map((t) => (
            <li key={t.key}>
              <button
                type="button"
                onClick={() => setType(t.key)}
                className="w-full rounded-lg bg-raised/60 px-2.5 py-2 text-left"
              >
                <span className="block text-[13px] text-slate-200">{t.label}</span>
                <span className="block text-[11px] text-slate-500">{t.hint}</span>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <>
          <button
            type="button"
            onClick={() => setType(null)}
            className="mt-1 text-[11px] text-sky-300 underline underline-offset-2"
          >
            {TYPES.find((t) => t.key === type)!.label} — change
          </button>

          <div className="mt-2 grid grid-cols-2 gap-2">
            <Text name="book" label="Book" placeholder="FanDuel" values={values} onSet={set} />
            <Text name="title" label="Title" placeholder="as the app words it" values={values} onSet={set} />
            <label className="col-span-2 block">
              <span className="text-[10px] uppercase tracking-wide text-slate-500">
                Expires (required)
              </span>
              <input
                type="datetime-local"
                value={values.expires_at ?? ""}
                onChange={(e) => set("expires_at", e.target.value)}
                className={FIELD}
              />
            </label>

            {type === "stake_back" ? <Text name="cap_refund" label="Refund cap" placeholder="25" values={values} onSet={set} /> : null}
            {type === "profit_boost" ? (
              <>
                <Text name="boost_pct" label="Boost (0.5 = 50%)" placeholder="0.5" values={values} onSet={set} />
                <Text name="max_stake" label="Max stake" placeholder="25" values={values} onSet={set} />
                <Text name="min_legs" label="Min legs" placeholder="3" values={values} onSet={set} />
              </>
            ) : null}
            {type === "odds_boost" ? (
              <>
                <Text name="boosted_price" label="Boosted price" placeholder="+400" values={values} onSet={set} />
                <Text name="base_price" label="Price elsewhere" placeholder="+350" values={values} onSet={set} />
                <Text name="max_stake" label="Max stake" placeholder="25" values={values} onSet={set} />
              </>
            ) : null}
            {type === "bonus_bet" ? <Text name="bonus_face" label="Face value" placeholder="50" values={values} onSet={set} /> : null}
            {type === "deposit_match" ? (
              <>
                <Text name="deposit_bonus" label="Bonus amount" placeholder="1000" values={values} onSet={set} />
                <Text name="rollover_multiple" label="Rollover (x)" placeholder="10" values={values} onSet={set} />
              </>
            ) : null}

            <Text name="min_odds_american" label="Min odds" placeholder="-200" values={values} onSet={set} />
            <Text name="eligible_markets" label="Eligible (comma separated)" placeholder="NFL moneyline" values={values} onSet={set} />
          </div>

          <button
            type="button"
            onClick={save}
            disabled={busy}
            className="mt-2.5 w-full rounded-lg bg-sky-500/15 py-2 text-[13px] font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save promo"}
          </button>
          {message ? <p className="mt-1.5 text-[11px] text-rose-300">{message}</p> : null}
        </>
      )}
    </div>
  );
}
