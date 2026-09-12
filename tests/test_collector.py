"""Regression tests for the collector.

Three of these lock in bugs found against live ESPN on 2026-09-06 and fixed here:
the site-API 403, the silently truncated scoreboard, and unpriced games being
reported as pagination errors.
"""
from __future__ import annotations

import contextlib
import io
import json

import pytest

import odds_poller as op
from helpers import EMPTY_ODDS, FakeHttp, event, odds_item, odds_page, scoreboard, FIXTURE_DAY


def run(routes, argv, default=None):
    """Run the collector end to end against a fake network.

    Returns (exit_code, summary_dict, fake_http).
    """
    http = FakeHttp(routes, default=default)
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = op.main(argv, request_fn=http, sleep_fn=lambda _seconds: None)
    summary = {}
    for line in buffer.getvalue().splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        payload = json.loads(line)
        if payload.get("type") == "summary":
            summary = payload
    return code, summary, http


# Derived from the same day the fixtures kick off on, so the window always contains them.
BASE_ARGV = ["--league", "ncaaf", "--start-date", FIXTURE_DAY, "--days", "1", "--dry-run"]


# --- price parsing -------------------------------------------------------------

@pytest.mark.parametrize("value,expected", [
    ("+1100", 1100), ("-110", -110), (-110, -110), ("EVEN", 100), ("ev", 100),
    (0, None), ("0", None), (99, None), (-99, None), (1.5, None), ("", None),
    (None, None), (True, None), ("abc", None), (float("inf"), None),
])
def test_american_price(value, expected):
    assert op.american_price(value) == expected


def test_american_price_rejects_bigint_overflow():
    assert op.american_price(2 ** 63) is None


# --- the 403 fix ---------------------------------------------------------------

def test_espn_requests_carry_client_hint_headers():
    """Bare urllib headers get an empty-body 403 from site.api.espn.com.

    The honest User-Agent is fine; the fetch-metadata / client-hint group is what
    the edge actually requires, so every ESPN request must carry it.
    """
    _, _, http = run({"scoreboard": scoreboard([event()]), "/odds": odds_page([odds_item()])},
                     BASE_ARGV)
    assert http.calls, "no requests were made"
    for url, headers in http.calls:
        assert "espn.com" in url
        for required in ("sec-ch-ua", "Sec-Fetch-Mode", "Origin", "Referer", "Accept-Language"):
            assert required in headers, f"{required} missing from {url}"
        assert headers["User-Agent"].startswith("odds-poller/"), "UA should stay honest"


def test_cfbd_does_not_get_espn_headers(monkeypatch):
    monkeypatch.setenv("CFBD_KEY", "test-key")
    _, _, http = run({"collegefootballdata.com": []},
                     ["--league", "ncaaf", "--source", "cfbd", "--cfbd-year", "2026",
                      "--cfbd-week", "2", "--start-date", FIXTURE_DAY, "--days", "1",
                      "--dry-run"])
    assert http.calls
    for url, headers in http.calls:
        assert "collegefootballdata" in url
        assert "sec-ch-ua" not in headers
        assert headers["Authorization"] == "Bearer test-key"


# --- the silent-truncation fix -------------------------------------------------

def test_scoreboard_requests_safe_limit():
    """limit=1000 made ESPN return a curated 25; limit=300 returns the full slate."""
    _, _, http = run({"scoreboard": scoreboard([event()]), "/odds": odds_page([odds_item()])},
                     BASE_ARGV)
    board = http.scoreboard_calls()
    assert board, "no scoreboard request"
    assert "limit=300" in board[0]
    assert "limit=1000" not in board[0]


def test_degraded_scoreboard_size_warns():
    events = [event(event_id=str(400000000 + i)) for i in range(op.DEGRADED_SCOREBOARD_COUNT)]
    _, summary, _ = run({"scoreboard": scoreboard(events)}, BASE_ARGV, default=EMPTY_ODDS)
    assert summary["warnings"] >= 1, "degraded slate size must raise a warning"
    assert summary["errors"] == 0, "a degraded slate is a warning, not an error"


def test_normal_scoreboard_size_does_not_warn():
    events = [event(event_id=str(400000000 + i))
              for i in range(op.DEGRADED_SCOREBOARD_COUNT + 1)]
    _, summary, _ = run({"scoreboard": scoreboard(events)}, BASE_ARGV, default=EMPTY_ODDS)
    assert summary["warnings"] == 0


# --- the unpriced-game fix -----------------------------------------------------

def test_unpriced_game_is_not_an_error():
    """About 40% of an NCAAF slate is unpriced. ESPN returns pageIndex 0 for those,
    which the pagination check used to read as a rejected page and count as an error.
    """
    code, summary, _ = run({"scoreboard": scoreboard([event()]), "/odds": EMPTY_ODDS}, BASE_ARGV)
    assert summary["errors"] == 0
    assert summary["sources"]["espn"]["events_without_odds"] == 1
    assert code != 2


def test_genuine_pagination_mismatch_still_errors():
    """The guard must still catch a provider actually ignoring the requested page."""
    bad = odds_page([odds_item()], page_index=7, page_count=3, count=9)
    _, summary, _ = run({"scoreboard": scoreboard([event()]), "/odds": bad}, BASE_ARGV)
    assert summary["errors"] == 1


# --- parsing correctness -------------------------------------------------------

def test_spread_sides_are_opposites_and_priced():
    _, summary, _ = run({"scoreboard": scoreboard([event()]),
                         "/odds": odds_page([odds_item()])}, BASE_ARGV)
    assert summary["rows"] == 6          # spread x2, total x2, moneyline x2
    assert summary["sources"]["espn"]["priced_rows"] == 6


def test_mismatched_spread_pair_is_rejected():
    item = odds_item(home_line="+22.5", away_line="-14.5")
    _, summary, _ = run({"scoreboard": scoreboard([event()]),
                         "/odds": odds_page([item])}, BASE_ARGV)
    assert summary["errors"] == 1
    assert summary["rows"] == 4          # total + moneyline survive; spread is dropped


def test_open_is_never_used_as_a_current_price():
    """open differs from current in the fixture, so a leak would show up as the
    wrong price landing in a row.
    """
    item = odds_item(home_spread_price="-108", away_spread_price="-112", home_ml="+1100")
    _, summary, _ = run({"scoreboard": scoreboard([event()]),
                         "/odds": odds_page([item])}, BASE_ARGV)
    assert summary["errors"] == 0
    assert summary["rows"] == 6


def test_live_provider_is_skipped():
    item = odds_item(provider=("999", "DraftKings Live Odds"))
    _, summary, _ = run({"scoreboard": scoreboard([event()]),
                         "/odds": odds_page([item])}, BASE_ARGV)
    assert summary["rows"] == 0
    assert summary["sources"]["espn"]["live_providers_skipped"] == 1


def test_started_game_is_out_of_scope():
    started = event(state="in", completed=False, name="STATUS_IN_PROGRESS")
    _, summary, _ = run({"scoreboard": scoreboard([started]),
                         "/odds": odds_page([odds_item()])}, BASE_ARGV)
    assert summary["sources"]["espn"]["events_out_of_scope"] == 1
    assert summary["rows"] == 0


def test_postponed_game_is_out_of_scope():
    postponed = event(state="pre", name="STATUS_POSTPONED")
    _, summary, _ = run({"scoreboard": scoreboard([postponed]),
                         "/odds": odds_page([odds_item()])}, BASE_ARGV)
    assert summary["sources"]["espn"]["events_out_of_scope"] == 1


def test_http_403_is_recorded_not_raised():
    code, summary, _ = run({"scoreboard": 403}, BASE_ARGV)
    assert summary["errors"] >= 1
    assert code == 2, "a hard fetch failure must not report success"


def test_dry_run_writes_nothing(tmp_path):
    db = tmp_path / "should-not-exist.duckdb"
    run({"scoreboard": scoreboard([event()]), "/odds": odds_page([odds_item()])},
        BASE_ARGV + ["--db", str(db)])
    assert not db.exists(), "dry runs must not touch the filesystem"
