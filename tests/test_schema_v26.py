"""v26: player props in the ledger, and parlay legs without a price of their own."""
from __future__ import annotations

import duckdb
import pytest

from schema import POSTGRES_MIGRATIONS, ensure_analytics_schema


def test_a_fresh_database_holds_a_prop_leg_without_a_leg_price():
    con = duckdb.connect()
    ensure_analytics_schema(con)
    con.execute(
        "INSERT INTO bets (bet_id, placed_at, league, event_id, market, side, line, price, stake, book, "
        "parlay_id, parlay_price, prop_player, prop_stat) VALUES "
        "('b', NOW(), 'nfl', 'e', 'prop', 'over', 274.5, NULL, 25, 'BetRivers', 'p', 195, 'Jared Goff', 'pass_yds')"
    )
    assert con.execute("SELECT prop_player, price FROM bets").fetchone() == ("Jared Goff", None)
    with pytest.raises(duckdb.ConstraintException):
        con.execute(
            "INSERT INTO bets (bet_id, placed_at, league, event_id, market, side, line, price, stake, book) "
            "VALUES ('c', NOW(), 'nfl', 'e', 'prop', 'over', 0.5, 50, 25, 'BetRivers')"  # +50 is no price
        )


def test_leg_results_take_only_known_results_and_sources():
    con = duckdb.connect()
    ensure_analytics_schema(con)
    con.execute("INSERT INTO leg_results VALUES ('r', 'owner', 'b', 'won', 'manual', NOW())")
    with pytest.raises(duckdb.ConstraintException):
        con.execute("INSERT INTO leg_results VALUES ('s', 'owner', 'b', 'maybe', 'manual', NOW())")


def test_postgres_upgrade_widens_market_and_frees_leg_prices():
    assert any("bets_market_check" in s and "'prop'" in s for s in POSTGRES_MIGRATIONS)
    assert "ALTER TABLE bets ALTER COLUMN price DROP NOT NULL" in POSTGRES_MIGRATIONS
    assert any("bets_price_check" in s and "price IS NULL" in s for s in POSTGRES_MIGRATIONS)
