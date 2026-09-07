"""Results capture tests.

The refusals matter most: a postponed or in-progress game must yield no row. Inventing
a 0-0 for an unplayed game would silently grade every alert on it as a loss.
"""
from __future__ import annotations

import contextlib
import io
import json
from datetime import datetime, timezone

import pytest

import results as rs
from helpers import FakeHttp

UTC = timezone.utc
OBSERVED = datetime(2026, 9, 6, 12, 0, tzinfo=UTC)


def competition(home_score="28", away_score="24", completed=True, period=4,
                status="STATUS_FINAL", drop_side=None, home_id="194", away_id="2050"):
    competitors = [
        {"homeAway": "home", "score": home_score,
         "team": {"id": home_id, "displayName": "Ohio State Buckeyes"}},
        {"homeAway": "away", "score": away_score,
         "team": {"id": away_id, "displayName": "Ball State Cardinals"}},
    ]
    if drop_side:
        competitors = [c for c in competitors if c["homeAway"] != drop_side]
    return {
        "id": "401858432", "date": "2026-09-05T16:30Z",
        "competitors": competitors,
        "status": {"period": period,
                   "type": {"name": status, "completed": completed, "state": "post"}},
    }


def event(comp=None):
    comp = comp if comp is not None else competition()
    return {"id": "401858432", "date": "2026-09-05T16:30Z", "competitions": [comp]}


def parse(comp):
    return rs.parse_result(event(comp), comp, "ncaaf", "run1", "resp1", OBSERVED)


# --- the refusals --------------------------------------------------------------

def test_in_progress_game_yields_no_row():
    assert parse(competition(completed=False, status="STATUS_IN_PROGRESS")) is None


def test_postponed_game_yields_no_row():
    assert parse(competition(completed=False, status="STATUS_POSTPONED")) is None


def test_scheduled_game_yields_no_row():
    assert parse(competition(completed=False, status="STATUS_SCHEDULED")) is None


def test_missing_score_yields_no_row():
    """Completed but scoreless is malformed, not a 0-0 result."""
    assert parse(competition(home_score=None)) is None
    assert parse(competition(away_score="")) is None


def test_missing_competitor_yields_no_row():
    assert parse(competition(drop_side="home")) is None


def test_negative_score_is_rejected():
    assert parse(competition(home_score="-7")) is None


def test_naive_timestamp_is_rejected():
    """A start time without a zone cannot be trusted; the collector never guesses one."""
    comp = competition()
    comp["date"] = "2026-09-05T16:30:00"
    holder = {"id": "401858432", "date": "2026-09-05T16:30:00", "competitions": [comp]}
    assert rs.parse_result(holder, comp, "ncaaf", "run1", "resp1", OBSERVED) is None


# --- happy path ----------------------------------------------------------------

def test_final_game_is_captured_with_scores():
    row = parse(competition(home_score="56", away_score="3"))
    assert row is not None
    assert (row.home_score, row.away_score) == (56, 3)
    assert row.completed is True
    assert row.home_team == "Ohio State Buckeyes"
    assert row.home_team_id == "194"
    assert row.league == "ncaaf"


def test_regulation_game_is_not_flagged_as_overtime():
    row = parse(competition(period=4))
    assert row.went_overtime is False
    assert row.periods == 4


def test_overtime_is_detected_from_the_period_count():
    row = parse(competition(period=5))
    assert row.went_overtime is True


def test_double_overtime_is_still_overtime():
    assert parse(competition(period=6)).went_overtime is True


def test_missing_period_does_not_claim_overtime():
    row = parse(competition(period=None))
    assert row.periods is None
    assert row.went_overtime is False


def test_provenance_is_recorded():
    row = parse(competition())
    assert row.run_id == "run1"
    assert row.response_id == "resp1"
    assert row.observed_at == OBSERVED


# --- end to end over a fake scoreboard ------------------------------------------

def run(routes, argv):
    http = FakeHttp(routes, default={"events": []})
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = rs.main(argv, request_fn=http, sleep_fn=lambda _s: None)
    summary = {}
    for line in buffer.getvalue().splitlines():
        payload = json.loads(line)
        if payload.get("type") == "results_summary":
            summary = payload
    return code, summary, http


BASE = ["--league", "ncaaf", "--start-date", "2026-09-05", "--days", "1", "--dry-run"]


def test_mixed_slate_captures_only_finished_games():
    board = {"events": [
        event(competition(home_score="56", away_score="3")),
        {"id": "2", "date": "2026-09-05T20:00Z",
         "competitions": [dict(competition(completed=False,
                                           status="STATUS_IN_PROGRESS"), id="2")]},
    ]}
    board["events"][1]["competitions"][0]["id"] = "2"
    code, summary, _ = run({"scoreboard": board}, BASE)
    assert code == 0
    assert summary["results"] == 1
    assert summary["sources"]["espn"]["events_not_final"] == 1
    assert summary["errors"] == 0


def test_empty_slate_reports_no_data_not_success():
    code, summary, _ = run({"scoreboard": {"events": []}}, BASE)
    assert summary["results"] == 0
    assert summary["status"] == "no_data"
    assert code == 3


def test_results_use_the_safe_scoreboard_limit():
    _, _, http = run({"scoreboard": {"events": [event()]}}, BASE)
    assert any("limit=300" in url for url in http.scoreboard_calls())


def test_duplicate_events_across_dates_are_captured_once():
    board = {"events": [event(), event()]}
    _, summary, _ = run({"scoreboard": board},
                        ["--league", "ncaaf", "--start-date", "2026-09-05",
                         "--days", "2", "--dry-run"])
    assert summary["results"] == 1


def test_future_start_date_is_refused():
    with pytest.raises(SystemExit):
        rs.main(["--league", "ncaaf", "--start-date", "2099-01-01", "--dry-run"],
                request_fn=FakeHttp({}), sleep_fn=lambda _s: None)


def test_dry_run_writes_no_database(tmp_path):
    db = tmp_path / "nope.duckdb"
    run({"scoreboard": {"events": [event()]}}, BASE + ["--db", str(db)])
    assert not db.exists()


# --- persistence ---------------------------------------------------------------

def test_results_round_trip_through_duckdb(tmp_path):
    duckdb = pytest.importorskip("duckdb")
    connection = duckdb.connect(str(tmp_path / "t.duckdb"))
    row = parse(competition(home_score="35", away_score="31", period=5))
    assert rs.store_results(connection, [row]) == 1

    stored = connection.execute(
        "SELECT event_id, home_score, away_score, went_overtime FROM game_results"
    ).fetchall()
    assert stored == [("401858432", 35, 31, True)]


def test_repolling_a_game_does_not_duplicate_it(tmp_path):
    duckdb = pytest.importorskip("duckdb")
    connection = duckdb.connect(str(tmp_path / "t.duckdb"))
    row = parse(competition(home_score="21", away_score="17"))
    rs.store_results(connection, [row])

    corrected = parse(competition(home_score="28", away_score="17"))
    rs.store_results(connection, [corrected])

    stored = connection.execute("SELECT home_score FROM game_results").fetchall()
    assert stored == [(28,)], "a re-poll should correct the row, not add a second one"


# --- backfill error tolerance ---------------------------------------------------

def test_backfill_tolerates_a_transient_failure():
    """One bad date out of many must not discard the rest.

    A months-long historical pull will hit the occasional upstream 5xx. Failing the
    whole run over it threw away 912 successfully collected games in production.
    """
    import backfill

    board = {"events": [event(competition(home_score="21", away_score="17"))]}
    http = FakeHttp({"20250906": 502, "scoreboard": board})
    code, summary, _ = _run_backfill(http, ["--league", "ncaaf", "--start", "2025-09-01",
                                            "--end", "2025-09-30", "--all-days", "--dry-run"])
    assert summary["errors"] >= 1, "the failure should still be reported"
    assert summary["error_rate"] <= summary["max_error_rate"]
    assert code == 0, "a tolerable failure rate must not fail the run"


def test_backfill_fails_when_most_dates_fail():
    """Tolerance is not blindness: a mostly-broken pull must still fail."""
    http = FakeHttp({"scoreboard": 502})
    code, summary, _ = _run_backfill(http, ["--league", "ncaaf", "--start", "2025-09-01",
                                            "--end", "2025-09-30", "--all-days", "--dry-run"])
    assert code == 2
    assert summary["error_rate"] > summary["max_error_rate"]


def _run_backfill(http, argv):
    import backfill
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = backfill.main(argv, request_fn=http, sleep_fn=lambda _s: None)
    summary = {}
    for line in buffer.getvalue().splitlines():
        payload = json.loads(line)
        if payload.get("type") == "backfill_summary":
            summary = payload
    return code, summary, http
