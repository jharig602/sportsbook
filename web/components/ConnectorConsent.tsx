"use client";

import { useState } from "react";

/**
 * Approve or deny the Claude connector. Posts the request back to the server, which
 * validates it again and answers with where to send the browser.
 */
export function ConnectorConsent({ params }: { params: Record<string, string> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(decision: "approve" | "deny") {
    setBusy(true);
    setError(null);
    const response = await fetch("/api/oauth/approve", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...params, decision }),
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
      <button
        type="button"
        disabled={busy}
        onClick={() => decide("approve")}
        className="rounded-lg bg-emerald-600 px-4 py-2 text-[13px] font-medium text-white disabled:opacity-40"
      >
        Allow read-only access
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
