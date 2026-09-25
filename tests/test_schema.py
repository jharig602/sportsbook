"""Schema shape.

Checks about how the tables are DEFINED rather than how they behave, for the decisions
that are invisible at runtime and expensive to reverse once a season of rows depends
on them.
"""
from __future__ import annotations

from schema import ANALYTICS_DDL, ANALYTICS_MIGRATIONS


def test_a_team_total_is_a_total_with_a_team_on_it():
    """The CHECK on market stays as it was, on purpose.

    Neither engine here alters a CHECK constraint portably, but that is not why the
    encoding is this way. A team total IS a total: a line on points scored, asked of one
    side rather than both, graded off the same score. Only which numbers get added
    changes.
    """
    assert "CHECK (team IS NULL OR team IN ('home', 'away'))" in ANALYTICS_DDL
    assert "CHECK (market IN ('spread', 'total', 'moneyline'))" in ANALYTICS_DDL
    assert any("ADD COLUMN IF NOT EXISTS team" in m for m in ANALYTICS_MIGRATIONS)


def test_unlock_attempts_never_store_an_address():
    """Failed passcode attempts are counted by a hash of the source, never the address."""
    start = ANALYTICS_DDL.index("CREATE TABLE IF NOT EXISTS unlock_attempts")
    table = ANALYTICS_DDL[start:ANALYTICS_DDL.index(");", start)]
    assert "source_hash" in table
    assert "ip " not in table.lower() and "address" not in table.split("--")[0].lower()
