import Link from "next/link";

export function AppHeader() {
  return (
    <header className="safe-top sticky top-0 z-20 border-b border-edge/70 bg-ink/80 backdrop-blur-xl">
      <div className="mx-auto flex h-12 w-full max-w-3xl items-center gap-2 px-3">
        <Link href="/" className="flex items-center gap-2">
          <svg
            viewBox="0 0 24 24"
            className="h-5 w-5 text-accent"
            fill="none"
            aria-hidden="true"
          >
            <path
              d="M3 17l5-4 4 2 5-8 4 3"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="17" cy="7" r="2" fill="currentColor" />
          </svg>
          <span className="text-[15px] font-semibold tracking-tight text-slate-100">
            Line Tracker
          </span>
        </Link>
        <span className="ml-auto rounded-full bg-raised px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-slate-500">
          DraftKings
        </span>
      </div>
    </header>
  );
}
