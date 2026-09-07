"""Bulk historical score backfill.

Pulls final scores across a long date range so the margin model has real seasons to
fit against instead of textbook constants. One scoreboard request per date, same
endpoint the daily collector uses.

This backfills **results only**, never odds. Historical odds from ESPN carry a
present-day observation timestamp for a past line, which would manufacture movement
that never happened — the collector already labels those `historical_backfill` and
excludes them from every movement series, and there is no reason to import more.

What this does and does not buy:

* It **does** let us model how football scores behave — the spread of final margins,
  and how much probability piles up on 3 and 7. That is what converts a spread into a
  win probability, and it needs no forward data at all.
* It does **not** say whether our alerts predict anything. That question is about our
  own signals and can only be answered by grading them going forward.
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from datetime import date, datetime, time as day_time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from db import Database, clean_database_url
from odds_poller import Context, DuckStore, HttpClient, MemoryStore, http_request, utcnow
from results import poll_results, store_results

LOG = logging.getLogger("backfill")
UTC = timezone.utc

# Football is not played every day. Skipping the empty ones removes roughly a third of
# the requests for nothing lost: Tue/Wed have essentially no games in either league.
PLAY_DAYS = {0, 3, 4, 5, 6}  # Mon, Thu, Fri, Sat, Sun


def date_range(start: date, end: date, play_days_only: bool) -> list[date]:
    days, cursor = [], start
    while cursor <= end:
        if not play_days_only or cursor.weekday() in PLAY_DAYS:
            days.append(cursor)
        cursor += timedelta(days=1)
    return days


def main(argv: list[str] | None = None, *, request_fn: Callable = http_request,
         sleep_fn: Callable | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", required=True, choices=["ncaaf", "nfl"])
    parser.add_argument("--start", required=True, type=date.fromisoformat)
    parser.add_argument("--end", required=True, type=date.fromisoformat)
    parser.add_argument("--db", type=Path, default=Path("data/dev.duckdb"))
    parser.add_argument("--postgres", action="store_true",
                        help="Write to DATABASE_URL instead of --db.")
    parser.add_argument("--all-days", action="store_true",
                        help="Query every date, not just typical game days.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if args.end < args.start:
        parser.error("--end must not precede --start")
    if args.end > utcnow().date():
        parser.error("Cannot backfill results for future dates")

    days = date_range(args.start, args.end, not args.all_days)
    if not days:
        parser.error("Date range contains no game days; pass --all-days to force")

    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s")
    logging.Formatter.converter = time.gmtime
    LOG.info("Backfilling %s: %d dates from %s to %s", args.league, len(days),
             args.start, args.end)

    store: Any = None
    try:
        if args.dry_run:
            store = MemoryStore()
        elif args.postgres:
            import os
            from pg_store import PostgresStore
            store = PostgresStore(clean_database_url(os.environ.get("DATABASE_URL")))
        else:
            store = DuckStore(args.db)

        window_start = datetime.combine(args.start, day_time.min, UTC)
        ctx = Context(store, args.league, "historical", window_start,
                      datetime.combine(args.end + timedelta(days=1), day_time.min, UTC))
        client = HttpClient(ctx, request_fn=request_fn, sleep_fn=sleep_fn or time.sleep,
                            request_budget=len(days) + 50)

        total = 0
        for day in days:
            # poll_results takes a start date and a span; one date at a time keeps the
            # request budget and the progress log honest over a months-long range.
            rows = poll_results(client, day, 1)
            if rows and not args.dry_run:
                handle = (Database.postgres(store.con) if args.postgres
                          else Database.duckdb(store.con))
                store_results(handle, rows)
            total += len(rows)

        summary = {
            "type": "backfill_summary", "league": args.league,
            "start": args.start.isoformat(), "end": args.end.isoformat(),
            "dates_queried": len(days), "results": total,
            "errors": ctx.errors, "warnings": ctx.warnings,
        }
        summary["exit_code"] = 2 if ctx.errors else (0 if total else 3)
        print(json.dumps(summary))
        return summary["exit_code"]
    except KeyboardInterrupt:
        LOG.error("Interrupted; results written so far are retained.")
        return 130
    except Exception as error:
        LOG.error("Backfill failed (%s): %s", type(error).__name__, error)
        return 2
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
