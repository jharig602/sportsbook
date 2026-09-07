"""Postgres (Neon) storage backend for the collector.

Mirrors ``odds_poller.DuckStore``'s interface — ``add_raw`` / ``add_issue`` / ``finish``
/ ``close`` — so the collector does not care which it is writing to.

Two things preserved from the DuckDB backend because they are the point of the design:

* **Raw first.** Full response bytes are committed *before* any parsing is attempted,
  so a schema surprise leaves evidence rather than a gap.
* **Append only.** Repeated observations accumulate; nothing is updated in place.

On storage: raw bodies are not gzipped in application code. Postgres TOAST already
compresses out-of-line values transparently, so a second layer would mostly add a
decode step to every read. Size is managed by ``prune_raw_responses`` instead, which
keeps normalized snapshots forever and drops only the raw bodies behind them.
"""
from __future__ import annotations

import json
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from typing import Any

from db import Database
from schema import ensure_analytics_schema

UTC = timezone.utc
SCHEMA_VERSION = 4

# Same tables as odds_poller.DDL, in Postgres types: BLOB -> BYTEA, DOUBLE -> DOUBLE
# PRECISION, and CREATE OR REPLACE VIEW since Postgres has no CREATE VIEW IF NOT EXISTS.
PG_DDL = """
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS raw_responses (
    response_id VARCHAR PRIMARY KEY, run_id VARCHAR NOT NULL,
    source VARCHAR NOT NULL, url VARCHAR NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL,
    attempt INTEGER NOT NULL, status_code INTEGER, headers_json VARCHAR,
    body BYTEA NOT NULL, sha256 VARCHAR NOT NULL, error_kind VARCHAR
);
CREATE TABLE IF NOT EXISTS odds_snapshots (
    snapshot_id VARCHAR PRIMARY KEY, run_id VARCHAR NOT NULL,
    response_id VARCHAR NOT NULL, event_response_id VARCHAR NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL, source_updated_at TIMESTAMPTZ,
    source VARCHAR NOT NULL, league VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL, competition_id VARCHAR NOT NULL,
    commence_time TIMESTAMPTZ NOT NULL, event_state VARCHAR NOT NULL,
    observation_kind VARCHAR NOT NULL,
    home_team_id VARCHAR, away_team_id VARCHAR, home_team VARCHAR, away_team VARCHAR,
    book_id VARCHAR, book VARCHAR NOT NULL, market VARCHAR NOT NULL,
    period VARCHAR NOT NULL, settlement_rules VARCHAR NOT NULL, side VARCHAR NOT NULL,
    line DOUBLE PRECISION, price BIGINT, price_status VARCHAR NOT NULL,
    quote_fields VARCHAR NOT NULL, availability_verified BOOLEAN NOT NULL,
    parser_version VARCHAR NOT NULL,
    CHECK (price IS NULL OR price <= -100 OR price >= 100),
    CHECK (price IS NULL OR price_status = 'present'),
    CHECK (observation_kind IN ('pregame_observation', 'historical_backfill'))
);
CREATE TABLE IF NOT EXISTS poll_issues (
    issue_id VARCHAR PRIMARY KEY, run_id VARCHAR NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL, source VARCHAR NOT NULL,
    severity VARCHAR NOT NULL, code VARCHAR NOT NULL,
    event_id VARCHAR, response_id VARCHAR, message VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_runs (
    run_id VARCHAR PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL, status VARCHAR NOT NULL,
    exit_code INTEGER NOT NULL, config_json VARCHAR NOT NULL, summary_json VARCHAR NOT NULL
);
"""

# The app reads these constantly; without them every board render is a sequential scan.
PG_INDEXES = """
CREATE INDEX IF NOT EXISTS odds_event_market_side_idx
    ON odds_snapshots (event_id, market, side, observed_at);
CREATE INDEX IF NOT EXISTS odds_league_commence_idx
    ON odds_snapshots (league, commence_time);
CREATE INDEX IF NOT EXISTS odds_observed_idx ON odds_snapshots (observed_at);
CREATE INDEX IF NOT EXISTS raw_received_idx ON raw_responses (received_at);
CREATE INDEX IF NOT EXISTS alerts_created_idx ON alerts (created_at);
CREATE INDEX IF NOT EXISTS alerts_event_idx ON alerts (event_id);
CREATE INDEX IF NOT EXISTS alerts_unnotified_idx ON alerts (notified_at);
"""

PG_VIEW = """
CREATE OR REPLACE VIEW odds_snapshots_with_raw AS
    SELECT s.*, r.body AS raw, r.url AS raw_url
    FROM odds_snapshots s JOIN raw_responses r USING(response_id);
"""


class PostgresStore:
    """One writer per database. Raw responses and issues commit before normalization."""

    def __init__(self, url: str, *, connect=None) -> None:
        if connect is None:
            import psycopg
            connect = psycopg.connect
        self.con = connect(url)
        try:
            self._migrate()
        except Exception:
            self.con.close()
            raise

    def _migrate(self) -> None:
        with self.con.cursor() as cursor:
            cursor.execute(PG_DDL)
            cursor.execute("SELECT version FROM schema_meta")
            versions = cursor.fetchall()
            if not versions:
                cursor.execute("INSERT INTO schema_meta VALUES (%s)", [SCHEMA_VERSION])
            elif versions != [(SCHEMA_VERSION,)]:
                raise ValueError(
                    "Unsupported collection schema version; use a separate database "
                    "rather than mixing versions."
                )
        ensure_analytics_schema(Database.postgres(self.con))
        with self.con.cursor() as cursor:
            cursor.execute(PG_INDEXES)
            cursor.execute(PG_VIEW)
        self.con.commit()

    def _insert(self, table: str, obj: Any) -> None:
        values = asdict(obj)
        columns = ",".join(values)
        marks = ",".join("%s" for _ in values)
        with self.con.cursor() as cursor:
            cursor.execute(f"INSERT INTO {table} ({columns}) VALUES ({marks})",
                           list(values.values()))

    def add_raw(self, response: Any) -> None:
        # Commit immediately: the bytes must survive whatever the parser does next.
        self._insert("raw_responses", response)
        self.con.commit()

    def add_issue(self, issue: Any) -> None:
        self._insert("poll_issues", issue)
        self.con.commit()

    def finish(self, rows: list, summary: dict, config: dict) -> None:
        try:
            if rows:
                columns = list(asdict(rows[0]))
                statement = (f"INSERT INTO odds_snapshots ({','.join(columns)}) "
                             f"VALUES ({','.join('%s' for _ in columns)})")
                with self.con.cursor() as cursor:
                    cursor.executemany(statement,
                                       [list(asdict(row).values()) for row in rows])
            with self.con.cursor() as cursor:
                cursor.execute(
                    "INSERT INTO poll_runs VALUES (%s,%s,%s,%s,%s,%s,%s)",
                    [summary["run_id"], summary["started_at"], summary["finished_at"],
                     summary["status"], summary["exit_code"],
                     json.dumps(config, default=str), json.dumps(summary, default=str)],
                )
            self.con.commit()
        except Exception:
            self.con.rollback()
            raise

    def close(self) -> None:
        self.con.close()


def prune_raw_responses(connection, keep_days: int = 30,
                        now: datetime | None = None) -> int:
    """Drop raw bodies older than ``keep_days``.

    Neon's free tier is 0.5 GB and a single scoreboard response is ~200 KB, so raw
    bytes are the only table that grows dangerously. Normalized snapshots, alerts and
    grades are small and are never pruned — they are what the app and the learning loop
    actually read. Raw is evidence for debugging a parse, which stops being useful once
    the games are long settled.
    """
    cutoff = (now or datetime.now(UTC)) - timedelta(days=keep_days)
    cursor = connection.cursor()
    cursor.execute("DELETE FROM raw_responses WHERE received_at < %s", [cutoff])
    deleted = cursor.rowcount or 0
    commit = getattr(connection, "commit", None)
    if callable(commit):
        commit()
    return deleted
