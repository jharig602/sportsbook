import { AddPromo } from "@/components/AddPromo";
import { BoostFinder } from "@/components/BoostFinder";
import { DEFAULT_MAX_SPREAD } from "@/lib/blowout";
import { allBookLines } from "@/lib/book-lines";
import { findBoosts } from "@/lib/boost-finder";
import { getData } from "@/lib/data";
import { getFavourites } from "@/lib/settings-db";
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
export default async function PromosPage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string; boost?: string; stake?: string }>;
}) {
  const params = await searchParams;
  const session = await currentSession();

  // The boost finder's inputs, range-checked: a URL is typed input.
  const boostSize = Number(params.boost);
  const boost = boostSize > 0 && boostSize <= 2 ? boostSize : 0.5;
  const stakeValue = Number(params.stake);
  const stake = stakeValue > 0 && stakeValue <= 1000 ? stakeValue : 25;
  const data = getData();
  const [games, lines, models, scoreModels, favourites] = await Promise.all([
    data.games(),
    data.backend === "postgres" ? allBookLines().catch(() => new Map()) : Promise.resolve(new Map()),
    data.marginModels(),
    data.scoreModels().catch(() => ({})),
    data.backend === "postgres" ? getFavourites().catch(() => [] as string[]) : Promise.resolve([] as string[]),
  ]);
  const books = [...new Set([...lines.values()].flat().map((r) => r.book as string))].sort();
  if (!books.includes("FanDuel")) books.unshift("FanDuel");
  const book = params.book && books.includes(params.book) ? params.book : "FanDuel";
  const found = findBoosts(games, lines, models, scoreModels, {
    book,
    boost,
    stake,
    favourites,
    maxSpread: DEFAULT_MAX_SPREAD,
  });

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

      <BoostFinder
        books={books}
        book={book}
        boost={boost}
        stake={stake}
        checked={found.checked}
        unchecked={found.unchecked.length}
        gamesAtBook={found.gamesAtBook}
      />

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
