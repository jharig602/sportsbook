/**
 * Where the database URL comes from.
 *
 * Set by hand it is `DATABASE_URL`. Provisioned through the Vercel Neon integration it
 * may arrive as `POSTGRES_URL` instead, depending on the integration version. Accepting
 * only one name means the other silently falls back to the bundled fixture and serves
 * stale data that looks perfectly healthy — the worst kind of failure, because nothing
 * appears broken.
 *
 * The unpooled variants are deliberately last: serverless functions open and drop
 * connections constantly, which is exactly what the pooler exists to absorb.
 */
export const DATABASE_URL_VARS = [
  "DATABASE_URL",
  "POSTGRES_URL",
  "POSTGRES_PRISMA_URL",
  "DATABASE_URL_UNPOOLED",
  "POSTGRES_URL_NON_POOLING",
] as const;

function isPostgresUrl(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    /^postgres(ql)?:\/\//.test(value.trim())
  );
}

/**
 * Any prefixed variant, e.g. NEON_DATABASE_URL or STORAGE_POSTGRES_URL.
 *
 * The Vercel storage integrations ask for a prefix when the unprefixed name is already
 * taken, so the variable can end up called almost anything. Matching on the suffix
 * means the app keeps working whatever prefix was chosen, rather than falling back to
 * the fixture and quietly serving stale prices.
 *
 * Pooled candidates win: serverless functions churn connections, which is what the
 * pooler absorbs. Sorted for determinism when several match.
 */
function prefixedCandidates(): string[] {
  return Object.keys(process.env)
    .filter(
      (name) =>
        /(DATABASE_URL|POSTGRES_URL)$/.test(name) &&
        !DATABASE_URL_VARS.includes(name as (typeof DATABASE_URL_VARS)[number]) &&
        isPostgresUrl(process.env[name]),
    )
    .sort((a, b) => {
      const pooled = (name: string) => (isPooled(process.env[name] ?? null) ? 0 : 1);
      return pooled(a) - pooled(b) || a.localeCompare(b);
    });
}

function resolve(): { name: string; url: string } | null {
  for (const name of DATABASE_URL_VARS) {
    const value = process.env[name];
    if (value && value.trim()) return { name, url: value.trim() };
  }
  const [fallback] = prefixedCandidates();
  return fallback ? { name: fallback, url: process.env[fallback]!.trim() } : null;
}

export function databaseUrl(): string | null {
  return resolve()?.url ?? null;
}

/** Which variable supplied the URL, for the diagnostics line on the Board. */
export function databaseUrlSource(): string | null {
  return resolve()?.name ?? null;
}

/** True when the URL routes through a connection pooler. */
export function isPooled(url: string | null): boolean {
  return url !== null && url.includes("-pooler.");
}
