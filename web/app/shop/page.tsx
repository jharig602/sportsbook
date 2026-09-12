import { TeamLogo } from "@/components/TeamLogo";
import { MyBooksPicker } from "@/components/MyBooksPicker";
import { Card, Empty, Explainer, NotAdvice, PageHeader, Pill, Segmented, Stats } from "@/components/ui";
import { PromoCard } from "@/components/PromoCard";
import { allBookLines } from "@/lib/book-lines";
import { bookLink } from "@/lib/book-links";
import { promoToday } from "@/lib/promo-plan";
import { buildBoardShop, type BoardEdge } from "@/lib/board-shop";

import { getData } from "@/lib/data";
import { formatKickoff, formatLeague, formatLine, formatPrice } from "@/lib/format";
import { getMyBooks } from "@/lib/settings-db";
import type { Side } from "@/lib/types";

export const dynamic = "force-dynamic";

function sideLabel(row: BoardEdge): string {
  const side: Side = row.side;
  if (side === "home") return row.homeTeam;
  if (side === "away") return row.awayTeam;
  return side;
}

/**
 * A one-tap hop to the book, for books you actually hold.
 *
 * Outside the Card rather than inside it, because the Card is already a link to the
 * game page and an anchor cannot nest. Shown only for your own books: a link to a
 * sportsbook you have no account at is an advert, not a shortcut.
 */
function OpenBook({ book }: { book: string }) {
  const href = bookLink(book);
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 inline-flex items-center gap-1 text-[11px] text-sky-400/90"
    >
      Open {book}
      <span aria-hidden="true">&#8599;</span>
    </a>
  );
}

function Row({ row }: { row: BoardEdge }) {
  const good = (row.expectedRoi ?? -1) > 0;
  const teamId =
    row.side === "home" ? row.homeTeamId : row.side === "away" ? row.awayTeamId : null;

  return (
    <Card href={`/game/${row.eventId}`} className="px-3 py-2.5">
      <div className="flex items-start gap-2.5">
        <div
          className={`tabular flex h-11 w-16 shrink-0 flex-col items-center justify-center rounded-lg text-[14px] font-semibold ${
            good ? "bg-emerald-500/12 text-emerald-300" : "bg-slate-700/40 text-slate-500"
          }`}
        >
          {row.expectedRoi === null
            ? "—"
            : `${row.expectedRoi > 0 ? "+" : ""}${(row.expectedRoi * 100).toFixed(1)}%`}
          <span className="text-[9px] font-normal opacity-70">return</span>
        </div>

        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-[14px] font-medium text-slate-100">
            {teamId ? (
              <TeamLogo league={row.league} teamId={teamId} name={sideLabel(row)} size={20} />
            ) : null}
            <span className="min-w-0 truncate">{sideLabel(row)}</span>
            <span className="shrink-0 text-[11px] font-normal text-slate-400">
              {row.market}
            </span>
          </p>

          <p className="mt-0.5 text-[11px] text-slate-500">
            at <span className="font-medium text-slate-300">{row.book}</span>
            {" · "}
            {row.awayTeam} <span className="text-slate-600">@</span> {row.homeTeam}
          </p>

          <div className="tabular mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10px] text-slate-600">
            <Pill>{formatLeague(row.league)}</Pill>
            <span className="text-slate-400">
              {row.line !== null ? formatLine(row.market, row.side, row.line) : ""}{" "}
              {formatPrice(row.price)}
            </span>
            {row.consensusLine !== null ? (
              <span>others {formatLine(row.market, row.side, row.consensusLine)}</span>
            ) : null}
            {row.advantagePoints !== null && row.advantagePoints !== 0 ? (
              <span className={row.advantagePoints > 0 ? "text-emerald-400/80" : ""}>
                {row.advantagePoints > 0 ? "+" : ""}
                {row.advantagePoints.toFixed(1)} pts
              </span>
            ) : null}
            <span>vs {row.booksCompared} books</span>
            <span>{formatKickoff(row.commenceTime)}</span>
          </div>
        </div>
      </div>
    </Card>
  );
}

/**
 * Filtering to the books you can actually reach.
 *
 * The first live board put every one of its best rows at Bovada, MyBookie, BetUS and
 * LowVig -- offshore books, which lag, which is precisely why they disagree and
 * precisely why they top the list. A number you cannot get is not an opportunity, and
 * answering "is any of this at my book" by reading forty rows is how you stop asking.
 */
export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<{ book?: string }>;
}) {
  const { book: bookFilter } = await searchParams;
  const data = getData();
  const [games, models, lines, myBooks, promo] = await Promise.all([
    data.games(),
    data.marginModels(),
    data.backend === "postgres" ? allBookLines() : Promise.resolve(new Map()),
    // Read server-side, so the board you look at and the alerts you receive can never
    // disagree about which books are yours.
    data.backend === "postgres" ? getMyBooks() : Promise.resolve([] as string[]),
    // The daily qualifying bet lives here rather than in a tab of its own: it is a
    // book-specific bet, which is what this page is for, and it is a seven-day thing
    // that a permanent tab would outlive.
    promoToday().catch(() => null),
  ]);

  const shop = buildBoardShop(games, lines, models);

  // "My books" appears only once some are chosen, and becomes the default then: a
  // ranked list of prices you cannot get is not the first thing you should see.
  const hasMine = myBooks.some((book) => shop.books.includes(book));
  const requested = bookFilter ?? (hasMine ? "mine" : "all");
  const active =
    requested === "mine" && hasMine
      ? "mine"
      : shop.books.includes(requested)
        ? requested
        : "all";

  const visible =
    active === "all"
      ? shop.rows
      : active === "mine"
        ? shop.rows.filter((row) => myBooks.includes(row.book))
        : shop.rows.filter((row) => row.book === active);
  const visiblePositive = visible.filter((row) => (row.expectedRoi ?? -1) > 0);

  const options = [
    ...(hasMine ? [{ key: "mine", label: "My books" }] : []),
    { key: "all", label: "All books" },
    ...shop.books.map((book) => ({ key: book, label: book })),
  ];

  return (
    <>
      <PageHeader
        title="Shop"
        subtitle="Where one book disagrees with the others, biggest first"
      />

      {promo && !promo.progress.complete ? <PromoCard promo={promo} /> : null}

      {shop.gamesWithSecondBook === 0 ? (
        <Empty
          title="No second book yet"
          detail="Nothing has been collected from other books for an upcoming game. The feed polls near kickoff, so this fills in as game day approaches."
        />
      ) : (
        <>
          <Stats
            items={[
              { value: String(shop.gamesWithSecondBook), label: "games" },
              { value: String(shop.books.length), label: "books" },
              {
                value: String(visiblePositive.length),
                label: "beat the vig",
                tone: visiblePositive.length > 0 ? ("good" as const) : ("plain" as const),
              },
            ]}
          />

          <MyBooksPicker books={shop.books} selected={myBooks} />

          <Segmented
            options={options}
            active={active}
            hrefFor={(key) => `/shop?book=${encodeURIComponent(key)}`}
          />

          {visiblePositive.length === 0 && visible[0] ? (
            <Card className="mb-3 px-3.5 py-2.5">
              <p className="text-[12px] leading-relaxed text-slate-400">
                Nothing here clears the vig
                {active === "all"
                  ? " right now"
                  : active === "mine"
                    ? " at your books"
                    : ` at ${active}`}. The closest is{" "}
                <span className="font-medium text-slate-200">
                  {visible[0].book} {sideLabel(visible[0])}
                </span>{" "}
                at{" "}
                <span className="tabular text-slate-200">
                  {((visible[0].expectedRoi ?? 0) * 100).toFixed(1)}%
                </span>
                , against about &minus;4.5% for a book that matches consensus. That
                distance is the finding.
              </p>
            </Card>
          ) : null}

          <div className="space-y-1.5">
            {visible.slice(0, 40).map((row) => (
              <div key={`${row.eventId}-${row.book}-${row.market}-${row.side}`}>
                <Row row={row} />
                {myBooks.includes(row.book) ? <OpenBook book={row.book} /> : null}
              </div>
            ))}
          </div>
        </>
      )}

      <Explainer title="How this is read">
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          Edges asks whether DraftKings&rsquo; spread agrees with DraftKings&rsquo; own
          moneyline. A book that prices its board coherently cannot disagree with itself
          by more than rounding noise, so the honest ceiling there is zero &mdash; and
          seven seasons of history made that verdict more confident, not less.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          This asks whether one book disagrees with the <em>others</em>. A point of line
          is worth about 3.2 points of win probability in the NFL and 2.6 in college,
          against the 2.4 that &minus;110 charges. So a one-point disagreement clears the
          vig outright and half a point does not &mdash; which makes this the only
          comparison at this scale whose answer can be positive.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          Every book is measured against the median of the <em>others</em>, never
          including itself, and quotes over a day old are shown on the game page but kept
          out of every consensus. The consensus always uses every book, including ones
          you cannot reach &mdash; more opinions make a better reference. The filter
          changes only whose <em>price</em> you are being offered.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          Expect the best rows to sit at offshore books. They lag, which is exactly why
          they disagree with the field, and exactly why they rank highest. Filter to a
          book you actually hold before treating anything here as a bet.
        </p>
        <p className="mt-2 text-[12px] leading-relaxed text-slate-400">
          <a href="/edges" className="text-sky-400 underline underline-offset-2">
            Edges
          </a>{" "}
          is still there and still worth a look when a price looks stuck: if
          DraftKings&rsquo; moneyline stops tracking its own spread, that is where it
          shows up.
        </p>
      </Explainer>

      <NotAdvice className="mt-6" />
    </>
  );
}
