"""v23: bets on a total's parity (odd/even)."""
from __future__ import annotations

import duckdb

from db import Database
from schema import POSTGRES_MIGRATIONS, ensure_analytics_schema


def test_a_fresh_database_accepts_an_odd_even_leg():
    con = duckdb.connect()
    ensure_analytics_schema(con)
    con.execute(
        "INSERT INTO bets (bet_id, placed_at, league, event_id, market, side, line, price, stake, book) "
        "VALUES ('b', NOW(), 'nfl', 'e', 'total', 'odd', NULL, -140, 20, 'DraftKings')"
    )
    assert con.execute("SELECT side FROM bets").fetchone()[0] == "odd"


class _Recorder:
    """Stands in for a Postgres connection at an older version, recording what runs."""

    paramstyle = "pyformat"

    def __init__(self):
        self.statements: list[str] = []

    def execute(self, statement, params=None):
        self.statements.append(statement)
        return self

    def fetchall(self):
        return [(22,)]


def test_an_upgraded_postgres_database_widens_the_side_check():
    db = _Recorder()
    ensure_analytics_schema(db)
    for statement in POSTGRES_MIGRATIONS:
        assert statement in db.statements


def test_duckdb_is_never_sent_the_postgres_only_statements():
    con = duckdb.connect()
    wrapped = Database.duckdb(con)
    ensure_analytics_schema(wrapped)  # must not raise
