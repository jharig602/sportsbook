import { Card, PageHeader } from "@/components/ui";
import { FavouriteTeams } from "@/components/FavouriteTeams";
import { PushSettings } from "@/components/PushSettings";
import { StakeSettings } from "@/components/StakeSettings";
import { currentSession } from "@/lib/session";
import { getFavourites, getLocation, getTax, US_STATES } from "@/lib/settings-db";
import { TaxSettings } from "@/components/TaxSettings";
import { DEFAULT_TAX } from "@/lib/tax";
import { KalshiLinks, type UnlinkedGame } from "@/components/KalshiLinks";
import { LocationSetting } from "@/components/LocationSetting";
import { getData } from "@/lib/data";
import { KALSHI_CONFIG, kalshiFlagsVisible, shadowProfit } from "@/lib/kalshi";
import { eventsWithKalshi, shadowLog, unmatchedEvents, type ShadowRow } from "@/lib/kalshi-db";

/** A kickoff's date in New York, which is the date Kalshi files a game under. */
const easternDate = (iso: string) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(iso));

/** The shadow log in one line per flag kind: how many, how many settled, what they made. */
function ShadowSummary({ rows, open }: { rows: ShadowRow[]; open: boolean }) {
  const kinds = [
    { kind: "kalshi_value" as const, label: "Kalshi value (flag 2)" },
    { kind: "arb" as const, label: "Cross-venue arb (flag 3)" },
  ];
  return (
    <div className="mt-3 border-t border-edge/70 pt-2.5">
      <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
        {open ? "Flags 2 and 3" : "Shadow log"}
      </h3>
      <p className="mt-1 text-[11px] leading-relaxed text-slate-500">
        {open
          ? "Shown in your state. The record below is every one that has fired."
          : "Hidden in your state, but every one that would have fired is recorded with the result, per $1 contract, so you will know whether they pay before risking money if the ban lifts."}
      </p>
      <ul className="mt-1.5 space-y-1 text-[12px] text-slate-300">
        {kinds.map(({ kind, label }) => {
          const all = rows.filter((r) => r.kind === kind);
          // An arb's result is locked in when it fires; a value bet's waits for the score.
          const settled = all.map((r) => shadowProfit(r, r.sideWon)).filter((p): p is number => p !== null);
          const counted = settled.length;
          const total = settled.reduce((a, b) => a + b, 0);
          return (
            <li key={kind} className="flex justify-between gap-2">
              <span>{label}</span>
              <span className="tabular text-slate-400">
                {all.length} fired · {counted} settled ·{" "}
                <span className={total >= 0 ? "text-emerald-300" : "text-rose-300"}>
                  {total >= 0 ? "+" : "−"}${Math.abs(total).toFixed(2)}
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export const metadata = { title: "Settings · Dissent" };

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-6">
      <h2 className="mb-2 text-sm font-semibold text-slate-200">{title}</h2>
      <div className="space-y-2 text-sm leading-relaxed text-slate-400">{children}</div>
    </section>
  );
}

/**
 * Settings, then what the app is.
 *
 * This page described an app that no longer existed: one sportsbook, no line shopping, no
 * recommended bets, pushes about line moves. Every one of those had stopped being true, and
 * a help page that is confidently wrong is worse than none -- it is read by exactly the
 * person trying to understand a number, at exactly the moment the number is confusing.
 * The same failure happened on the Record page, where a title read as a verdict on the
 * whole app when it only measured movers. So this describes what is on screen now, and
 * the settings come first because the tab is called Settings.
 *
 * My teams lives here rather than on Shop: it is the setting people look for under
 * Settings, and it now changes behaviour across the app (picks, pushes, the theme)
 * rather than only a card on one page.
 */
export default async function AboutPage() {
  const [session, favourites, tax] = await Promise.all([
    currentSession(),
    getFavourites().catch(() => [] as string[]),
    getTax().catch(() => DEFAULT_TAX),
  ]);
  // Kalshi (owner only): state, unmatched games to link by hand, and the shadow log.
  const kalshi =
    session.role === "owner"
      ? await Promise.all([
          getLocation().catch(() => "MI"),
          getData().games().catch(() => []),
          eventsWithKalshi().catch(() => new Set<string>()),
          unmatchedEvents().catch(() => []),
          shadowLog().catch(() => [] as ShadowRow[]),
        ])
      : null;
  const now = Date.now();
  const unlinked: UnlinkedGame[] = kalshi
    ? kalshi[1]
        .filter((g) => Date.parse(g.commenceTime) > now && !kalshi[2].has(g.eventId))
        .filter((g) => g.league === "nfl" || g.league === "ncaaf")
        .sort((a, b) => a.commenceTime.localeCompare(b.commenceTime))
        .map((g) => ({
          eventId: g.eventId,
          league: g.league as "nfl" | "ncaaf",
          label: `${g.awayTeam ?? "?"} @ ${g.homeTeam ?? "?"} · ${easternDate(g.commenceTime)}`,
          date: easternDate(g.commenceTime),
        }))
    : [];
  // Teams are a shared setting, written by the owner. A guest would see the picker and
  // then have every save refused, so a guest simply does not get one.
  const owner = session.role === "owner";

  return (
    <>
      <PageHeader title="Settings" subtitle="Your team, your bankroll, your notifications." />

      {owner ? <FavouriteTeams selected={favourites} /> : null}

      <Card className="mb-4 px-3 py-3">
        <StakeSettings />
      </Card>

      <Card className="mb-4 px-3 py-3">
        <PushSettings />
      </Card>

      {owner ? (
        <Card className="mb-4 px-3 py-3">
          <TaxSettings initial={tax} />
        </Card>
      ) : null}

      {kalshi ? (
        <Card className="mb-8 px-3 py-3">
          <LocationSetting initial={kalshi[0]} states={US_STATES} blocked={KALSHI_CONFIG.blockedStates} />
          <div className="mt-3 border-t border-edge/70 pt-2.5">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
              Kalshi matches · {unlinked.length} board game{unlinked.length === 1 ? "" : "s"} without one
            </h3>
            <p className="mb-2 mt-1 text-[11px] leading-relaxed text-slate-500">
              Games are matched by team codes or both team names and never guessed. Big
              college games often appear on Kalshi only late in the week.
            </p>
            <KalshiLinks
              games={unlinked}
              candidates={kalshi[3].map((u) => ({ eventTicker: u.eventTicker, title: u.title, reason: u.reason, date: u.gameDate, league: u.league as "nfl" | "ncaaf" }))}
            />
          </div>
          <ShadowSummary rows={kalshi[4]} open={kalshiFlagsVisible(kalshi[0])} />
        </Card>
      ) : null}

      <h1 className="mb-1 text-lg font-semibold text-slate-100">About</h1>
      <p className="mb-5 text-sm text-slate-500">What this measures, and what it refuses to claim.</p>

      <Section title="The one idea">
        <p>
          A sportsbook prices its own board consistently, so it can&rsquo;t disagree with
          itself. What&rsquo;s worth acting on is when one book disagrees with{" "}
          <span className="font-medium text-slate-300">the others</span>. Every price here
          is compared with the middle of the other books on the same game, and the gap is
          the whole signal.
        </p>
        <p>
          It matters because a point of line is worth about 3 points of win probability,
          while &minus;110 only charges about 2.4. So a one-point disagreement between books
          can clear the house edge, where nothing else on the board can. Most days there
          isn&rsquo;t one, and the app says so.
        </p>
      </Section>

      <Section title="The tabs">
        <ul className="list-disc space-y-1 pl-4">
          <li>
            <span className="text-slate-300">Board</span> &mdash; every game, its prices,
            and how they&rsquo;ve moved.
          </li>
          <li>
            <span className="text-slate-300">Shop</span> &mdash; where your books beat the
            others. The bet of the day, the parlay of the day and the same-game parlay of
            the day sit on top, then every price that clears the house edge.
          </li>
          <li>
            <span className="text-slate-300">Survivor</span> &mdash; the pick that gives
            each of your pools the best chance of being the last one standing, not just of
            surviving the week.
          </li>
          <li>
            <span className="text-slate-300">Bets</span> &mdash; your ledger. Profit is
            worked out from final scores, so a corrected score corrects your record.
          </li>
          <li>
            <span className="text-slate-300">Promos</span> &mdash; your boosts and bonus
            bets, what each is worth, and when it expires. An unused one is the only promo
            that costs you money.
          </li>
          <li>
            <span className="text-slate-300">Record</span> &mdash; how the app&rsquo;s picks
            have actually done, including when the answer is &ldquo;no better than
            luck&rdquo;.
          </li>
        </ul>
      </Section>

      <Section title="Reading the numbers">
        <p>
          <span className="text-slate-300">Break-even.</span> At &minus;110 a bet has to
          win 52.4% of the time just to break even, not 50%. A +300 underdog only has to
          win 25%. Everything here is measured against the price, never against a coin
          flip.
        </p>
        <p>
          <span className="text-slate-300">Edge (points).</span> How far the fair chance of
          winning sits above what the price needs. A pick has to clear{" "}
          <span className="text-slate-300">1.5 points</span> before it&rsquo;s suggested.
        </p>
        <p>
          <span className="text-slate-300">Return.</span> What $1 would make on average
          over many bets like it. A +4% return still loses most individual bets at long
          prices, and that isn&rsquo;t the number being wrong.
        </p>
        <p>
          <span className="text-slate-300">Fair price</span> on a same-game parlay is the
          price the book has to beat. Books don&rsquo;t publish their same-game prices, so
          the app can&rsquo;t say whether one is good; it tells you the number to check the
          slip against.
        </p>
      </Section>

      <Section title="Where the money actually is">
        <p>
          Profit boosts and bonus bets are worth money whether or not any prediction is
          right, because the book is paying extra on a fairly priced bet. A 50% boost on a
          +300 underdog is worth about $9 on $25 in expectation. That&rsquo;s arithmetic,
          not a forecast, and it&rsquo;s the most reliable edge in the app.
        </p>
        <p>
          Line shopping is the part still being tested. It&rsquo;s the right idea, but
          whether its edges hold up is measured on every line the app sees, win or lose,
          and the discount it applies to its own estimates only switches on once that
          measurement is clear of luck.
        </p>
      </Section>

      <Section title="Tax: the biggest cut of all">
        <p>
          Winnings are taxed as income at your own rate, and on the standard deduction
          your losses don&rsquo;t come off at all (itemizers get 90% of them, from 2026).
          At a combined 26%, a plain &minus;110 bet needs to win about 60% just to break
          even, not 52.4%. Boosts and bonus bets still come out ahead; plain bets mostly
          don&rsquo;t. Set your rate in Settings and the Bets page and Boost finder show
          values after tax. Not tax advice.
        </p>
      </Section>

      <Section title="What it refuses to claim">
        <ul className="list-disc space-y-1 pl-4">
          <li>
            &ldquo;Nothing clears the edge today&rdquo; is the usual answer, and the right
            one to act on. A tool that always found a bet would be inventing them.
          </li>
          <li>
            Learning is slow on purpose. A hot or cold week barely moves the estimates;
            hundreds of results do. It aims to be more accurate over time, not to win more
            bets every week, which no honest system can promise.
          </li>
          <li>
            Ideas that were tested and failed stay switched off: line-movement alerts as a
            betting signal, a power rating built from scores, and per-team home field.
            Each was checked against the closing line on seven seasons and didn&rsquo;t
            beat it.
          </li>
          <li>
            It never suggests betting against a team in My teams. Totals are still allowed,
            since an over or under picks no side.
          </li>
        </ul>
      </Section>

      <Section title="Other pages">
        <p>Not in the tab bar, but still collected and graded.</p>
        <ul className="list-disc space-y-1 pl-4">
          <li>
            <a href="/confidence" className="text-sky-400 underline underline-offset-2">
              Confidence
            </a>{" "}
            &mdash; this week&rsquo;s NFL games picked straight up, surest pick worth 16 points
            and down. Linked from Survivor.
          </li>
          <li>
            <a href="/movers" className="text-sky-400 underline underline-offset-2">
              Movers
            </a>{" "}
            &mdash; unusual line movement. Graded on the Record page; it stopped notifying
            because a channel that fires on every move is one you mute within a weekend.
          </li>
          <li>
            <a href="/edges" className="text-sky-400 underline underline-offset-2">
              Edges
            </a>{" "}
            &mdash; whether one book agrees with itself. Zero on 8,357 games, so it&rsquo;s a
            check for a stale price rather than a list of bets.
          </li>
        </ul>
      </Section>

      <Section title="Known limits">
        <ul className="list-disc space-y-1 pl-4">
          <li>
            Prices refresh a few times a day, not live. A number can move between the last
            refresh and when you open your book, so check the slip.
          </li>
          <li>
            A quote&rsquo;s time is when the app saw it, not when the book set it. Anything
            older than a day and a half is left out rather than trusted.
          </li>
          <li>
            Moneylines far from even money aren&rsquo;t given a return: the maths that
            strips a book&rsquo;s margin breaks down on big favourites and long shots.
          </li>
          <li>
            Totals on the Shop are priced approximately, with the spread model rather than
            one built for totals.
          </li>
          <li>
            Full-game markets only. No player props, and team totals have to be typed in
            because no feed prices them.
          </li>
          <li>
            The &ldquo;closing&rdquo; number is the last quote seen before kickoff, not a
            verified close.
          </li>
        </ul>
      </Section>
    </>
  );
}
