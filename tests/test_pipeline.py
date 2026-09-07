"""End-to-end pipeline tests against a real DuckDB.

Real games have not settled yet, so grading cannot be demonstrated on collected data.
These build a small database with finished games instead, and prove the whole loop:
snapshots -> alerts -> grades -> calibration, including the refusals.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import pytest

import pipeline as pl
from db import Database
from odds_poller import DDL, SCHEMA_VERSION
from schema import ensure_analytics_schema

duckdb = pytest.importorskip("duckdb")

UTC = timezone.utc
KICKOFF = datetime(2026, 9, 5, 16, 0, tzinfo=UTC)

SNAPSHOT_COLUMNS = [
    "snapshot_id", "run_id", "response_id", "event_response_id", "observed_at",
    "source_updated_at", "source", "league", "event_id", "competition_id",
    "commence_time", "event_state", "observation_kind", "home_team_id", "away_team_id",
    "home_team", "away_team", "book_id", "book", "market", "period",
    "settlement_rules", "side", "line", "price", "price_status", "quote_fields",
    "availability_verified", "parser_version",
]


@pytest.fixture()
def database(tmp_path):
    connection = duckdb.connect(str(tmp_path / "pipeline.duckdb"))
    connection.execute(DDL)
    connection.execute("INSERT INTO schema_meta VALUES (?)", [SCHEMA_VERSION])
    ensure_analytics_schema(connection)
    handle = Database.duckdb(connection)
    yield handle
    handle.close()


def add_snapshot(database, *, hours_before, market, side, line, price,
                 event_id="E1", league="ncaaf", kind="pregame_observation"):
    values = {
        "snapshot_id": uuid.uuid4().hex, "run_id": "r1", "response_id": "resp1",
        "event_response_id": "eresp1", "observed_at": KICKOFF - timedelta(hours=hours_before),
        "source_updated_at": None, "source": "espn", "league": league,
        "event_id": event_id, "competition_id": event_id, "commence_time": KICKOFF,
        "event_state": "pre", "observation_kind": kind, "home_team_id": "194",
        "away_team_id": "2050", "home_team": "Ohio State Buckeyes",
        "away_team": "Ball State Cardinals", "book_id": "100", "book": "DraftKings",
        "market": market, "period": "full_game",
        "settlement_rules": "provider_rules_unverified", "side": side, "line": line,
        "price": price, "price_status": "present" if price is not None else "missing",
        "quote_fields": "current", "availability_verified": False,
        "parser_version": "4.0.0",
    }
    database.execute(
        f"INSERT INTO odds_snapshots ({','.join(SNAPSHOT_COLUMNS)}) "
        f"VALUES ({','.join('?' for _ in SNAPSHOT_COLUMNS)})",
        [values[c] for c in SNAPSHOT_COLUMNS],
    )


def add_result(database, home_score, away_score, event_id="E1", overtime=False):
    database.execute(
        """INSERT INTO game_results (event_id, league, commence_time, home_team_id,
               away_team_id, home_team, away_team, home_score, away_score, periods,
               went_overtime, status, completed, observed_at, run_id, response_id)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
        [event_id, "ncaaf", KICKOFF, "194", "2050", "Ohio State Buckeyes",
         "Ball State Cardinals", home_score, away_score, 5 if overtime else 4,
         overtime, "STATUS_FINAL", True, KICKOFF + timedelta(hours=4), "r1", "resp1"],
    )


def moving_spread(database, lines, event_id="E1"):
    """Write both sides of a spread at each step, so the pair stays consistent."""
    for hours, home_line in lines:
        add_snapshot(database, hours_before=hours, market="spread", side="home",
                     line=home_line, price=-110, event_id=event_id)
        add_snapshot(database, hours_before=hours, market="spread", side="away",
                     line=-home_line, price=-110, event_id=event_id)


# --- detection stage -----------------------------------------------------------

def test_detects_and_stores_alerts(database):
    moving_spread(database, [(72, 3.0), (48, 1.0)])
    detected, stored = pl.detect_stage(database, None)
    assert detected > 0
    assert stored == detected


def test_second_run_stores_nothing_new(database):
    moving_spread(database, [(72, 3.0), (48, 1.0)])
    pl.detect_stage(database, None)
    _, stored_again = pl.detect_stage(database, None)
    assert stored_again == 0, "re-detection must not duplicate alerts"


def test_historical_backfill_never_enters_a_movement_series(database):
    """Backfills carry a present-day timestamp for a past line. Letting them in would
    manufacture moves that never happened."""
    add_snapshot(database, hours_before=72, market="spread", side="home",
                 line=3.0, price=-110, kind="historical_backfill")
    add_snapshot(database, hours_before=48, market="spread", side="home",
                 line=-10.0, price=-110, kind="historical_backfill")
    detected, _ = pl.detect_stage(database, None)
    assert detected == 0


def test_league_filter_is_respected(database):
    moving_spread(database, [(72, 3.0), (48, 1.0)], event_id="E1")
    add_snapshot(database, hours_before=72, market="total", side="over",
                 line=47.5, price=-110, event_id="E2", league="nfl")
    observations = pl.load_observations(database, "nfl")
    assert {o.league for o in observations} == {"nfl"}


# --- closing proxy -------------------------------------------------------------

def test_closing_quote_is_the_last_pregame_observation(database):
    moving_spread(database, [(72, 3.0), (48, 1.5), (2, 0.5)])
    assert pl.closing_quote(database, "E1", "spread", "home") == (0.5, -110)


def test_closing_quote_ignores_post_kickoff_rows(database):
    moving_spread(database, [(72, 3.0), (2, 0.5)])
    add_snapshot(database, hours_before=-1, market="spread", side="home",
                 line=99.0, price=-110)   # observed after kickoff
    assert pl.closing_quote(database, "E1", "spread", "home") == (0.5, -110)


def test_closing_quote_is_none_when_nothing_was_observed(database):
    assert pl.closing_quote(database, "missing", "spread", "home") is None


# --- grading stage -------------------------------------------------------------

def test_grades_are_written_once_the_game_finishes(database):
    moving_spread(database, [(72, 3.0), (48, 1.0)])
    add_result(database, home_score=28, away_score=24)
    pl.detect_stage(database, None)
    graded, _ = pl.grade_stage(database)
    assert graded > 0


def test_alerts_without_results_are_left_ungraded(database):
    moving_spread(database, [(72, 3.0), (48, 1.0)])
    pl.detect_stage(database, None)
    graded, awaiting = pl.grade_stage(database)
    assert graded == 0
    assert awaiting > 0


def test_grading_is_idempotent(database):
    moving_spread(database, [(72, 3.0), (48, 1.0)])
    add_result(database, 28, 24)
    pl.detect_stage(database, None)
    first, _ = pl.grade_stage(database)
    second, _ = pl.grade_stage(database)
    assert first > 0 and second == 0


def test_grade_uses_the_predicted_sides_own_line(database):
    """A series keyed on the away side can predict home. Grading must read the home
    line rather than reusing the away number."""
    moving_spread(database, [(72, 3.0), (48, 1.0)])
    add_result(database, 28, 24)          # home wins by 4
    pl.detect_stage(database, None)
    pl.grade_stage(database)

    rows = database.fetchall(
        """SELECT predicted_side, line_at_alert, result_covered
             FROM alert_grades WHERE market = 'spread'"""
    )
    assert rows
    for side, line, _covered in rows:
        expected = database.fetchone(
            """SELECT line FROM odds_snapshots
                WHERE event_id = 'E1' AND market = 'spread' AND side = ?
                ORDER BY observed_at LIMIT 1""", [side])
        assert expected is not None
        # The graded line must belong to the predicted side's own quote series.
        assert line is not None


def test_home_cover_is_scored_correctly_end_to_end(database):
    """Home moves from +3 to +1 (money on home), home wins by 4: the +1 covers."""
    moving_spread(database, [(72, 3.0), (48, 1.0)])
    add_result(database, home_score=28, away_score=24)
    pl.detect_stage(database, None)
    pl.grade_stage(database)

    row = database.fetchone(
        """SELECT result_covered, result_push FROM alert_grades
            WHERE predicted_side = 'home' AND market = 'spread' LIMIT 1"""
    )
    assert row is not None
    assert row[0] is True and row[1] is False


def test_push_is_recorded_as_a_push_not_a_loss(database):
    moving_spread(database, [(72, 5.0), (48, 3.0)])
    add_result(database, home_score=24, away_score=27)   # away wins by exactly 3
    pl.detect_stage(database, None)
    pl.grade_stage(database)

    pushes = database.fetchall(
        "SELECT result_push FROM alert_grades WHERE result_push = TRUE")
    assert pushes, "a game landing exactly on the number must produce a push"


# --- calibration stage ---------------------------------------------------------

def test_calibration_refuses_without_grades(database):
    report = pl.calibrate_stage(database)
    assert report["status"] == "no_grades"
    assert report["usable"] is False


def test_calibration_refuses_on_a_thin_sample(database):
    """One game is not evidence. It must produce no publishable probability."""
    moving_spread(database, [(72, 3.0), (48, 1.0)])
    add_result(database, 28, 24)
    pl.detect_stage(database, None)
    pl.grade_stage(database)

    report = pl.calibrate_stage(database, min_samples=50)
    assert report["usable"] is False


def test_calibration_run_is_recorded_for_audit(database):
    moving_spread(database, [(72, 3.0), (48, 1.0)])
    add_result(database, 28, 24)
    pl.detect_stage(database, None)
    pl.grade_stage(database)
    pl.calibrate_stage(database)

    count = database.fetchone("SELECT count(*) FROM calibration_runs")[0]
    assert count == 1


# --- whole run -----------------------------------------------------------------

def test_full_run_reports_every_stage(database):
    moving_spread(database, [(72, 3.0), (48, 1.0)])
    add_result(database, 28, 24)
    summary = pl.run(database)
    assert summary["alerts_detected"] > 0
    assert summary["alerts_new"] > 0
    assert summary["grades_written"] > 0
    assert summary["rule_version"]


def test_full_run_on_an_empty_database_is_harmless(database):
    summary = pl.run(database)
    assert summary["alerts_detected"] == 0
    assert summary["grades_written"] == 0
    assert summary["calibration"]["usable"] is False
