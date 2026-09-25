# Dissent — how this works

Read this first. It exists so a session starting cold does not re-derive things that
were already measured, or re-make mistakes that were already made.

The app is at <https://sportsbook-qyrh.vercel.app>, the repo is `jharig602/sportsbook`,
and the database is Neon Postgres. Everything deploys on push to `main`.

---

## The one idea

A sportsbook prices its own board coherently, so a book cannot disagree with *itself* by
more than rounding — which is why the Edges page correctly reports zero on 8,357 games.
The only thing worth acting on is where one book disagrees with **the others**.

So every quote is priced against the **leave-one-out median** of the other books. A
point of line is worth 3.24 points of win probability in the NFL and 2.64 in college,
against the 2.4 that −110 charges — so a one-point disagreement between books clears the
vig outright, where a same-book inconsistency never can.

The name is that idea: the disagreement is the whole signal, and most days there isn't
one.

---

## Layout

```
collector/     Python. Polls feeds, writes Postgres, grades, refits. Runs on GitHub Actions.
web/           Next.js App Router. Reads the same database. Deploys to Vercel.
tests/         Python tests (pytest).
web/lib/*.test.ts   Web tests (node:test via tsx).
```

Run everything before pushing:

```bash
.venv/Scripts/python.exe -m pytest tests/ -q     # from the repo root
cd web && npx tsx --test lib/*.test.ts && npx tsc --noEmit && npx next build
```

---

## The rules this project runs on

These are not style preferences. Each one is here because breaking it produced a wrong
answer that looked right.

**An error must not present as a finding.** This is the whole posture. A silent team-match
failure looks identical to "the books agree". A stale quote looks identical to an edge. A
query cap looks identical to a count. Every filter reports what it removed; every fallback
says it fell back.

**Measure before asserting, and delete the assertion if it loses.** Several confident
hypotheses have been wrong here — see *Measured findings* below. When a measurement
contradicts a belief, the measurement wins and the belief gets deleted rather than
softened.

**Refuse rather than guess.** `team_match.py` will not match teams it is unsure of.
`buildPlan` leaves a pinned week empty rather than substituting. `poolWin` throws on an
inconsistent leg. A guess that is usually right is worse than a refusal, because nothing
downstream can tell the difference.

**Exact, not simulated — with one exception.** Numbers get compared against other
numbers, and sampling noise reads as a difference between plans. `last-standing.ts` is
the only module that samples, it uses a fixed seed so the error is common to every
candidate, and it says so at the top.

**Credentials never reach chat, argv, or storage.** Read from the environment. `redact_url()`
keeps API keys out of `raw_responses.url`. Secrets live in `PRODUCTION-SECRETS.txt`
(gitignored) and GitHub Actions secrets.

---

## Measured findings (do not re-litigate these)

| claim | verdict |
|---|---|
| Big spreads are more volatile | **False.** Residual sd is flat 14–15 from 0 to 45 and *lower* at 45+. Cover ~50% at every band. |
| College home-field advantage is real | **Shrank to nothing** on 7 seasons: +1.40 z=2.89 → +0.26 z=1.32. |
| The +37% moneyline edges were real | **No** — 79 artifacts of multiplicative de-vig failing in the tails. Thresholds moved to the probability scale. |
| z-score gating cuts false alarms | Cut them 42%→19%, but real detections 47%→9.5%. **Rejected.** |
| Correlation with the field is harmless | **False.** It cuts against you on the crowd's ticket and for you off it. |
| Survivor: maximise survival | **Wrong objective.** The pool pays the last entrant standing; a 13-entry pool wipes out entirely ~44% of seasons. |
| Blowouts should be filtered because they are unpredictable | Right action, **wrong reason**. They are predictable; the sample is too thin to have fitted the residual *shape*, and nobody bets those lines. |
| Rivals already carrying a loss can be modelled as one mixed field | **Yes, measured.** Each rival drawn independently from the recorded split, against the exact two-group integral: +0.24% on a 141-entry pool (89 unbeaten / 51 on a last life), +1.66% on an 11-entry one (8 / 2). Stable at 1,500 and 12,000 seasons, so it is the approximation and not noise. |
| The margin and the total move together | **Barely.** Fitted on 7 seasons: r = **+0.002** in the NFL (2,020 games, a twentieth of an SE from zero) and **+0.095** in college (5,681 games, ~7 SE — real but small). Spread and game total in one NFL game are near-independent; any correlation markup a book charges on that pair is juice. |
| A team total is just another leg | **No, and this is the one that matters.** Home points are `(total + margin)/2`, so a home team total correlates with the margin at **0.70 NFL / 0.73 college** *by construction*, whatever the fitted r is. Multiplying those legs is badly wrong. |
| Games land over the closing total | **True and not enough.** Mean total residual +0.58 NFL / +0.61 college → 51.8% and 51.5% on the over. Break-even is 52.38%. Measured, real, no bet. |
| A power rating from scores beats the closing line | **No.** Walk-forward on 7 seasons, `collector/ratings.py`. College: 50.9% over 4,586 games (ROI -2.8%), decisively short of 52.38%. NFL: 53.5% at 3+ points of disagreement over 897 games, ROI +2.2% -- but p=0.019 against a coin flip becomes **0.12** once the six thresholds that produced it are counted, and p=0.26 against the vig becomes 1.0. A hint, not a result. Do not build on it without new information. |
| Fitted home-field advantage is a check on the data, not just an output | **Yes, and it caught one.** NFL came out at **1.67 points**, which is right. College came out at **6.54**, roughly double any credible figure, because barely-seen teams are shrunk toward average and play almost every game away -- the error lands in HFA. Excluding them moved it to 5.70 and lifted the college cover rate 0.8pp, so the college fit is still partly contaminated. A coefficient that is right on clean data and absurd on dirty data is pointing at the data. |
| Home field is uneven, so the market misprices the extremes | **No, and the model has good face validity anyway.** Per-team home field, fitted unpenalised and shrunk toward the league: NFL's strongest are **Denver +2.3, Kansas City +2.3, Buffalo +2.2** and weakest Atlanta/Carolina +1.2 — altitude, crowd noise and weather, found from margins alone. College's strongest include **Boise State +6.5**. But the whole NFL spans 1.1 points, and against a flat home field per-team made the NFL **worse** (53.51% → 51.74% at 3+ points) and college better by **+0.78pp, which is under one standard error**. Family p against the vig: 1.0 in both. Home field is real, uneven, and correctly priced. |
| A market/league breakdown shows where the rule works | **Only with the search priced in.** Six cells of ~17 games contain a 70% cell one time in eight per cell; `selection.familyP` reports how often the *best of six* looks that good with no edge anywhere. |

---

## Things that bit, and the fix

- **Staleness cutoff equal to the poll interval** (both 24h) emptied the college board.
  `FRESHNESS_HOURS = 30` now exceeds `INTERVAL_FAR_HOURS = 24`, and each names the other.
- **`pickPopularity(1)` hardcoded week 1** — from week 2 it read September's crowd against
  November's teams. `currentNflWeek()` mirrors the collector's rule; each side names the other.
- **`ORDER BY move_strength DESC LIMIT 500`** made `totalAlerts` read exactly 500 forever,
  and "awaiting" was that cap minus every grade ever written. Counts come from SQL now.
- **A promo reminder gated on a two-hour window** never fired once in five days, because
  GitHub delivers runs at arbitrary times. Windows are wide; "once" is enforced by
  remembering the date.
- **Times rendered in the server's zone** (UTC on Vercel) put every kickoff five hours
  late and filed Saturday-night games under Sunday. `DISPLAY_TIME_ZONE` is pinned.
- **`poll_runs` has a row per poll**, not per cycle, so a naive median gap read "every 3m".
  Timestamps within 30 minutes collapse to one cycle first.
- **Deploy checks that matched a string the previous build already had** confirmed deploys
  that had not landed. Twice. Poll for something only the new build can produce.
- **Test fixtures pinned to a date, checked against the real clock.** Twice now: the
  Python `tests/helpers.py` kickoff went past and six tests failed mid-afternoon, then
  `book-lines.test.ts` quotes dated 2026-09-12 aged out of the 30-hour freshness window
  three days later. Both failed with no code change behind them, which points at the
  wrong thing. **Any function that takes `now` gets it passed explicitly in tests**, and
  fixture dates are relative or paired with that `now`.
- **Gating a commit on a pipeline's exit status.** Twice: once a red test run was pushed
  because the chain's exit was read instead of the suite's, and once `tsc | grep` inside
  `$(...)` printed "tsc exit 0" directly above a listed type error, pushed it, and broke
  the Vercel build (`d857a29`). `tsx` runs scripts without typechecking, so a script can
  work in Actions and still fail the deploy. **Redirect the tool to a file, take `$?`
  from the tool itself, and gate on that** — or on the suite's own `fail 0` line.

---

## Reading the record

Three markets are collected, graded and shopped, but they are **not equally modelled**:

- **Spread** — fully modelled. `fit_margins.py` fits `margin + home_spread`, giving
  dispersion, key-number mass and push odds, bucketed by spread size.
- **Moneyline** — shopped against other books' de-vigged prices, no model needed, and
  **band-limited**: outside roughly even money it refuses to quote a return, because
  multiplicative de-vig breaks in the tails. That refusal killed the 79 phantom +37%s.
- **Totals** — graded correctly (`grade_total` is right), but **priced with the margin
  model**. `shop.ts` has no totals branch, so a total falls through to
  `pointsToProbability(model, consensusOriented)` and `sdForSpread` looks up a 40.5
  *total* in the |home_spread| buckets. It lands in the extreme-blowout band (sd 13.63
  vs league 15.43), overstating a point of total by ~13%, or falls off the table and
  silently reverts to the league figure. **There is no totals model.** `historical_lines`
  has the closing totals and `game_results` the scores, so one is fittable on the same
  backfill; until it is, treat totals edges on Shop as approximate.

The **Record** page has **two sources**, and they are never pooled:

- **Line moves** — `alerts` → `alert_grades`. Cover 61.4%/101 (beats a coin flip
  p=0.022, not break-even p=0.070); line value 38.8%, already failed.
- **Line shopping** — `shop_picks` → `shop_grades`, new in v16. **Everything on this
  page before v16 was the movers**, under a title that reads as a verdict on the whole
  app. That is how it was read. Label the source, always.

**Shopping is judged by return, not win rate** (`shop-record.ts`). Its picks are at every
price, so 52.4% is the wrong bar: a +300 underdog breaks even at 25%, and a −200 cell can
win 60% and lose money. Each cell shows profit per $1 at the prices taken beside the
predicted return. The verdict is price-aware: under fair pricing a pick paying `b` per
dollar has variance exactly `b`, so a cell is called only when its return clears
`z * sqrt(sum b) / n` (Bonferroni across six). **Picks collapse to one result per game,
market, side and line** first — several books on one number were counted as several
results decided by one game. The bet of the day learns from the collapsed results too.

Only shopping has a **calibration** table, because only it states a probability. A band
is judged against *its own claim*, not break-even: predicting 42% and delivering 42% is
honest and still a losing bet. A Brier score sits alongside, because a rule that says
50% about everything is perfectly calibrated and perfectly useless and the table cannot
see it.

The grid cuts cover rate by market × league. Every cell is judged twice: `alone`
(z=1.96, the naive number, not safe to act on) and `adjusted` (Bonferroni across the
six). `selection.familyP` prices the search itself — the probability *some* cell reads
as well as the best one does when nothing has any edge. It is usually large.

**Recording rules for `shop_picks`** (both are statistical, not tidiness): one row per
*offer*, not per poll — the board recomputes every cycle and repeated rows are one
observation, not dozens, so `pick_id` hashes the offer and re-inserts DO NOTHING; and
*every* positive row, not just those clearing the notification bar, or the sample
measures the notification threshold instead of the rule.

## Scheduling reality

`.github/workflows/collect.yml` is dense inside game windows and sparse outside, asking
for ~144 cycles a week (~21/day). **GitHub has historically delivered 3–5 a day, at
arbitrary minutes** — measured over five days, zero landed in the old two-hour promo
window. Whether the new shape is delivered any better is visible on the Freshness line,
not assumed.

Minutes are not a constraint: the repo is public, so Actions are unlimited. The three
real limits, measured:

| limit | figure |
|---|---|
| **ESPN** (unofficial endpoint) | ~195 requests per cycle. Being blocked leaves you with no data, not stale data. |
| **Neon** free tier | 0.5 GB. ~612 snapshot rows per cycle, plus raw bodies pruned at 7 days. |
| **GitHub's scheduler** | Drops most of what a dense cron asks. Asking harder does not produce more. |

And the one none of those capture: **lines barely move midweek.** NCAAF prices are 6%
populated 13 days out. Polling hard on a Tuesday is watching nothing happen, repeatedly.

Consequences that are already handled, and must stay handled:

- Anything time-gated uses a **wide window** plus a **stored "already sent" marker**,
  never a narrow window.
- Nothing counts down to a scheduled minute. `Freshness` reports when the collector last
  ran and the measured median gap, and warns when the gap doubles.

---

## Schema

`collector/schema.py` owns it. `ANALYTICS_SCHEMA_VERSION` is currently **22**.

Additive tables go in the DDL (all `CREATE TABLE IF NOT EXISTS`). **New columns must be
added to `ANALYTICS_MIGRATIONS`** or they will not exist on an upgraded database.

**Always push a schema change and run the migration before deploying web code that
selects the new column.** Push `collector/schema.py` alone, `gh workflow run collect`,
wait for it, then push the web change.

---

## The ledger

Bets are logged from wherever the decision was made: the game page, each book's row under
Line shopping, and the promo card all link to `/bets` with the game, market, side, line,
price, book, stake and bonus flag filled in (`lib/bet-link.ts`, strictly re-validated on
read). The form finds games by typing team names and lists games that kicked off in the
last 48 hours after upcoming ones — the old dropdown held the first 80 upcoming games, so
a college Saturday's game or a bet logged late could simply be missing.

`bets` is append-only. Nothing is ever updated, because the outcome is derived from
`game_results` at read time and a corrected score corrects the P&L by itself.

- A **correction** is a new row with `supersedes` set.
- A **removal** is a correction with `voided` set — a tombstone, not a DELETE.
- A **parlay** is one row per leg sharing `parlay_id`, written in a transaction, with
  `parlay_price` stored rather than derived (books round the product down). `tally`
  counts one row per *ticket*; counting legs reads a 3-leg $5 bet as $15 risked.
- A **cash-out** is the one stored verdict in the schema (`cashout`, v15). It has to be:
  the ticket was sold back at a negotiated price and the final score stops deciding
  anything. A $50 bonus moneyline at +920 cashed for $193.98 grades as +$460 or $0 if
  left derived — both wrong, and indistinguishable from right. Same bonus asymmetry as a
  win: bonus means the whole figure is profit, otherwise `cashout - stake`. On a parlay
  it sits on every leg and is counted once. The score is **still graded underneath**
  (`heldInstead`) so the page can report what holding would have paid — one cash-out
  says nothing, twenty say whether the decision is any good.

---

## Bet of the day

The Shop page card and a once-a-day push (`/api/dispatch-daily`, only sent when there is
a bet). Among line-shopping rows at your books that clear break-even by **1.5 points**
(the shop-alert bar) after learning, it picks the **likeliest winner** — not the biggest
return, which drifts to long prices where estimates are shakiest. It never picks a game
with a standing bet in the viewer's ledger (`openEvents` uses `activeBets`, so voided and
corrected rows do not block, and cashed-out tickets are finished). "No bet today" is
shown, not hidden: it is the usual answer.

**Never against your team.** A bet backing the opponent of a team in My teams is
skipped by the single, the parlay and the same-game parlay (`betsAgainst` in
`favourites.ts`), and the card counts what it skipped — a bet the app declined to mention
without saying so is indistinguishable from one it never saw. Totals are never "against"
anybody: an over or under picks no side. The SGP's reference line still uses every row,
because what a game is priced at does not depend on which side you would bet. Cost,
measured when it was asked for: passing the Jets at +265 against the Lions gave up about
a dollar of boost value.

The **parlay of the day** (`bestParlay`) uses the same qualifying bets, two at a time:
different games, one book, never the single's game (so taking both never stacks two
tickets on one result), likeliest pair first, priced at the combined price **rounded
down** as books pay (`parlayPrice`) and required to stay positive there. `LogParlay` is
the only screen that can record a parlay; it asks for the slip's combined price rather
than assuming the product.

**Learning** (`learnedShift`): for each market × league, the gap between how often graded
shop picks won and how often they were predicted to, shrunk by `PRIOR_STRENGTH = 100`
(`(hits - expected) / (n + 100)`), is added to future probabilities. Twenty lucky results
barely move it; hundreds do. This makes predictions match outcomes more closely over
time. It does **not** promise more wins per week, and nothing here should claim that.

The FanDuel $5/$50 qualifying promotion ended and its code (card, plan, `promo.ts`,
`dispatch-promo`) was removed; restore from git history if it recurs. `promo-window.ts`
stays — it is the daily window the bet of the day uses.

## Pushes

Six dispatchers, all `/api/dispatch-*`, all called by `collect.yml` after the scores and
odds steps, all guarded by `refuseUnlessDispatcher`, all offering on every run and
remembering what they sent (GitHub delivers runs at arbitrary minutes):

- **Bet of the day** (+ parlay in the same message) — once a day, only when one clears.
- **Your team this week** — once per game in the 30 hours before kickoff, daytime only;
  the cheapest way to back them. Skips a game you already hold.
- **Win and loss** — one per ticket once final, owner's ledger only (`HOUSE`), games that
  kicked off in the last 36 hours only (without that bound the first run would have
  pushed the whole season), held midnight–8 AM Central, and one summary when more than
  three land at once. Cash-outs are not announced; voided and corrected rows are gone
  before it looks.
- **Line-shopping alerts** — edges at your books over the alert bar. The repeat check
  compares **edge in points**; for a while the dispatcher stored the expected *return*
  (~0.04) in its place and every alert re-sent every run. `notificationRecord` is now the
  only writer, and a test feeds what it records straight back into the check.
- **Survivor reminder**, and the dormant **movers** dispatcher.

Every response lands in **public** Actions logs: counts only, never teams, results or
money.

## Promo tracker

`/promos` (schema v18: `promos`, `promo_uses`). A calculator and a calendar, never a
handicapper: every function in `promo-ev.ts` takes terms and a price and returns money,
and the optimiser's output is an odds range and a stake. Naming a side would be a claim
the promo structure cannot support.

**What actually costs money is a token expiring unused**, so `expires_at` is the only
required term and the dashboard sorts on it. `status` is available/used and never
"expired" — expiry is the timestamp against the clock, and a stored copy of a derived
fact drifts from what it came from.

Terms are typed in. They sit behind a login with no public feed, and scraping a book
where you hold an account risks the account.

Five types, each with its own formula and optimal play (stake the cap and take the
longest qualifying price for stake-back; max stake, longest odds, FEW legs for a profit
boost). `boostCoversHold(b) = b/(1+b)` is why: a 50% boost only overcomes 33% hold, and
`parlayHold` compounds past that quickly. De-vig offers multiplicative and Shin (solved
by bisection, not a remembered closed form); when a promo's sign flips between them it
has no verdict worth acting on. One price plus an assumed hold is marked `estimated`.

**Two places the source spec contradicted itself**, both pinned by tests: its "+6.7% on
+200" for a 50% boost needs the true chance to be 80% of implied (a ~25% held market) —
at a fair +200 the same formula gives +33%; and its parlay-hold examples imply 4.1%,
7.2% and 5.8% per leg respectively, so per-leg hold is a parameter defaulting to the
4.5% measured here.

## Promotions

A **profit boost** doubles winnings, so a bet is worth `p(1 + 2b) - 1`, about
`1 - q - 2h`: longer odds help, and the book's margin costs twice as much. Its best use
is the longest price whose margin is still small, not the longest price. The workflow
`boost-candidates` ranks one book's moneylines (singles, two-leg parlays) by boosted
value, using the **lowest** of every independent estimate — de-vig flatters underdogs and
a boost multiplies the flattery — and lists sides with fewer than two other books apart,
unranked. **Log a boosted bet at the boosted price** (`boostedPrice`), or the ledger
settles the win at half its real profit.

## Same-game parlays

One final score, asked several questions. `joint-score.ts` prices them; `sgp.ts` turns
that into a price and ranks candidates.

**Never multiply the legs.** Every market here resolves off two numbers — the margin `D`
and the total `S` — so each leg is a half-plane `aD·D + aS·S > c` and a parlay is where
they overlap. Team totals are not a third thing: home points are `(S + D)/2`.

The margin keeps its **empirical** pmf (NFL margins lump on 3 and 7; a normal smooths
that away exactly where a leg sits on a key number). The total is normal from
`score_models`, which is an assumption and is labelled as one. They are joined by a
Gaussian copula at the measured correlation.

`jointProbability` walks the margin grid: for a fixed margin every leg is either already
settled or a plain bound on the total. Exact for this model, not simulated, same answer
every time.

**The product is a price to beat, not an edge.** No feed here holds a book's same-game
price, so the honest claim is "fair at +420, go and look" — checkable on the slip in five
seconds, and unable to be wrong in the quiet way an invented edge is. There is therefore
**no honest ranking by expected value**, and two attempts at one have already failed:

- **`markupBudget` ranked redundancy first.** How far the book could mark a ticket down
  from the product of its legs is widest exactly when the legs are most redundant,
  because redundancy is what makes the product overstate. It put "Titans ML + Titans +6
  + Titans +6.5" at the top of the live page with an apparent 373% of room — one bet
  written three times, since winning outright covers every spread that side would cover.
- **Price ranks lotteries first.** A bonus bet converts at `1 − 1/d`, so "longest price"
  sorts a deep alternate line to the top, and its price is long *because* it almost never
  wins. Length breaks ties among tickets that **already pay** and is never itself a
  reason. A test pins this, and caught a regression that reintroduced it.

Ranking is on the legs' own **measured cross-book edge**, each leg held to the same 1.5
points the single uses. Redundant legs are refused by removing each and repricing: if the
ticket is as likely without it, the leg adds no chance and only shortens the price.

**Every ticket is at one book.** A same-game parlay is placed in one app, so each
candidate is one book's view of one game. It used to take the best price for each leg
across your books, which produced tickets nobody could place.

**The reference line is the consensus of every live book** — not the board snapshot, and
not your own books. It has been wrong both ways. The board snapshot could be stale: legs
reading +6 against a board reading ~−3 turned a 31% ticket into 40%. Your own books' median
fixed that and broke something subtler: legs are *chosen* because your book beats the
market, and centring the game on your book's numbers erased exactly that — the
Gardner-Webb card picked two legs for beating the market by 1.5 points and then priced them
as fair. The all-book consensus is what the margin model was fitted against, so a leg at a
better number than the market is priced as the better bet it is. Stale quotes are left out.

Pushes are valued as the stake back, not as a loss, and only counted when a leg can
actually land on its number: the pmf pools whole-number and half-point lines onto one
half-point grid, so a game priced at −3 shows mass on residuals its margin cannot
produce. Counting that as a push would invent a refund.

**Player props are refused, not estimated.** Nothing here holds a player line and a
receiving total is not a function of `D` and `S`.

Team totals are stored as `market='total'` with a `team` (v20), because that is what they
are. No feed prices them, so the automatic pick cannot find one — the builder prices them
exactly once the price is typed in.

---

## The line census

`line_census` (v21) records **every** priced line the board can compare, bet or not.
`shop_picks` records only what the rule said to bet, written the first moment an edge
turns positive — which selects for the estimate being noisy-high. Such a sample
underperforms its own estimate even when the rule is sound, and nothing inside it can
separate the selection from the rule being wrong.

`edge-calibration.ts` fits `realised excess = slope × predicted excess`, through the
origin, on the collapsed census (one result per number, never per book). The slope is how
much of a measured edge actually turns up:

- **1** — edges are as advertised.
- **0.4** — bet only where the measured edge is 2.5× the bar.
- **0, within error** — the measured edge predicts nothing. Stop betting it; do not
  retune until it looks better.

`calibratedEdgePoints` applies it to the **edge**, not the bar — same arithmetic, read
the honest way round. It is a **no-op** until the slope clears 2 standard errors, never
inflates an edge above its measured value however good a stretch looks, and treats a
negative slope as *no information* rather than as a reason to bet the other side: a rule
that is backwards is one to stop using, and inverting it would stake money on the sign of
a statistic that has not cleared its own error bar.

**This does not find an edge.** It measures how far to trust the edges already found,
which raises returns by betting *less*. If there is no signal it establishes that far
sooner than the picks could, because the sample is the whole board.

Not to be confused with `calibration.ts`, which asks a different question — did the things
called 55% come in at 55% — on picks only, with bands and a Brier score, for the Record
page.

---

## Power ratings

`collector/ratings.py`. Solves `margin = rating(home) - rating(away) + hfa` over every
game at once; strength of schedule is not an adjustment, it is what solving
simultaneously means. Ridge, capped margins, recency half-life, conjugate gradient in
pure Python (no numpy).

**Nothing reads it.** It is graded, and it did not clear the bar. See the findings table.
The grader exists because a power rating always produces confident numbers -- it will
rank 134 college teams to two decimals with nothing behind it.

Rules if this is picked up again:

- **Walk-forward or it is worthless.** A game is predicted only from games that finished
  before its week. The test for that reruns with one game's margin set to 500 and asserts
  its own prediction does not move; asserting the games were merely ordered proves
  nothing, which is what the first version of that test did.
- **Two bars.** 50% asks whether it knows anything. **52.38%** asks whether it is
  bettable. Reporting only the first would have called this a working system.
- **Correct for the looks.** Six thresholds is six draws; `family_p` is the honest number
  and it is the one to quote.
- **Do not tune to chase it.** The parameters in `DEFAULTS` were fixed before the first
  run. The one change since came from a broken HFA coefficient, not a p-value, and both
  specifications are still reported side by side.
- **Per-team home field is done and did not work.** See the findings table. Fitting it
  taught one thing worth keeping: fit the per-team home edge **unpenalised** and shrink the
  answer, never penalise it inside the fit. Home and away games are observed separately so
  the decomposition is exactly identified, but if the deviation is penalised while the
  rating is not, the solver pays for a home edge out of the RATING — which then travels,
  and overrates the team on the road. Measured on a synthetic fortress: 2.4 to 3.9 points
  of rating it had not earned. Fitting a single league number first and reading residuals
  afterwards fails the same way one stage earlier.
- Specifications are looks too. Three specs × six thresholds is **eighteen**, and the
  NFL's best cell at p=0.029 raw corrects to 0.52.
- The next real test is EPA per play from nflverse (free, no key) rather than margin.
  That is new information; another pass over the same scores is not.

---

## Survivor

Objective is **P(last entrant standing)**, ties split — not P(survive). The season is
solved by charging the crowd's team a penalty λ in every week, assigning exactly, and
sweeping λ to trace the survival/separation frontier. Pool size drives the answer: the
recommended team changes at 50 entrants.

Pool labels derive from size unless named. Crowding comes from the popularity feed, and
**null crowding must become 0**, which collapses the model back to plain survival. Never
default it to a guess.

**The field as it stands** is stored per pool (`field`: entrants alive by losses already
taken, you included; `myLosses`). Without it every rival is simulated unbeaten, which is
true for exactly one week. A rival a loss down gets one fewer life; the field's exit
distribution is the head-count-weighted mix (measured above). Your plan runs on
`lossesAllowed - myLosses`. With a field recorded, `size` is its total, not a separate
number.

Recorded as **state, never as a weekly delta** — "90 unbeaten, 51 on one loss", not "51
lost this week". A delta must be applied exactly once; a state can be re-saved or re-run
any number of times. `collector/set_pool_field.py` (workflow `set-pool-field`, dry run by
default) applies it without the passcode and prints sizes and counts only — never `used`,
because Actions logs are public and picks are strategy.

`seasonGames` only returns `commence_time > NOW()`, so week numbers are counted from the
season **opener** (`seasonOpener`), never from the first block returned — that bug showed
"week 1" every week of the season and aimed pins at the wrong week.

**Two pools are kept off each other's team for the current week, by the owner's choice**
(2026-09-25): one bad week must not cost both entries. It was argued the other way — the
141-entry and 11-entry pools pay out separately, so the constraint can cost the better
pick in one of them — and the owner decided diversification is worth that. Do not reopen
it. The page states which team an entry was kept off and why.

---

## Access

Two passcodes, both checked in `middleware.ts` before any route.

`APP_PASSCODE` is the owner. `APP_VIEWER_PASSCODE` is a guest — optional, and with it
unset there are simply no guests. With **neither** set the app stays open, so you are
never locked out of your own data, and the header shows a red **unlocked** badge.

The line a guest cannot cross is **shared versus personal**, not read versus write:

- **Shared** — the board, the consensus, `/api/book-lines`, settings, notifications.
  Read by everyone, written by the owner. A quote typed into `book-lines` joins the
  consensus every price in the app is measured against, for everybody.
- **Personal** — the ledger. Every guest gets their own and writes it freely.
- **Survivor** is neither: owner-only for **strategy**, not privacy. The objective is
  P(last entrant standing) and its value comes from *not* holding the field's ticket —
  up to 1.43x par in a 137-entry pool. Showing a rival the pick gives that away free.

`viewerAllowed()` is an **allowlist** for API routes. The failure directions are not
symmetric: a missing entry means a guest sees a page that will not load, which they
report; a missing blocklist entry means a stranger writing to the consensus, which
nobody would notice.

It has to be a cookie rather than a bearer secret because the browser calls the write
endpoints itself, and a secret the client must send is in the bundle. The dispatchers
stay open because Actions has no cookie; they carry a bearer secret already.

The repo is **public**. Nothing secret has ever been committed (history was scanned; the
only connection strings are placeholders), and credentials live in Actions secrets and
Vercel env. **Actions logs are public too** — keep anything sensitive out of stdout, and
note `redact_url()` exists for exactly that reason.

**Guessing the passcode is rate-limited** (`unlock-limit.ts`, table `unlock_attempts`,
v22). Ten wrong guesses in fifteen minutes locks out that source; a hundred in an hour
across everyone locks out new logins from anywhere, which is what stops guesses spread
over many addresses. The global lock sounds like it could lock the owner out, and for a
*fresh* login during an attack it can — but the phone's year-long cookie never touches
`/api/unlock`, so an attacker can only block the login you make about once a year. The
check runs **before** the guess is compared, and if the database cannot be read the route
refuses rather than waving guesses through: a limit that turns off on a hiccup is one an
attacker only has to wait out. Addresses are stored as a SHA-256, never raw.

**The limit buys time; the passcode's length decides if it is enough.** At most 2,400
guesses a day get through: a 4-digit PIN falls in about two days, 6 digits in over half
a year, 12 random characters never.

Passcodes and dispatcher secrets are compared as fixed-length digests in constant time.
Every `/api/dispatch-*` route is public by the middleware's rule and must call
`refuseUnlessDispatcher` first; there used to be five hand-copied versions of that check.

Headers: HSTS comes from Vercel. The app adds nosniff, no framing, a strict referrer
policy, a Permissions-Policy switching off hardware it never uses, and a content policy
of `frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'` — no
`script-src`, deliberately: that needs a per-request nonce through every page, and a
wrong one fails as a blank screen.

**Dispatcher responses land in public Actions logs.** Report counts, never team names or
which games you hold money on.

## Whose ledger

`bets.owner_id`, schema v14. Two ways to be an owner and only two:

- **`HOUSE` (`'owner'`)** — whoever holds `APP_PASSCODE`. A fixed string, and
  deliberately **not a valid cookie value** (`validOwnerId` rejects it), so my ledger is
  not addressable by guessing or forging an identifier. It is also what v14 backfilled
  the existing season to.
- **A guest** — 128 random bits minted into a cookie by middleware. No email, no
  password, nothing stored about them. The cookie *is* the credential, which is an
  acceptable bar for a record of $5 bets and for nothing else, so nothing else is kept
  against it.

Every `bets-db` function takes the owner **first, with no default**. A forgotten filter
on a multi-tenant table does not throw — it returns other people's rows and produces a
win rate that describes nobody while looking exactly like one that describes you. The
required argument turns that into a compile error. Cron paths pass `HOUSE` explicitly
(no request means no cookie), which is the other reason there is no default: it would
make "I forgot" and "I meant the owner" the same line of code.

**Never fall back to `HOUSE` when `ownerId` is null.** Show nothing and say so. The
fallback's failure mode is showing a stranger my ledger.

`ledger_transfers` moves a guest ledger to a second device: eight characters, fifteen
minutes, one use, `DELETE ... RETURNING` so two devices racing cannot both win it.
Refused for the owner in both directions — the passcode already works on a phone, and a
code would be a second, weaker way in.


## Deploying

Push to `main`; Vercel builds. To confirm a deploy landed, poll for a string **only the
new build can produce** — not one the old build also had.
