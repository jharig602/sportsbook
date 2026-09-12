"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { href: string; label: string; icon: React.ReactNode };

import { viewerAllowed, type Role } from "@/lib/unlock";

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.75,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

const TABS: Tab[] = [
  {
    href: "/",
    label: "Board",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" {...stroke} />
        <path d="M3 9h18M9 9v11" {...stroke} />
      </>
    ),
  },
  {
    // Shop takes the slot Edges used to hold, and Movers has since given up its own.
    //
    // The rule that decides this bar: a tab is for what you open daily to act on.
    // Edges asks whether one book agrees with itself, which is structurally zero on
    // 8,357 games. Movers reports unusual line movement, which is still detected and
    // still graded on the Track Record -- but it stopped notifying for a reason, and
    // something you deliberately muted should not hold a permanent slot in front of
    // the lists you act on. Both are linked from Shop and Settings instead.
    href: "/shop",
    label: "Shop",
    icon: (
      <>
        <path d="M4 7h16l-1.2 12.2a2 2 0 0 1-2 1.8H7.2a2 2 0 0 1-2-1.8Z" {...stroke} />
        <path d="M9 7V5a3 3 0 0 1 6 0v2" {...stroke} />
      </>
    ),
  },
  {
    href: "/survivor",
    label: "Survivor",
    icon: (
      <>
        <path d="M12 3l7 3v5c0 4.2-2.8 7.6-7 10-4.2-2.4-7-5.8-7-10V6Z" {...stroke} />
        <path d="M9 12l2 2 4-4" {...stroke} />
      </>
    ),
  },
  {
    href: "/bets",
    label: "Bets",
    icon: (
      <>
        <rect x="3" y="6" width="18" height="12" rx="2" {...stroke} />
        <circle cx="12" cy="12" r="2.5" {...stroke} />
      </>
    ),
  },
  {
    href: "/record",
    label: "Record",
    icon: (
      <>
        <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" {...stroke} />
      </>
    ),
  },
  {
    href: "/about",
    label: "Settings",
    icon: (
      <>
        <circle cx="12" cy="12" r="3" {...stroke} />
        <path
          d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 007.9 19a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H2a2 2 0 110-4h.1A1.7 1.7 0 004.6 8a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V2a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H22a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z"
          {...stroke}
        />
      </>
    ),
  },
];

export function NavBar({ role }: { role: Role }) {
  const pathname = usePathname();
  // A viewer is shown only what they can open. Rendering a tab that bounces them back
  // to the board would read as a broken app rather than a deliberate boundary.
  const tabs = role === "viewer" ? TABS.filter((t) => viewerAllowed(t.href)) : TABS;

  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-edge/60 bg-ink/80 backdrop-blur-2xl">
      <ul className="mx-auto flex w-full max-w-3xl px-1">
        {tabs.map((tab) => {
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className="group relative flex flex-col items-center gap-[3px] pb-2 pt-2.5"
              >
                {/* The active marker sits above the icon rather than under the label:
                    the label is the first thing a thumb covers. */}
                <span
                  aria-hidden="true"
                  className={`absolute top-0 h-[2px] w-7 rounded-full transition-all duration-200 ${
                    active ? "bg-accent opacity-100" : "opacity-0"
                  }`}
                />
                <svg
                  viewBox="0 0 24 24"
                  className={`h-[23px] w-[23px] transition-colors duration-150 ${
                    active ? "text-accent" : "text-slate-500 group-active:text-slate-300"
                  }`}
                  aria-hidden="true"
                >
                  {tab.icon}
                </svg>
                <span
                  className={`text-[10px] tracking-wide transition-colors duration-150 ${
                    active ? "font-semibold text-accent" : "font-medium text-slate-500"
                  }`}
                >
                  {tab.label}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
