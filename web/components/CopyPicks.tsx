"use client";

import { useState } from "react";

/**
 * Copies the confidence card as plain text, ready to paste into a text or an email:
 * one "points  team" line per game, best first, then the tiebreaker.
 */
export function CopyPicks({ text }: { text: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setStatus("copied");
    } catch {
      // Older phones and non-secure contexts: fall back to a selected textarea.
      const area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(area);
      setStatus(ok ? "copied" : "failed");
    }
    setTimeout(() => setStatus("idle"), 2500);
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="mb-3 w-full rounded-md border border-sky-700/60 bg-sky-500/10 py-2 text-[13px] font-medium text-sky-100"
    >
      {status === "copied" ? "Copied — paste it into your text or email" : status === "failed" ? "Could not copy" : "Copy picks"}
    </button>
  );
}
