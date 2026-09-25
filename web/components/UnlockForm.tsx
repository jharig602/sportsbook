"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function UnlockForm({ next }: { next: string }) {
  const router = useRouter();
  const [passcode, setPasscode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/unlock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ passcode }),
      });
      if (!response.ok) {
        // The server's own words: "Too many attempts, try again in 5 minutes" must not
        // be flattened into "Incorrect passcode", or a locked-out owner keeps typing the
        // right passcode into a wall and concludes it has changed.
        const body = await response.json().catch(() => null);
        setError(typeof body?.error === "string" ? body.error : "Incorrect passcode.");
        return;
      }
      // A full navigation, so the new cookie is attached to the next request.
      window.location.href = next;
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="mt-5">
      <input
        type="password"
        inputMode="text"
        autoFocus
        autoComplete="current-password"
        value={passcode}
        onChange={(e) => setPasscode(e.target.value)}
        className="w-full rounded-lg border border-edge bg-surface px-3 py-2.5 text-[15px] text-slate-100 outline-none focus:border-sky-600"
        placeholder="Passcode"
      />
      {error ? <p className="mt-2 text-[12px] text-rose-300">{error}</p> : null}
      <button
        type="submit"
        disabled={busy || passcode.length === 0}
        className="mt-3 w-full rounded-lg bg-accent/15 py-2.5 text-[14px] font-medium text-accent ring-1 ring-inset ring-accent/30 disabled:opacity-40"
      >
        {busy ? "Checking…" : "Unlock"}
      </button>
    </form>
  );
}
