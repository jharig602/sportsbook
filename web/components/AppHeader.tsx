import Link from "next/link";

import type { Role } from "@/lib/unlock";

export function AppHeader({ role }: { role: Role }) {
  // Read at render. When no passcode is configured the app is reachable by anyone who
  // finds the URL, and /api/book-lines accepts a quote that joins the consensus every
  // edge is measured against. Failing open is defensible; failing open QUIETLY is not.
  const unprotected = !process.env.APP_PASSCODE;

  return (
    <header className="safe-top sticky top-0 z-20 border-b border-edge/70 bg-ink/80 backdrop-blur-xl">
      <div className="mx-auto flex h-12 w-full max-w-3xl items-center gap-2 px-3">
        <Link href="/" className="flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5 text-accent"
            aria-hidden="true"
          >
            {/* Four books agreeing, one out of line. Same mark as the app icon. */}
            <g fill="currentColor" opacity="0.45">
              <rect x="3" y="4" width="11" height="2" rx="1" />
              <rect x="3" y="7.5" width="11" height="2" rx="1" />
              <rect x="3" y="14.5" width="11" height="2" rx="1" />
              <rect x="3" y="18" width="11" height="2" rx="1" />
            </g>
            <rect x="7" y="11" width="11" height="2" rx="1" fill="currentColor" />
          </svg>
          <span className="text-[15px] font-semibold tracking-tight text-slate-100">
            Dissent
          </span>
        </Link>
        {role === "viewer" ? (
          <span className="ml-auto rounded-full bg-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
            read only
          </span>
        ) : unprotected ? (
          <span
            className="ml-auto rounded-full bg-rose-500/15 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-rose-300"
            title="Set APP_PASSCODE in Vercel to require a passcode."
          >
            unlocked
          </span>
        ) : (
          <span className="ml-auto rounded-full bg-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
            DraftKings
          </span>
        )}
      </div>
    </header>
  );
}
