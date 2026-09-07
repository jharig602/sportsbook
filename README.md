# NCAAF / NFL line-movement tracker

Collects DraftKings full-game spreads, totals and moneylines from ESPN, detects line
movement, grades every alert against what actually happened, and learns from the result.

**This does not tell you which bets are +EV, and will not until it has earned the right.**
See [What this deliberately does not claim](#what-this-deliberately-does-not-claim).

## Status

| Piece | State |
|---|---|
| Collector (ESPN odds) | Working. 80 NCAAF + 14 NFL events per poll, 0 errors |
| Results capture (final scores) | Working. 68 games in one request |
| Signal engine (4 alert kinds) | Working, validated against live movement |
| Grading + calibration | Working; awaiting settled games to grade |
| Postgres / Neon backend | Written, not yet run against a real database |
| GitHub Actions schedule | Written, not yet installed |
| Next.js PWA (board, movers, game detail, track record) | Working against real data |
| Stake sizing + web push | Built; push needs VAPID keys in Vercel |
| 187 Python + 16 web tests | Passing |

## Setup

```bash
winget install Python.Python.3.12
python -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
.venv\Scripts\python.exe -m pytest tests/ -q
```

Always invoke `.venv\Scripts\python.exe` explicitly — the Microsoft Store `python.exe`
stub shadows real installs on PATH.

## Running it locally

```bash
.venv\Scripts\python.exe collector/odds_poller.py --league ncaaf --days 8 --db data/dev.duckdb
.venv\Scripts\python.exe collector/results.py --league ncaaf --start-date 2026-09-05 --days 2 --db data/dev.duckdb
.venv\Scripts\python.exe collector/pipeline.py --db data/dev.duckdb
```

Add `--dry-run` to any collector command to hit the network but write nothing.

Exit codes: `0` ok, `2` incomplete (real errors occurred), `3` no data (an empty slate —
legitimate midweek, and not a failure).

## Architecture

```
GitHub Actions (cron)
   └── odds_poller.py ──┐
       results.py    ───┼──> Neon Postgres ──> Next.js PWA on Vercel
       pipeline.py   ───┘    raw / snapshots / alerts / grades
```

| Module | Responsibility |
|---|---|
| `collector/odds_poller.py` | Fetch odds. Raw bytes committed before parsing |
| `collector/results.py` | Final scores, so alerts can be graded |
| `collector/signals.py` | Detect movement, emit falsifiable predictions |
| `collector/grading.py` | Score alerts on line value and on result |
| `collector/calibration.py` | Walk-forward fitting; refuses on thin data |
| `collector/pipeline.py` | Runs the loop; every stage idempotent |
| `collector/pg_store.py` | Postgres backend + raw-response retention |

## Alert kinds

| Kind | Fires when |
|---|---|
| `first_price` | A market gets its opening number (softest price a book posts) |
| `steam` | Line moves ≥1.5 pts, or implied probability moves ≥1.5 pts, since last poll |
| `key_number` | Spread crosses ±3, ±7, ±10; total crosses 44, 47, 51 |
| `drift` | Cumulative move since the open exceeds 3 pts |

Thresholds live in `RuleConfig` in `collector/signals.py`. Changing any of them mints a
new `rule_version_id` (a content hash), so past alerts stay attributable to the exact
rules that produced them and retuning can never silently reinterpret history.

## Deploying

### The web app (Vercel)

**Set Root Directory to `web`.** It lives under *Settings → Build and Deployment*, not
General. Miss it and Vercel builds from the repo root, finds no Next.js app, and deploys
an empty output — every route 404s including static files like `/sw.js`, while the build
itself reports success. That symptom means this setting, essentially always.

The database comes from the Vercel Neon integration (*Storage → Create Database*). It
injects the connection variables itself. If it asks for a variable-name prefix, something
called `DATABASE_URL` already exists in that project — check you are in the right project
before accepting a prefix, because an existing `DATABASE_URL` takes priority over a
prefixed one and the app would use the stale value.

Then add the push variables by hand: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`,
`VAPID_SUBJECT`, `ALERT_DISPATCH_SECRET`, `ALERT_MIN_STRENGTH`.

**Check it worked** on the Board, top right: `db · DATABASE_URL` means connected;
`sample data` with an amber banner means it is serving the bundled fixture.

### The collector (GitHub Actions)

The Vercel integration only feeds Vercel, so the collector needs its own copy of the
connection string.

1. Copy the **pooled** Neon string (it has `-pooler` in the hostname).
2. Add these in **Settings → Secrets and variables → Actions**:
   - `DATABASE_URL` — exactly this name; the Python collector has no prefix fallback
   - `APP_URL` — the Vercel URL, no trailing slash (enables notifications)
   - `ALERT_DISPATCH_SECRET` — the same value set in Vercel
3. Run the workflow manually once. Look for `"events_discovered": 80` on the NCAAF step.

`.github/workflows/collect.yml` then polls every 30 min Fri–Sun and every 3 h Mon–Thu.

### Operational gotchas

- **Vercel Deployment Protection** blocks the whole site behind a login, including
  `/api/dispatch-alerts`. Notifications fail silently and the app will not open on a
  phone. Turn it off for production, or restrict it to preview deployments.
- **Scheduled workflows auto-disable after 60 days of repository inactivity.** A quiet
  offseason will silently stop collection.
- **Neon free-tier projects pause when idle.** The cron keeps it warm; a long gap
  between runs means the first one after it may be slow.

## Stake sizing

Set a bankroll and unit size on the About screen. It is stored in your browser only —
never sent to a server, never in the repo.

Every pick shows the **same** flat stake, regardless of Move Strength. That is deliberate:
sizing by a signal that has not been shown to predict anything concentrates money on the
alerts that merely *look* strongest, which loses faster than flat betting rather than
slower. Quarter-Kelly sizing switches on by itself, per Move Strength bucket, once that
bucket has 50+ settled games and a measured win rate that clears the price offered. A
hard per-bet cap (default 3% of bankroll) binds in both modes.

## What this deliberately does not claim

ESPN exposes exactly **one** sportsbook (DraftKings). With one book there is no price to
shop against and no consensus to measure against, so:

- **No +EV claims.** Expected value needs a price better than fair. Nothing here can
  establish what fair is.
- **`move_strength` is not a probability.** It is a bounded 0–99 ordering device over how
  unusual a move is. It becomes a probability only after `calibration.py` has fitted it
  against enough settled games, and only for buckets that clear their baselines.
- **Line value is not CLV.** Closing-line value compares against a sharp consensus. What
  is measured here is whether DraftKings' own line kept moving the way the alert said —
  a real, checkable statistic, and a weaker claim.
- **The closing number is a proxy.** It is the last quote observed before kickoff, not a
  verified close.

The expected finding is that these alerts show **no durable edge** — line movement in a
liquid market is mostly efficient. The system is built to detect that and say so. A
tracker that could only ever confirm itself would be worthless.

## Verified against live data (2026-09-06)

Findings that shaped the code, all reproducible:

| Finding | Consequence |
|---|---|
| `site.api.espn.com` 403s bare HTTP clients | Needs the fetch-metadata/client-hint header group. The honest User-Agent is fine |
| Scoreboard `limit=1000` returns 25 events; `limit=300` returns 80 | Silent 70% truncation of NCAAF |
| Unpriced games return `pageIndex: 0` | Was read as a pagination error, pinning every run at exit 2 |
| ESPN returns one book for both leagues | No shopping, no CLV, no +EV |
| NCAAF priced coverage: 59% at 6 days, 6% at 13 days | Poll inside the game week |
| NFL coverage: 13/13 events, 100% priced | Clean control group |

See [docs/VALIDATION.md](docs/VALIDATION.md) for the full record.
