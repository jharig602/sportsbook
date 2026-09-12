"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Card } from "./ui";

/**
 * Moving a ledger between devices.
 *
 * Only shown to guests, because the owner's ledger already moves with the passcode and
 * offering a second, weaker way into it would be a downgrade dressed as a feature.
 *
 * The panel is deliberately explicit about what a guest ledger actually is: a random
 * identifier in a cookie, with no name or password attached, which is what lets someone
 * keep a season's record here without handing over anything. The flip side is that the
 * cookie IS the ledger, so clearing site data on every device ends it — and saying so
 * plainly is the only honest way to ship this. A record that quietly disappears looks
 * exactly like a record that was never kept, which is the failure this whole app is
 * organised against.
 */
export function LedgerTransfer({ bets }: { bets: number }) {
  const router = useRouter();
  const [code, setCode] = useState<string | null>(null);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [claimed, setClaimed] = useState<number | null>(null);

  async function makeCode() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ledger/transfer", { method: "POST" });
      const body = await response.json();
      if (!response.ok) setError(body.error ?? "Could not make a code.");
      else setCode(body.code as string);
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  async function claim() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/ledger/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: typed }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.error ?? "Could not use that code.");
      } else {
        setClaimed(body.bets as number);
        setTyped("");
        // The page was rendered against the old identifier; the cookie has changed
        // underneath it. Without this the ledger it shows is the one just replaced.
        router.refresh();
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="space-y-3">
      <div>
        <h2 className="text-sm font-semibold text-slate-200">This ledger</h2>
        <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
          {bets === 0
            ? "Nothing logged yet. "
            : `${bets} ${bets === 1 ? "bet" : "bets"} kept against this browser. `}
          There is no account behind it — just an anonymous id in a cookie, which is why
          nothing was asked of you to start one. It also means clearing site data
          everywhere ends it, so move it across before you do.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={makeCode}
          disabled={busy}
          className="rounded-lg bg-raised px-3 py-1.5 text-[11px] font-medium text-slate-200 disabled:opacity-50"
        >
          Use on another device
        </button>
        {code ? (
          <span className="font-mono text-base font-semibold tracking-[0.2em] text-accent">
            {code}
          </span>
        ) : null}
      </div>
      {code ? (
        <p className="text-[11px] text-slate-500">
          Type it on the other device within fifteen minutes. It works once, and both
          devices then share these bets.
        </p>
      ) : null}

      <div className="flex flex-wrap items-center gap-2 border-t border-edge/70 pt-3">
        <input
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          placeholder="Code from another device"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-edge bg-ink px-3 py-1.5 font-mono text-[13px] uppercase tracking-widest text-slate-200 placeholder:font-sans placeholder:tracking-normal placeholder:text-slate-600"
        />
        <button
          type="button"
          onClick={claim}
          disabled={busy || typed.trim() === ""}
          className="rounded-lg bg-raised px-3 py-1.5 text-[11px] font-medium text-slate-200 disabled:opacity-50"
        >
          Bring it here
        </button>
      </div>

      {claimed !== null ? (
        <p className="text-[11px] text-emerald-300">
          Done — {claimed} {claimed === 1 ? "bet" : "bets"} now open on this device.
          {bets > 0 ? " The ledger that was here is not deleted, but nothing on this device points at it any more." : ""}
        </p>
      ) : null}
      {error ? <p className="text-[11px] text-rose-300">{error}</p> : null}
    </Card>
  );
}
