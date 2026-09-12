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

The **Record** page grid cuts cover rate by market × league. Every cell is judged twice:
`alone` (z=1.96, the naive number, not safe to act on) and `adjusted` (Bonferroni across
the six). `selection.familyP` prices the search itself — the probability *some* cell
reads as well as the best one does when nothing has any edge. It is usually large.

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

`collector/schema.py` owns it. `ANALYTICS_SCHEMA_VERSION` is currently **13**.

Additive tables go in the DDL (all `CREATE TABLE IF NOT EXISTS`). **New columns must be
added to `ANALYTICS_MIGRATIONS`** or they will not exist on an upgraded database.

**Always push a schema change and run the migration before deploying web code that
selects the new column.** Push `collector/schema.py` alone, `gh workflow run collect`,
wait for it, then push the web change.

---

## The ledger

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

## Survivor

Objective is **P(last entrant standing)**, ties split — not P(survive). The season is
solved by charging the crowd's team a penalty λ in every week, assigning exactly, and
sweeping λ to trace the survival/separation frontier. Pool size drives the answer: the
recommended team changes at 50 entrants.

Pool labels derive from size unless named. Crowding comes from the popularity feed, and
**null crowding must become 0**, which collapses the model back to plain survival. Never
default it to a guess.

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
