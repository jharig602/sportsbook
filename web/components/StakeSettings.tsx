"use client";

import { useEffect, useState } from "react";

import {
  DEFAULT_SETTINGS,
  formatMoney,
  loadSettings,
  saveSettings,
  type StakeSettings as Settings,
} from "@/lib/staking";

export const SETTINGS_CHANGED = "line-tracker:staking-changed";

/** Shared hook so every stake badge reacts to a settings change without a reload. */
export function useStakeSettings(): Settings {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    const refresh = () => setSettings(loadSettings());
    refresh();
    window.addEventListener(SETTINGS_CHANGED, refresh);
    // `storage` fires for other tabs, so a change on one stays consistent across them.
    window.addEventListener("storage", refresh);
    return () => {
      window.removeEventListener(SETTINGS_CHANGED, refresh);
      window.removeEventListener("storage", refresh);
    };
  }, []);

  return settings;
}

export function StakeSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);
  const [saved, setSaved] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setSettings(loadSettings());
    setReady(true);
  }, []);

  function update(patch: Partial<Settings>) {
    setSettings((current) => ({ ...current, ...patch }));
    setSaved(false);
  }

  function commit() {
    saveSettings(settings);
    window.dispatchEvent(new Event(SETTINGS_CHANGED));
    setSaved(true);
  }

  if (!ready) return <p className="text-sm text-slate-500">Loading&hellip;</p>;

  const unit = settings.bankroll * settings.unitFraction;
  const cap = settings.bankroll * settings.maxFraction;

  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-200">Stake sizing</h2>
      <p className="mt-1 text-xs leading-relaxed text-slate-500">
        Stored on this device only. Your bankroll is never sent to a server, never leaves
        the browser, and is not in the code or the repository.
      </p>

      <div className="mt-3 grid grid-cols-2 gap-3">
        <label className="block">
          <span className="text-xs text-slate-400">Bankroll</span>
          <input
            type="number"
            inputMode="decimal"
            min={0}
            step={10}
            value={settings.bankroll || ""}
            placeholder="0"
            onChange={(e) => update({ bankroll: Math.max(0, Number(e.target.value) || 0) })}
            className="tabular mt-1 w-full rounded-lg border border-edge bg-ink px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-600"
          />
        </label>

        <label className="block">
          <span className="text-xs text-slate-400">Unit (% of bankroll)</span>
          <input
            type="number"
            inputMode="decimal"
            min={0.1}
            max={10}
            step={0.25}
            value={+(settings.unitFraction * 100).toFixed(2)}
            onChange={(e) =>
              update({
                unitFraction: Math.min(0.1, Math.max(0.001, Number(e.target.value) / 100 || 0.01)),
              })
            }
            className="tabular mt-1 w-full rounded-lg border border-edge bg-ink px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-600"
          />
        </label>

        <label className="block">
          <span className="text-xs text-slate-400">Max per bet (%)</span>
          <input
            type="number"
            inputMode="decimal"
            min={0.5}
            max={25}
            step={0.5}
            value={+(settings.maxFraction * 100).toFixed(2)}
            onChange={(e) =>
              update({
                maxFraction: Math.min(0.25, Math.max(0.005, Number(e.target.value) / 100 || 0.03)),
              })
            }
            className="tabular mt-1 w-full rounded-lg border border-edge bg-ink px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-600"
          />
        </label>

        <label className="block">
          <span className="text-xs text-slate-400">Kelly fraction</span>
          <select
            value={settings.kellyFraction}
            onChange={(e) => update({ kellyFraction: Number(e.target.value) })}
            className="mt-1 w-full rounded-lg border border-edge bg-ink px-2 py-1.5 text-sm text-slate-100 outline-none focus:border-sky-600"
          >
            <option value={0.125}>Eighth</option>
            <option value={0.25}>Quarter</option>
            <option value={0.5}>Half</option>
          </select>
        </label>
      </div>

      <div className="mt-3 flex items-center gap-3">
        <button
          onClick={commit}
          className="rounded-lg bg-sky-500/15 px-3 py-1.5 text-sm font-medium text-sky-300 ring-1 ring-inset ring-sky-500/30 transition-colors hover:bg-sky-500/25"
        >
          Save
        </button>
        {saved ? <span className="text-xs text-emerald-300/90">Saved</span> : null}
      </div>

      {settings.bankroll > 0 ? (
        <p className="tabular mt-3 text-xs text-slate-500">
          1 unit = {formatMoney(unit)} &middot; hard cap {formatMoney(cap)} per bet
        </p>
      ) : null}

      <p className="mt-3 text-xs leading-relaxed text-slate-500">
        A guide for sizing any bet: one unit is your normal stake, and the hard cap is
        the most any single bet should be. The app only sizes stakes for you on the
        Movers page; for the bet of the day and your boosts, the cap above is the number
        to stay under. Sizing up on an unproven signal loses money faster than flat
        betting, not slower.
      </p>
    </div>
  );
}
