"""PostgresStore tests against a recording fake connection.

There is no Postgres available here, so these verify the things that would otherwise
only fail in production: dialect correctness, the raw-first commit ordering, and that
a failed batch rolls back instead of half-writing a run.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

import pytest

import pg_store
from pg_store import PG_DDL, PostgresStore, prune_raw_responses

UTC = timezone.utc


@dataclass
class Row:
    response_id: str = "r1"
    run_id: str = "run1"
    body: bytes = b"{}"


class FakeCursor:
    def __init__(self, log, versions, fail_on=None):
        self.log = log
        # schema_meta and analytics_meta are separate version namespaces, so the fake
        # has to answer per table rather than returning one row set to every SELECT.
        self._versions = versions
        self._fail_on = fail_on
        self._last = ""
        self.rowcount = 3

    def execute(self, statement, params=None):
        if self._fail_on and self._fail_on in statement:
            raise RuntimeError("insert exploded")
        self._last = statement
        self.log.append(("execute", statement, params))

    def executemany(self, statement, rows):
        if self._fail_on and self._fail_on in statement:
            raise RuntimeError("batch exploded")
        self.log.append(("executemany", statement, list(rows)))

    def fetchall(self):
        for table, version in self._versions.items():
            if table in self._last:
                return [(version,)] if version is not None else []
        return []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConnection:
    """Records every statement, commit and rollback in order."""

    def __init__(self, existing_version=None, analytics_version=None, fail_on=None):
        self.log: list = []
        self.closed = False
        self._versions = {"schema_meta": existing_version,
                          "analytics_meta": analytics_version}
        self._fail_on = fail_on

    def cursor(self):
        return FakeCursor(self.log, self._versions, self._fail_on)

    def commit(self):
        self.log.append(("commit",))

    def rollback(self):
        self.log.append(("rollback",))

    def close(self):
        self.closed = True

    def statements(self):
        return [entry[1] for entry in self.log if entry[0] in {"execute", "executemany"}]

    def events(self):
        return [entry[0] for entry in self.log]


def store(**kwargs):
    connection = FakeConnection(**kwargs)
    return PostgresStore("postgresql://fake", connect=lambda _url: connection), connection


# --- dialect correctness -------------------------------------------------------

def test_ddl_uses_postgres_types_not_duckdb_ones():
    assert "BYTEA" in PG_DDL
    assert "BLOB" not in PG_DDL, "BLOB is DuckDB syntax and would fail on Postgres"
    assert "DOUBLE PRECISION" in PG_DDL


def test_ddl_avoids_unsupported_create_view_if_not_exists():
    """Postgres has no CREATE VIEW IF NOT EXISTS; it needs CREATE OR REPLACE."""
    assert "CREATE VIEW IF NOT EXISTS" not in pg_store.PG_VIEW
    assert "CREATE OR REPLACE VIEW" in pg_store.PG_VIEW


def test_all_constraints_survive_the_translation():
    """The price and observation-kind guards are the reason bad rows cannot land."""
    assert "price <= -100 OR price >= 100" in PG_DDL
    assert "pregame_observation" in PG_DDL and "historical_backfill" in PG_DDL


def test_inserts_use_postgres_placeholders():
    handle, connection = store()
    handle.add_raw(Row())
    inserts = [s for s in connection.statements() if s.startswith("INSERT INTO raw_responses")]
    assert inserts
    assert "%s" in inserts[0]
    assert "?" not in inserts[0], "qmark placeholders would be a syntax error on Postgres"


def test_indexes_cover_the_queries_the_app_runs():
    for column_set in ("(event_id, market, side, observed_at)",
                       "(league, commence_time)"):
        assert column_set in pg_store.PG_INDEXES


# --- schema versioning ---------------------------------------------------------

def test_fresh_database_records_the_schema_version():
    _, connection = store()
    assert any("INSERT INTO schema_meta" in s for s in connection.statements())


def test_matching_version_is_accepted():
    handle, _ = store(existing_version=pg_store.SCHEMA_VERSION)
    assert handle is not None


def test_mismatched_version_is_refused_and_closes_the_connection():
    connection = FakeConnection(existing_version=99)
    with pytest.raises(ValueError, match="schema version"):
        PostgresStore("postgresql://fake", connect=lambda _url: connection)
    assert connection.closed, "a refused connection must not be left open"


# --- raw-first discipline ------------------------------------------------------

def test_raw_response_commits_immediately():
    """The bytes must survive whatever the parser does next, so the commit cannot wait
    until the end of the run."""
    handle, connection = store()
    connection.log.clear()
    handle.add_raw(Row())
    assert connection.events() == ["execute", "commit"]


def test_issues_commit_immediately_too():
    handle, connection = store()
    connection.log.clear()
    handle.add_issue(Row())
    assert connection.events()[-1] == "commit"


# --- transactional finish ------------------------------------------------------

def test_finish_writes_rows_then_the_run_record():
    handle, connection = store()
    connection.log.clear()
    summary = {"run_id": "run1", "started_at": datetime.now(UTC),
               "finished_at": datetime.now(UTC), "status": "ok", "exit_code": 0}
    handle.finish([Row()], summary, {"league": "ncaaf"})

    statements = connection.statements()
    assert any("INSERT INTO odds_snapshots" in s for s in statements)
    assert any("INSERT INTO poll_runs" in s for s in statements)
    assert connection.events()[-1] == "commit"


def test_finish_rolls_back_when_the_batch_fails():
    """A half-written run must not be left behind reporting success."""
    handle, connection = store()
    connection._fail_on = "INSERT INTO odds_snapshots"
    connection.log.clear()
    summary = {"run_id": "run1", "started_at": datetime.now(UTC),
               "finished_at": datetime.now(UTC), "status": "ok", "exit_code": 0}

    with pytest.raises(RuntimeError):
        handle.finish([Row()], summary, {})
    assert "rollback" in connection.events()
    assert "commit" not in connection.events()


def test_finish_with_no_rows_still_records_the_run():
    handle, connection = store()
    connection.log.clear()
    summary = {"run_id": "run1", "started_at": datetime.now(UTC),
               "finished_at": datetime.now(UTC), "status": "no_data", "exit_code": 3}
    handle.finish([], summary, {})
    assert any("INSERT INTO poll_runs" in s for s in connection.statements())


def test_finish_serialises_datetimes_in_the_json_blobs():
    """json.dumps would raise on a datetime without default=str, losing the whole run."""
    handle, connection = store()
    summary = {"run_id": "run1", "started_at": datetime.now(UTC),
               "finished_at": datetime.now(UTC), "status": "ok", "exit_code": 0}
    handle.finish([], summary, {"start_date": datetime.now(UTC)})  # must not raise


# --- retention -----------------------------------------------------------------

def test_prune_deletes_only_old_raw_bodies():
    connection = FakeConnection()
    now = datetime(2026, 9, 6, tzinfo=UTC)
    prune_raw_responses(connection, keep_days=30, now=now)

    statement, params = next((s, p) for kind, s, p in connection.log
                             if kind == "execute" and "DELETE" in s)
    assert "raw_responses" in statement
    assert params[0] == now - timedelta(days=30)


def test_prune_never_touches_snapshots_or_grades():
    """Snapshots and grades are what the app and the learning loop read; only the raw
    bodies behind them are disposable."""
    connection = FakeConnection()
    prune_raw_responses(connection, keep_days=30)
    for statement in connection.statements():
        if "DELETE" in statement:
            assert "odds_snapshots" not in statement
            assert "alert_grades" not in statement
            assert "alerts" not in statement


def test_prune_commits():
    connection = FakeConnection()
    prune_raw_responses(connection)
    assert "commit" in connection.events()
