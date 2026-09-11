"""What share of survivor entrants took each team.

The missing input for pool strategy, and the only one no amount of odds data
substitutes for.

Survival alone says take the biggest favourite every week. But a pool pays the LAST
entrant standing, so what matters is surviving weeks the field does not -- and whether
a pick separates you from the field is a fact about the other entrants, not about the
game. Without it, advice for a thirteen-person pool and a hundred-and-thirty-seven
person pool is necessarily the same advice, which it should not be.

Source: survivorgrid.com, which publishes an average across public Yahoo and ESPN
pools. Server-rendered, so no browser is needed, and its robots.txt disallows nothing.
Fetched once a week, because the number moves slowly and politeness costs nothing.

What this is NOT: it is a national average. For a large pool it is a reasonable proxy.
For a pool of thirteen it is a rough guide -- one entrant there is eight points of
share, and thirteen specific people need not resemble the country. The web app says so
where it uses these numbers.
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from odds_poller import (Context, DuckStore, HttpClient, MemoryStore, http_request,
                         utcnow)
from db import Database, clean_database_url, insert_sql
from schema import ensure_analytics_schema

LOG = logging.getLogger("pick_popularity")
UTC = timezone.utc
SOURCE = "survivorgrid"
URL = "https://www.survivorgrid.com/"

COLUMNS = ["league", "week", "team", "pick_share", "source_win_probability",
           "observed_at"]

#: Their table rows, in order: EV, win %, pick %, then the team abbreviation.
ROW = re.compile(
    r'<tr id="t\d+" data-team-id="\d+">\s*'
    r'<td class="dist">[-\d.]+</td>\s*'
    r'<td class="dist">([\d.]+)%</td>\s*'
    r'<td class="dist">([\d.]+)%</td>\s*'
    r'<td class="teamname">([A-Z]{2,4})</td>'
)

#: Abbreviation to the full name ESPN and the odds feed both use, so popularity can
#: join to a schedule. Written out rather than fuzzy-matched: there are thirty-two of
#: them, they do not change, and a wrong join here would attribute one team's
#: popularity to another.
TEAM_NAMES = {
    "ARI": "Arizona Cardinals", "ATL": "Atlanta Falcons", "BAL": "Baltimore Ravens",
    "BUF": "Buffalo Bills", "CAR": "Carolina Panthers", "CHI": "Chicago Bears",
    "CIN": "Cincinnati Bengals", "CLE": "Cleveland Browns", "DAL": "Dallas Cowboys",
    "DEN": "Denver Broncos", "DET": "Detroit Lions", "GB": "Green Bay Packers",
    "HOU": "Houston Texans", "IND": "Indianapolis Colts", "JAX": "Jacksonville Jaguars",
    "KC": "Kansas City Chiefs", "LV": "Las Vegas Raiders",
    "LAC": "Los Angeles Chargers", "LAR": "Los Angeles Rams", "MIA": "Miami Dolphins",
    "MIN": "Minnesota Vikings", "NE": "New England Patriots", "NO": "New Orleans Saints",
    "NYG": "New York Giants", "NYJ": "New York Jets", "PHI": "Philadelphia Eagles",
    "PIT": "Pittsburgh Steelers", "SF": "San Francisco 49ers", "SEA": "Seattle Seahawks",
    "TB": "Tampa Bay Buccaneers", "TEN": "Tennessee Titans",
    "WSH": "Washington Commanders", "WAS": "Washington Commanders",
}

#: Below this the page is not what we think it is. A real slate has most of the league
#: on it; a handful of rows means the markup changed and the regex is matching noise.
MIN_TEAMS = 20


def parse(body: bytes) -> list[tuple[str, float, float]]:
    """(team, pick share, their win probability) for every row on the page."""
    text = body.decode("utf-8", errors="replace")
    out = []
    for win, pick, abbreviation in ROW.findall(text):
        name = TEAM_NAMES.get(abbreviation)
        if name is None:
            # An unknown abbreviation is a silent mis-join waiting to happen; skip it
            # and let the caller notice the count is short.
            LOG.warning("unknown team abbreviation %r", abbreviation)
            continue
        out.append((name, float(pick) / 100.0, float(win) / 100.0))
    return out


def current_week(database: Database | None, now: datetime) -> int:
    """Which NFL week the page is describing.

    Counted from the first fixture the feed knows about rather than parsed off the
    page, so it agrees with how the planner numbers its weeks. The two must match or
    popularity attaches to the wrong slate.
    """
    if database is None:
        return 1
    row = database.fetchone(
        "SELECT MIN(commence_time) FROM season_games WHERE league = 'nfl'")
    first = row[0] if row else None
    if first is None:
        return 1
    if isinstance(first, str):
        first = datetime.fromisoformat(first.replace("Z", "+00:00"))
    if first.tzinfo is None:
        first = first.replace(tzinfo=UTC)
    # season_games holds only upcoming fixtures, so the earliest one IS this week.
    return max(1, int((now - first).days // 7) + 1) if now > first else 1


def main(argv: list[str] | None = None, *, request_fn: Callable = http_request,
         sleep_fn: Callable | None = None, clock: Callable = utcnow) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path("data/warehouse-v4.duckdb"))
    parser.add_argument("--postgres", action="store_true",
                        help="Write to DATABASE_URL instead of --db.")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--week", type=int, default=None,
                        help="Override the week this slate is filed under.")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s")
    logging.Formatter.converter = time.gmtime

    now = clock()
    summary: dict[str, Any] = {"type": "popularity_summary", "teams": 0, "week": None}
    store: Any = None

    try:
        if args.postgres:
            import os
            from pg_store import PostgresStore
            store = PostgresStore(clean_database_url(os.environ.get("DATABASE_URL")))
            database = Database.postgres(store.con)
        elif args.db.exists():
            store = DuckStore(args.db)
            database = Database.duckdb(store.con)
        else:
            store = MemoryStore()
            database = None

        if database is not None:
            ensure_analytics_schema(database)

        ctx = Context(store, "nfl", "pregame", now, now)
        client = HttpClient(ctx, request_fn=request_fn, sleep_fn=sleep_fn or time.sleep,
                            request_budget=3)
        result = client.fetch(URL, SOURCE, parse_json=False)
        if result is None:
            summary["errors"] = ctx.errors
            summary["exit_code"] = 2 if ctx.errors else 3
            print(json.dumps(summary, default=str))
            return summary["exit_code"]

        rows = parse(result.data if isinstance(result.data, bytes) else b"")

        week = args.week if args.week is not None else current_week(database, now)
        summary["week"] = week
        summary["teams"] = len(rows)
        summary["most_popular"] = max(rows, key=lambda r: r[1])[0] if rows else None

        if len(rows) < MIN_TEAMS:
            # Not "no data": a real slate is most of the league. A short list means the
            # markup moved and the regex is matching something else, which would write
            # a confident and wrong popularity table.
            ctx.issue(SOURCE, "unexpected_markup",
                      f"only {len(rows)} teams parsed; expected at least {MIN_TEAMS}. "
                      "The page layout has probably changed.")
            summary["errors"] = ctx.errors
            summary["exit_code"] = 2
            print(json.dumps(summary, default=str))
            return 2

        if not args.dry_run and database is not None:
            database.execute(
                "DELETE FROM pick_popularity WHERE league = ? AND week = ?", ["nfl", week])
            for team, share, win in rows:
                database.execute(
                    insert_sql("pick_popularity", COLUMNS),
                    ["nfl", week, team, share, win, now])
            database.commit()
            summary["written"] = len(rows)

        summary["errors"] = ctx.errors
        summary["exit_code"] = 0 if rows else 3
        print(json.dumps(summary, default=str))
        return summary["exit_code"]

    except KeyboardInterrupt:
        return 130
    except Exception as error:
        LOG.error("pick_popularity failed (%s): %s", type(error).__name__, error)
        return 2
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
