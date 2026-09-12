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

## Scheduling reality

`.github/workflows/collect.yml` asks for ~5 runs a day midweek and ~48 at a weekend.
**GitHub delivers 3–5 a day, at arbitrary minutes.** Measured over five days: zero landed
in the old two-hour promo window.

This is not a minutes problem — usage is ~320 of the 2,000 free private minutes a month
(16%). It is the scheduler dropping a cron that asks for too much.

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

## Deploying

Push to `main`; Vercel builds. To confirm a deploy landed, poll for a string **only the
new build can produce** — not one the old build also had.
