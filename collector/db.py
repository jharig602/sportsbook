"""Thin database adapter so one set of SQL runs on DuckDB locally and Neon in production.

The only dialect difference this project actually hits is the parameter marker: DuckDB
takes ``?`` and psycopg takes ``%s``. Everything else in ``schema.py`` is written to the
intersection of the two.
"""
from __future__ import annotations

from typing import Any, Iterable, Sequence


class Database:
    """Wraps a DB-API connection and normalises parameter markers.

    SQL is written with ``?`` throughout. For a Postgres connection the markers are
    rewritten to ``%s``. The rewrite is a plain replace, which is safe here only
    because no SQL in this project contains a literal ``?`` inside a string — keep it
    that way, or switch to a real parser.
    """

    def __init__(self, connection: Any, paramstyle: str = "qmark") -> None:
        if paramstyle not in {"qmark", "pyformat"}:
            raise ValueError(f"unsupported paramstyle: {paramstyle!r}")
        self.connection = connection
        self.paramstyle = paramstyle

    @classmethod
    def duckdb(cls, connection: Any) -> "Database":
        return cls(connection, "qmark")

    @classmethod
    def postgres(cls, connection: Any) -> "Database":
        return cls(connection, "pyformat")

    def sql(self, statement: str) -> str:
        return statement if self.paramstyle == "qmark" else statement.replace("?", "%s")

    def execute(self, statement: str, params: Sequence | None = None) -> Any:
        text = self.sql(statement)
        if self.paramstyle == "qmark":
            return self.connection.execute(text, list(params) if params else [])
        cursor = self.connection.cursor()
        cursor.execute(text, list(params) if params else None)
        return cursor

    def executemany(self, statement: str, rows: Iterable[Sequence]) -> None:
        batch = [list(row) for row in rows]
        if not batch:
            return
        text = self.sql(statement)
        if self.paramstyle == "qmark":
            self.connection.executemany(text, batch)
            return
        with self.connection.cursor() as cursor:
            cursor.executemany(text, batch)

    def fetchall(self, statement: str, params: Sequence | None = None) -> list[tuple]:
        return self.execute(statement, params).fetchall()

    def fetchone(self, statement: str, params: Sequence | None = None) -> tuple | None:
        rows = self.execute(statement, params).fetchall()
        return rows[0] if rows else None

    def commit(self) -> None:
        commit = getattr(self.connection, "commit", None)
        if callable(commit):
            commit()

    def close(self) -> None:
        self.connection.close()


def insert_sql(table: str, columns: Sequence[str]) -> str:
    return (f"INSERT INTO {table} ({','.join(columns)}) "
            f"VALUES ({','.join('?' for _ in columns)})")
