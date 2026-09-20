import { AddPromo } from "@/components/AddPromo";
import { PromoList } from "@/components/PromoList";
import { Banner, NotAdvice, PageHeader } from "@/components/ui";
import { databaseUrl } from "@/lib/env";
import { listPromos } from "@/lib/promos-db";
import { currentSession } from "@/lib/session";
import type { Promo } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Live promo tokens, soonest to expire first.
 *
 * The dashboard is the feature. The calculators under each row are useful, but what
 * actually costs money is a token quietly reaching its expiry unused, or a refunded
 * bonus bet sitting in an account until it lapses — and neither of those is a question
 * about which side to take.
 */
export default async function PromosPage() {
  const session = await currentSession();

  let promos: Promo[] = [];
  let loadError: string | null = null;
  if (!session.ownerId) {
    loadError = "No ledger is attached to this session, so there is nothing to show.";
  } else if (databaseUrl()) {
    try {
      promos = await listPromos(session.ownerId);
    } catch (error) {
      loadError = error instanceof Error ? error.message : String(error);
    }
  } else {
    loadError = "No database configured, so promos cannot be stored or read.";
  }

  return (
    <>
      <PageHeader
        title="Promos"
        subtitle="What each token is worth, and when it dies"
      />

      {loadError ? <Banner tone="error">{loadError}</Banner> : null}

      <AddPromo recent={promos} />
      {/*
        The clock is taken once on the server and passed down, so every row counts from
        the same moment. Letting each row read its own would make the ordering and the
        colours disagree during a re-render.
      */}
      <PromoList promos={promos} now={new Date().toISOString()} />

      <p className="mt-3 text-[11px] leading-relaxed text-slate-600">
        Terms are typed in rather than read from your account: they sit behind a login
        with no public feed, and scraping a book where you hold an account risks the
        account. Thirty seconds a few times a week is the cheaper trade.
      </p>
      <NotAdvice className="mt-6" />
    </>
  );
}
