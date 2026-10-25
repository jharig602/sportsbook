"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import type { ConnectorStatus } from "@/lib/oauth-db";

/**
 * The Claude connector in Settings: the address to paste into Claude, whether it is
 * connected, and a button that cuts it off. Disconnecting revokes every token at once;
 * Claude has to be approved again on the next use.
 */
export function ConnectorSettings({ status, url }: { status: ConnectorStatus; url: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setMessage("Copy failed; select the address and copy it by hand.");
    }
  }

  async function disconnect() {
    setBusy(true);
    setMessage(null);
    const response = await fetch("/api/connector", { method: "DELETE" });
    setBusy(false);
    if (!response.ok) {
      setMessage("Could not disconnect. Try again.");
      return;
    }
    setMessage("Disconnected. Claude must be approved again before it reads anything.");
    router.refresh();
  }

  const connected = status.connections > 0;
  return (
    <div>
      <h2 className="text-sm font-semibold text-slate-200">Claude connector</h2>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        Lets Claude read Dissent from your chats: the shop, boost and bonus finders, game
        pages, open bets, record, promos and survivor. Read-only. In claude.ai on a computer:
        Settings, Connectors, Add custom connector, paste this address, then approve here.
      </p>
      <div className="mt-2 flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded border border-edge bg-slate-900/60 px-2 py-1 text-[11px] text-slate-300">
          {url}
        </code>
        <button type="button" onClick={copy} className="shrink-0 rounded border border-edge px-2 py-1 text-[11px] text-slate-300">
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="mt-2 text-[11px] text-slate-400">
        {connected
          ? `Connected (${status.connections} sign-in${status.connections === 1 ? "" : "s"}).`
          : "Not connected."}
        {status.lastCall ? ` Last used ${new Date(status.lastCall).toLocaleString()}; ${status.callsToday} call${status.callsToday === 1 ? "" : "s"} in the last day.` : ""}
      </p>
      {connected ? (
        <button
          type="button"
          disabled={busy}
          onClick={disconnect}
          className="mt-2 rounded border border-rose-700/60 px-2.5 py-1 text-[11px] text-rose-300 disabled:opacity-40"
        >
          Disconnect Claude
        </button>
      ) : null}
      {message ? <p className="mt-1.5 text-[11px] text-slate-400">{message}</p> : null}
    </div>
  );
}
