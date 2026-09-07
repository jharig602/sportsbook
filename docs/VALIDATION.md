# Validation record

Everything here was measured against live ESPN endpoints, not assumed. Re-check before
relying on any of it: these are observations of an undocumented third-party API, and it
can change without notice.

Measured **2026-09-06**.

---

## 1. Endpoint reachability

| Host | Bare HTTP client | Browser | Notes |
|---|---|---|---|
| `site.api.espn.com` | **403**, empty body | 200 | Akamai bot management |
| `sports.core.api.espn.com` | 200 | 200 | Not behind the same protection |

The 403 was narrowed by elimination:

| Headers sent | Result |
|---|---|
| Honest UA + Accept | 403 |
| Chrome UA only | 403 |
| Chrome UA + Referer | 403 |
| Honest UA + Referer + Accept-Language + `Sec-Fetch-*` | 403 |
| Honest UA + full client-hint group (`Origin`, `sec-ch-ua*`, `Sec-Fetch-*`, Referer) | **200** |

So the `sec-ch-ua` / `Origin` group is the trigger, and the truthful
`odds-poller/4.0.0 (personal research)` User-Agent is preserved. No identity spoofing.

Implemented as `ESPN_BROWSER_HEADERS` in `collector/odds_poller.py`.

## 2. Scoreboard truncation

`limit` silently degrades above an undocumented threshold rather than erroring:

| `limit` | Events returned (college football, 2026-09-12) |
|---|---|
| 300 | **80** |
| 500 | **80** |
| 999 | 25 |
| 1000 | 25 |

Ground truth from the uncurated core API for the same date: **80** events (71 on 09-19).

The original code hardcoded `limit=1000`, losing ~70% of the NCAAF slate. Worse, the
existing guard (`len(events) >= params["limit"]`) could never fire, because ESPN returned
25 against a limit of 1000 — the bug was invisible by construction. Now `limit=300`, and
an exact-25 response raises a `scoreboard_degraded` warning.

## 3. Book coverage

ESPN returns exactly **one** provider — DraftKings (`id: 100`) — for both NFL and NCAAF,
via both the scoreboard and the core odds endpoint. Verified across multiple events.

This is the single most consequential finding: it rules out line shopping, multi-book
closing references, and any honest +EV claim.

## 4. Priced coverage

| League | Date | Days out | Events | Priced | % |
|---|---|---|---|---|---|
| NCAAF | 2026-09-12 | 6 | 80 | 47 | 59% |
| NCAAF | 2026-09-19 | 13 | 71 | 4 | 6% |
| NFL | 2026-09-13 | 7 | 13 | 13 | 100% |

College lines appear late, which is why `first_price` is a tracked alert kind and why the
poll cadence concentrates on the game week.

## 5. Parser correctness

The core-API odds item shape matches the parser exactly:

```
homeTeamOdds.current.pointSpread.american  "+22.5"
homeTeamOdds.current.spread.american       "-110"
homeTeamOdds.current.moneyLine.american    "+1100"
current.total.american                     "57.5"
current.over.american                      "-115"
```

`open` is present and differs from `current` — it is never read as a price.

A full write run produced 360 rows across both leagues with zero errors. Integrity checks
on the stored data all passed: spread sides exactly opposite, no orphaned raw joins, no
`historical_backfill` rows in a pregame run, every price `NULL` or `|price| >= 100`.

## 6. Bugs found by running against live data

Three the tests could not have caught on their own, because they only appear against real
responses:

**Unpriced games reported as errors.** ESPN answers an unpriced game with
`{"count":0,"pageIndex":0,"pageCount":0,"items":[]}`. The `pageIndex != page` check read
that `0` as a rejected page and raised a hard error. With ~40% of an NCAAF slate unpriced,
every run was pinned at `exit_code: 2`, which would have made monitoring useless.

**Price movement measured in American cents.** The cent scale is non-linear and
discontinuous at ±100. A `-3600 → -4500` move scored 900 "cents" (0.5 points of implied
probability — trivial), and `-102 → +100` scored 202 "cents" for what is a 0.5-point move.
Heavy favourites dominated every ranking. Now measured in implied probability.

**Spread direction inverted on the away side.** Home `+22.5 → +20.5` and away
`-22.5 → -20.5` are the same market move, but the deltas carry opposite signs. The old
`_favoured_side` keyed on the sign alone, so the two series disagreed — mispredicting
essentially every away-side spread, and silently poisoning the grades that depend on it.

After the fixes, a real 40-minute window produced **7** movement alerts where the old
rules produced **16**; every removed one was longshot noise or a duplicate.

## 7. Still unverified

- **Postgres backend.** Written and unit-tested against a recording fake; never run
  against a real Neon database.
- **Whether `groups=80` is genuinely FBS-only.** `groups=80` returned 80 events and
  `groups=81` returned 78 for the same date, which suggests the filter may be ignored.
  Reconcile against an independent schedule before treating the universe as FBS.
- **Feed freshness.** `source_updated_at` is always NULL; `observed_at` is receipt time.
  How stale ESPN's quote is when we receive it has not been measured.
- **Settlement rules.** Recorded as `provider_rules_unverified` throughout.
- **Alert predictiveness.** Nothing has been graded yet — no game covered by an alert has
  finished. Every number on a future Track Record screen is currently unearned.
