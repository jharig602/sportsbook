"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Board" },
  { href: "/movers", label: "Movers" },
  { href: "/record", label: "Record" },
  { href: "/about", label: "About" },
];

export function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-20 border-t border-edge bg-ink/95 backdrop-blur safe-bottom">
      <ul className="mx-auto flex w-full max-w-3xl">
        {TABS.map((tab) => {
          const active =
            tab.href === "/" ? pathname === "/" : pathname.startsWith(tab.href);
          return (
            <li key={tab.href} className="flex-1">
              <Link
                href={tab.href}
                aria-current={active ? "page" : undefined}
                className={`flex flex-col items-center gap-1 py-3 text-xs font-medium transition-colors ${
                  active ? "text-sky-300" : "text-slate-500 hover:text-slate-300"
                }`}
              >
                <span
                  className={`h-0.5 w-6 rounded-full ${
                    active ? "bg-sky-400" : "bg-transparent"
                  }`}
                />
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
