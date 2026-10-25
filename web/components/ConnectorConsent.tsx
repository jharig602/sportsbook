"use client";

import { useState } from "react";

/**
 * Approve or deny the Claude connector. Posts the request back to the server, which
 * validates it again and answers with where to send the browser.
 */
export function ConnectorConsent({ params }: { params: Record<string, string> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logging, setLogging] = useState(true);

  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/oauth/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...params, decision, allow_logging: logging }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || typeof body.redirect !== "string") {
      setBusy(false);
      setError(body.error ?? "Could not finish. Start again from Claude.");
      return;
    }
    window.location.assign(body.redirect);
  }

  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <label className="mb-1 flex w-full items-start gap-2 text-[12px] leading-relaxed text-slate-300">
        <input
          type="checkbox"
          checked={logging}
          onChange={(e) => setLogging(e.target.checked)}
          className="mt-0.5"
        />
        <span>
          Also let Claude log bets, cash-outs, promo use and my survivor sheet for me. It shows
          each one first and saves only after I say yes.
        </span>
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() => decide("approve")}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
      >
        Allow
      </button>
      <button
        type="button"
        disabled={busy}
        onClick={() => decide("deny")}
        className="rounded-lg border border-edge px-4 py-2 text-[13px] text-slate-300 disabled:opacity-40"
      >
        Deny
      </button>
      {error ? <p className="w-full text-[12px] text-rose-300">{error}</p> : null}
    </div>
  );
}
