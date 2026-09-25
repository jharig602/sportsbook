/**
 * Slowing down anyone guessing the passcode.
 *
 * The passcode is the only thing between the internet and this app, and until this
 * existed nothing limited how fast it could be guessed. A serverless function answers as
 * fast as it is asked, so a short passcode was a matter of minutes.
 *
 * Two limits, because each alone has a hole:
 *
 * - **Per source** -- ten wrong guesses in fifteen minutes from one address locks that
 *   address out. Stops the simple attack cold.
 * - **Across everyone** -- a hundred wrong guesses in an hour locks out new logins from
 *   anywhere. An attacker spreading guesses over many addresses walks straight past a
 *   per-source limit; this is what stops them.
 *
 * The global limit sounds like it could lock you out of your own app, and for fresh
 * logins during an attack, it can. That is the right trade here, and cheaper than it
 * looks: your phone holds a year-long cookie, the middleware checks the cookie, and the
 * cookie never touches this route. The only thing an attacker can block is a NEW login,
 * which you make about once a year, and only while they are actively attacking.
 *
 * What this does not do is make a weak passcode strong. At these limits an attacker gets
 * at most 2,400 guesses a day across every address they control. A four-digit PIN falls
 * in about two days; a six-digit one in over half a year; twelve random characters, never.
 * The limit buys time. The passcode's length decides whether that time is enough.
 */

export const PER_SOURCE_LIMIT = 10;
export const PER_SOURCE_WINDOW_MINUTES = 15;
export const GLOBAL_LIMIT = 100;
export const GLOBAL_WINDOW_MINUTES = 60;

export interface Failure {
  sourceHash: string;
  at: Date;
}

export interface Lockout {
  locked: boolean;
  scope: "source" | "global" | null;
  /** Seconds until the oldest failure in the binding window ages out. */
  retryAfterSeconds: number;
}

/**
 * Whether this source may try at all.
 *
 * Checked BEFORE the passcode is compared, not after. A locked source that still had its
 * guess evaluated could keep learning from successes -- the limit has to stop the
 * guessing, not just the reporting of it.
 */
export function lockoutFor(failures: Failure[], sourceHash: string, now: Date): Lockout {
  const within = (minutes: number) => (f: Failure) =>
    now.getTime() - f.at.getTime() < minutes * 60_000;

  const retryAfter = (list: Failure[], minutes: number) => {
    const oldest = Math.min(...list.map((f) => f.at.getTime()));
    return Math.max(1, Math.ceil((oldest + minutes * 60_000 - now.getTime()) / 1000));
  };

  const mine = failures.filter((f) => f.sourceHash === sourceHash).filter(within(PER_SOURCE_WINDOW_MINUTES));
  if (mine.length >= PER_SOURCE_LIMIT) {
    return { locked: true, scope: "source", retryAfterSeconds: retryAfter(mine, PER_SOURCE_WINDOW_MINUTES) };
  }

  const everyone = failures.filter(within(GLOBAL_WINDOW_MINUTES));
  if (everyone.length >= GLOBAL_LIMIT) {
    return { locked: true, scope: "global", retryAfterSeconds: retryAfter(everyone, GLOBAL_WINDOW_MINUTES) };
  }

  return { locked: false, scope: null, retryAfterSeconds: 0 };
}

/**
 * The address a request came from, as the platform reports it.
 *
 * Vercel's own headers first, because Vercel sets them and a client cannot. The plain
 * `x-forwarded-for` is a fallback only, and its FIRST entry is taken. If nothing is
 * present every such request shares one bucket, which is conservative in the right
 * direction: an attacker hiding their address locks themselves out faster, not slower.
 *
 * Even if some header here could be spoofed, the global limit does not depend on it.
 */
export function sourceOf(headers: Headers): string {
  const first = (value: string | null) => value?.split(",")[0]?.trim() || null;
  return (
    first(headers.get("x-vercel-forwarded-for")) ??
    first(headers.get("x-real-ip")) ??
    first(headers.get("x-forwarded-for")) ??
    "unknown"
  );
}

/** A SHA-256 of the address. The address itself is never stored. */
export async function hashSource(source: string): Promise<string> {
  const bytes = new TextEncoder().encode(`unlock-source:${source}`);
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** How long, in words, for the message shown on the unlock screen. */
export function waitText(seconds: number): string {
  if (seconds < 90) return "a minute";
  return `${Math.ceil(seconds / 60)} minutes`;
}
