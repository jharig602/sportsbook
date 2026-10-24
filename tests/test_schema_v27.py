"""v27: the connector's sign-in tables exist and refuse unknown token kinds."""
import duckdb
import pytest

from schema import ensure_analytics_schema


def test_oauth_tables():
    con = duckdb.connect()
    ensure_analytics_schema(con)
    con.execute("INSERT INTO oauth_tokens VALUES ('h', 'access', 'c', NOW(), NOW(), FALSE)")
    with pytest.raises(duckdb.ConstraintException):
        con.execute("INSERT INTO oauth_tokens VALUES ('i', 'master', 'c', NOW(), NOW(), FALSE)")
    for table in ("oauth_clients", "oauth_codes", "mcp_calls"):
        assert con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0] == 0
