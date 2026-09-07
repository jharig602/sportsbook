"""Closing spreads for completed games, so the margin model fits residuals.

Fitting the *raw* margin distribution is a trap, and the data says so loudly: raw
college margins show a +10.7 point home-field edge, which is not home-field advantage
at all — it is Power-conference teams scheduling overmatched visitors at home. The
unconditional distribution measures mismatches.

What actually governs covering is the **residual**: ``margin + home_spread``. That
takes the market's own estimate of team strength out and leaves the part no one can
predict. Its spread and its lumpiness at 3 and 7 are what convert a spread into a win
probability, and its mean is a direct measurement of whether the market is biased.

One request per completed game, so this is a deliberate one-off rather than anything
the scheduler runs.
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from datetime import timezone
from pathlib import Path
from typing import Any, Callable

from db import Database, clean_database_url, insert_sql
from odds_poller import CORE_API, LEAGUES, Context, DuckStore, HttpClient, http_request, mapping, number, utcnow
from schema import ensure_analytics_schema

LOG = logging.getLogger("backfill_lines")
UTC = timezone.utc

COLUMNS = ["event_id", "league", "provider", "home_spread", "total", "fetched_at"]


def closing_line(client: HttpClient, league: str, event_id: str):
    """(provider, home_spread, total) for a completed game, or None."""
    sport, path, _ = LEAGUES[league]
    url = f"{CORE_API}/{sport}/leagues/{path}/events/{event_id}/competitions/{event_id}/odds"
    result = client.fetch(url, "espn", {"limit": 100}, allow_404=True)
    if result is None or not isinstance(result.data, dict):
        return None

    for item in result.data.get("items", []):
        if not isinstance(item, dict):
            continue
        provider = mapping(item.get("provider"))
        name = provider.get("name") or provider.get("displayName")
        if isinstance(name, str) and "live" in name.lower():
            continue
        # ESPN's top-level `spread` is home-oriented, the same convention the live
        # collector verified against current games.
        spread = number(item.get("spread"))
        total = number(item.get("overUnder"))
        if spread is None and total is None:
            continue
        return (name, spread, total if (total or 0) > 0 else None)
    return None


def main(argv: list[str] | None = None, *, request_fn: Callable = http_request,
         sleep_fn: Callable | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", choices=["ncaaf", "nfl"])
    parser.add_argument("--db", type=Path, default=Path("data/dev.duckdb"))
    parser.add_argument("--postgres", action="store_true")
    parser.add_argument("--limit", type=int, default=2000)
    parser.add_argument("--delay", type=float, default=0.35,
                        help="Politeness delay. Lower than the collector's because this "
                             "is a one-off bulk read, not a recurring job.")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s")
    logging.Formatter.converter = time.gmtime

    store: Any = None
    try:
        if args.postgres:
            import os
            from pg_store import PostgresStore
            store = PostgresStore(clean_database_url(os.environ.get("DATABASE_URL")))
            database = Database.postgres(store.con)
        else:
            store = DuckStore(args.db)
            database = Database.duckdb(store.con)
        ensure_analytics_schema(database)

        clause = "AND league = ?" if args.league else ""
        pending = database.fetchall(
            f"""SELECT event_id, league FROM game_results
                 WHERE completed = TRUE {clause}
                   AND event_id NOT IN (SELECT event_id FROM historical_lines)
                 ORDER BY commence_time DESC LIMIT {int(args.limit)}""",
            [args.league] if args.league else None,
        )
        LOG.info("Fetching closing lines for %d completed games", len(pending))
        if not pending:
            print(json.dumps({"type": "lines_summary", "fetched": 0, "status": "nothing_pending"}))
            return 0

        ctx = Context(store, pending[0][1], "historical", utcnow(), utcnow())
        client = HttpClient(ctx, request_fn=request_fn, sleep_fn=sleep_fn or time.sleep,
                            delay=args.delay, request_budget=len(pending) + 100)

        written = missing = 0
        for index, (event_id, league) in enumerate(pending, 1):
            found = closing_line(client, league, event_id)
            if found is None:
                missing += 1
                continue
            provider, spread, total = found
            database.execute(
                insert_sql("historical_lines", COLUMNS),
                [event_id, league, provider, spread, total, utcnow()],
            )
            written += 1
            if index % 100 == 0:
                LOG.info("  %d/%d  written=%d missing=%d", index, len(pending), written, missing)

        database.commit()
        summary = {"type": "lines_summary", "requested": len(pending),
                   "written": written, "missing": missing, "errors": ctx.errors}
        summary["exit_code"] = 2 if ctx.errors else (0 if written else 3)
        print(json.dumps(summary))
        return summary["exit_code"]
    except KeyboardInterrupt:
        LOG.error("Interrupted; lines written so far are retained.")
        return 130
    except Exception as error:
        LOG.error("Line backfill failed (%s): %s", type(error).__name__, error)
        return 2
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
