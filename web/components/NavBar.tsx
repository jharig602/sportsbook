"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

type Tab = { href: string; label: string; icon: React.ReactNode };

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
    href: "/movers",
    label: "Movers",
    icon: (
      <>
        <path d="M3 17l5-5 4 3 8-9" {...stroke} />
        <path d="M15 6h5v5" {...stroke} />
      </>
    ),
  },
  {
    href: "/edges",
    label: "Edges",
    icon: (
      <>
        <path d="M12 3v18M5 8l7-5 7 5" {...stroke} />
        <path d="M4 14h16" {...stroke} />
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

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-edge/70 bg-ink/90 backdrop-blur-xl">
      <ul className="mx-auto flex w-full max-w-3xl">
        {TABS.map((tab) => {
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-1 pb-1.5 pt-2 transition-colors ${
                  active ? "text-accent" : "text-slate-500"
                }`}
              >
                <svg viewBox="0 0 24 24" className="h-[22px] w-[22px]" aria-hidden="true">
                  {tab.icon}
                </svg>
                <span className="text-[10px] font-medium tracking-wide">{tab.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
