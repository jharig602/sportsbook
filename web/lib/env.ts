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

export function databaseUrl(): string | null {
  for (const name of DATABASE_URL_VARS) {
    const value = process.env[name];
    if (value && value.trim()) return value.trim();
  }
  return null;
}

/** Which variable supplied the URL, for the diagnostics line on the Board. */
export function databaseUrlSource(): string | null {
  for (const name of DATABASE_URL_VARS) {
    const value = process.env[name];
    if (value && value.trim()) return name;
  }
  return null;
}

/** True when the URL routes through a connection pooler. */
export function isPooled(url: string | null): boolean {
  return url !== null && url.includes("-pooler.");
}
