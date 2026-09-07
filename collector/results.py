"""Final-score capture.

Grading needs outcomes, and ESPN hands them back on the same scoreboard endpoint the
collector already uses — one request per date, no extra source and no extra key.

Deliberately separate from ``odds_poller``: results are pulled *after* games end, so
they are neither pregame observations nor a historical odds backfill, and mixing them
into that module's forward/backfill distinction would blur a line worth keeping sharp.
"""
from __future__ import annotations

import argparse
import json
import logging
import sys
from dataclasses import asdict, dataclass
from datetime import date, datetime, time as day_time, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from odds_poller import (LEAGUES, SITE_API, SCOREBOARD_LIMIT, Context, DuckStore,
                         HttpClient, MemoryStore, http_request, mapping, number,
                         timestamp, utcnow)
from db import Database
from schema import ensure_analytics_schema

LOG = logging.getLogger("results")
UTC = timezone.utc

# American football plays four quarters. Anything beyond that is overtime, which counts
# toward full-game totals at every mainstream book.
REGULATION_PERIODS = 4

FINAL_STATUSES = {"STATUS_FINAL", "STATUS_FINAL_OVERTIME"}


@dataclass
class GameResultRow:
    event_id: str
    league: str
    commence_time: datetime
    home_team_id: str | None
    away_team_id: str | None
    home_team: str | None
    away_team: str | None
    home_score: int
    away_score: int
    periods: int | None
    went_overtime: bool
    status: str
    completed: bool
    observed_at: datetime
    run_id: str
    response_id: str


def parse_result(ev: dict, competition: dict, league: str, run_id: str,
                 response_id: str, observed_at: datetime) -> GameResultRow | None:
    """Build a result row, or None when the game has not finished cleanly.

    Only completed games are returned. A postponed, cancelled or in-progress game has
    no score worth grading against, and inventing a 0-0 for one would silently score
    every alert on it as a loss.
    """
    status = mapping(competition.get("status")) or mapping(ev.get("status"))
    status_type = mapping(status.get("type"))
    status_name = str(status_type.get("name", "UNKNOWN"))
    if not status_type.get("completed"):
        return None

    teams: dict[str, dict] = {}
    for competitor in competition.get("competitors", []):
        if isinstance(competitor, dict) and competitor.get("homeAway"):
            teams[competitor["homeAway"]] = competitor
    home, away = teams.get("home"), teams.get("away")
    if not home or not away:
        return None

    home_score, away_score = number(home.get("score")), number(away.get("score"))
    if home_score is None or away_score is None:
        return None
    if home_score < 0 or away_score < 0:
        return None

    start = timestamp(competition.get("date") or ev.get("date"))
    if start is None:
        return None

    periods = number(status.get("period"))
    period_count = int(periods) if periods is not None else None
    went_overtime = bool(period_count and period_count > REGULATION_PERIODS)

    home_team = mapping(home.get("team"))
    away_team = mapping(away.get("team"))
    return GameResultRow(
        event_id=str(ev["id"]),
        league=league,
        commence_time=start,
        home_team_id=str(home_team["id"]) if home_team.get("id") is not None else None,
        away_team_id=str(away_team["id"]) if away_team.get("id") is not None else None,
        home_team=home_team.get("displayName"),
        away_team=away_team.get("displayName"),
        home_score=int(home_score),
        away_score=int(away_score),
        periods=period_count,
        went_overtime=went_overtime,
        status=status_name,
        completed=True,
        observed_at=observed_at,
        run_id=run_id,
        response_id=response_id,
    )


def poll_results(client: HttpClient, start_date: date, days: int) -> list[GameResultRow]:
    ctx = client.ctx
    sport, league_path, group = LEAGUES[ctx.league]
    rows: list[GameResultRow] = []
    seen: set[str] = set()

    for offset in range(days):
        params: dict[str, Any] = {
            "dates": (start_date + timedelta(days=offset)).strftime("%Y%m%d"),
            "limit": SCOREBOARD_LIMIT,
        }
        if group:
            params["groups"] = group
        result = client.fetch(f"{SITE_API}/{sport}/{league_path}/scoreboard", "espn", params)
        if result is None:
            continue
        if not isinstance(result.data, dict) or not isinstance(result.data.get("events"), list):
            ctx.issue("espn", "scoreboard_schema", "Scoreboard has no events list.",
                      response_id=result.response_id)
            continue

        for ev in result.data["events"]:
            ctx.count("espn", "events_discovered")
            try:
                if not isinstance(ev, dict) or not ev.get("id"):
                    raise ValueError("Event has no id.")
                if not isinstance(ev.get("competitions"), list):
                    raise ValueError("Event has no competitions list.")
                if str(ev["id"]) in seen:
                    continue
                for competition in ev["competitions"]:
                    row = parse_result(ev, competition, ctx.league, ctx.run_id,
                                       result.response_id, result.received_at)
                    if row is None:
                        ctx.count("espn", "events_not_final")
                        continue
                    seen.add(row.event_id)
                    rows.append(row)
                    ctx.count("espn", "results_captured")
                    if row.went_overtime:
                        ctx.count("espn", "overtime_games")
            except (TypeError, ValueError, AttributeError) as error:
                ctx.issue("espn", "result_schema", str(error), response_id=result.response_id)
    return rows


def store_results(connection, rows: list[GameResultRow]) -> int:
    """Upsert results. A game can be re-polled; the latest capture wins.

    Accepts a raw DuckDB connection or a ``Database``, so local scripts and the
    Postgres path can both call it.
    """
    database = connection if isinstance(connection, Database) else Database.duckdb(connection)
    ensure_analytics_schema(database)
    written = 0
    for row in rows:
        values = asdict(row)
        # Delete-then-insert rather than an upsert: the column list stays in step with
        # the dataclass automatically, and a re-poll should replace a row wholesale
        # (a corrected score is a correction, not a merge).
        database.execute("DELETE FROM game_results WHERE event_id = ?", [row.event_id])
        database.execute(
            f"INSERT INTO game_results ({','.join(values)}) "
            f"VALUES ({','.join('?' for _ in values)})",
            list(values.values()),
        )
        written += 1
    database.commit()
    return written


def main(argv: list[str] | None = None, *, request_fn: Callable = http_request,
         sleep_fn: Callable | None = None) -> int:
    import time

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", required=True, choices=sorted(LEAGUES))
    parser.add_argument("--start-date", type=date.fromisoformat,
                        help="YYYY-MM-DD; defaults to yesterday")
    parser.add_argument("--days", type=int, default=2)
    parser.add_argument("--db", type=Path, default=Path("data/warehouse-v4.duckdb"))
    parser.add_argument("--postgres", action="store_true",
                        help="Write to DATABASE_URL instead of --db.")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    if not 1 <= args.days <= 31:
        parser.error("--days must be between 1 and 31")

    start_date = args.start_date or (utcnow().date() - timedelta(days=1))
    if start_date > utcnow().date():
        parser.error("Results cannot be captured for future dates")

    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s")
    logging.Formatter.converter = time.gmtime

    store: Any = None
    try:
        if args.dry_run:
            store = MemoryStore()
        elif args.postgres:
            import os
            from db import clean_database_url
            from pg_store import PostgresStore
            try:
                database_url = clean_database_url(os.environ.get("DATABASE_URL"))
            except ValueError as error:
                parser.error(str(error))
            store = PostgresStore(database_url)
        else:
            store = DuckStore(args.db)
        window_start = datetime.combine(start_date, day_time.min, UTC)
        ctx = Context(store, args.league, "historical", window_start,
                      window_start + timedelta(days=args.days))
        client = HttpClient(ctx, request_fn=request_fn,
                            sleep_fn=sleep_fn or time.sleep)
        rows = poll_results(client, start_date, args.days)

        written = 0
        if not args.dry_run:
            handle = (Database.postgres(store.con) if args.postgres
                      else Database.duckdb(store.con))
            written = store_results(handle, rows)
        else:
            for row in rows[:10]:
                print(json.dumps({"type": "preview", **asdict(row)}, default=str))

        summary = {
            "type": "results_summary", "run_id": ctx.run_id, "league": args.league,
            "start_date": start_date.isoformat(), "days": args.days,
            "results": len(rows), "written": written,
            "errors": ctx.errors, "warnings": ctx.warnings,
            "sources": ctx.stats,
            "status": "incomplete" if ctx.errors else ("ok" if rows else "no_data"),
        }
        summary["exit_code"] = 2 if ctx.errors else (0 if rows else 3)
        print(json.dumps(summary))
        return summary["exit_code"]
    except KeyboardInterrupt:
        LOG.error("Interrupted; raw responses already committed are retained.")
        return 130
    except Exception as error:
        LOG.error("Results capture failed (%s).", type(error).__name__)
        if isinstance(error, (ImportError, ValueError)):
            LOG.error("%s", error)
        return 2
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
