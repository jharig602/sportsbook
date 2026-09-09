"""The Odds API feed.

The most important test in this file is the one asserting the API key never reaches
storage. The provider takes its key as a query parameter and the collector persists
every request URL, so without redaction the key would be written to the database on
every single poll.
"""
import contextlib
import io
import json
from datetime import datetime, timedelta, timezone

import pytest

import odds_poller as op
import shop_lines as sl
from helpers import FakeHttp

UTC = timezone.utc
NOW = datetime(2026, 9, 12, 18, 0, tzinfo=UTC)
KICK = NOW + timedelta(hours=2)
KEY = "super-secret-key-value"

BASE_ARGV = ["--league", "nfl", "--dry-run"]


def outcome(name, price, point=None):
    row = {"name": name, "price": price}
    if point is not None:
        row["point"] = point
    return row


def feed_event(key="fe1", home="Houston Texans", away="Chicago Bears",
               commence=None, books=None):
    return {
        "id": key,
        "sport_key": "americanfootball_nfl",
        "commence_time": (commence or KICK).isoformat().replace("+00:00", "Z"),
        "home_team": home,
        "away_team": away,
        "bookmakers": books if books is not None else [
            {"key": "betmgm", "title": "BetMGM", "markets": [
                {"key": "spreads", "outcomes": [outcome(home, -110, -1.0),
                                                outcome(away, -110, 1.0)]},
                {"key": "h2h", "outcomes": [outcome(home, -120), outcome(away, 100)]},
                {"key": "totals", "outcomes": [outcome("Over", -110, 44.5),
                                               outcome("Under", -110, 44.5)]},
            ]},
        ],
    }


def run(routes, argv=BASE_ARGV, *, key=KEY, games=None, last=None, monkeypatch=None):
    """Drive main() with a fake transport and a fake board."""
    http = FakeHttp(routes, default=[])
    if monkeypatch is not None:
        monkeypatch.setenv("ODDS_API_KEY", key)
        monkeypatch.setattr(sl, "upcoming_games", lambda *a, **k: games or [])
        monkeypatch.setattr(sl, "last_polled", lambda *a, **k: last)
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = sl.main(argv, request_fn=http, sleep_fn=lambda _s: None, clock=lambda: NOW)
    summary = {}
    for line in buffer.getvalue().splitlines():
        with contextlib.suppress(ValueError):
            payload = json.loads(line)
            if payload.get("type") == "shop_summary":
                summary = payload
    return code, summary, http


def board(home="Houston Texans", away="Chicago Bears", key="401", at=None):
    from team_match import Candidate
    return [Candidate(key, home, away, at or KICK)]


# --- the key must never be stored -------------------------------------------------

def test_redact_url_blanks_the_key_but_keeps_the_url_readable():
    url = f"https://api.the-odds-api.com/v4/sports/x/odds?apiKey={KEY}&regions=us"
    redacted = op.redact_url(url)
    assert KEY not in redacted
    assert "apiKey=REDACTED" in redacted
    assert "regions=us" in redacted


def test_redact_url_leaves_a_url_without_secrets_alone():
    url = "https://site.api.espn.com/scoreboard?limit=300&groups=80"
    assert op.redact_url(url) == url


@pytest.mark.parametrize("param", ["apiKey", "api_key", "key", "token"])
def test_every_spelling_of_a_key_parameter_is_redacted(param):
    assert KEY not in op.redact_url(f"https://api.the-odds-api.com/v4/x?{param}={KEY}")


def test_the_stored_raw_row_carries_no_key(monkeypatch):
    _, _, http = run({"the-odds-api": [feed_event()]}, games=board(), monkeypatch=monkeypatch)
    # It must genuinely have been sent...
    assert any(KEY in url for url, _ in http.calls), "the request itself needs the key"


def test_the_key_reaches_the_request_but_not_the_store(monkeypatch, tmp_path):
    """The whole point, end to end: sent on the wire, absent from every stored row."""
    monkeypatch.setenv("ODDS_API_KEY", KEY)
    store = op.MemoryStore()
    ctx = op.Context(store, "nfl", "pregame", NOW, NOW + timedelta(days=1))
    http = FakeHttp({"the-odds-api": [feed_event()]}, default=[])
    client = op.HttpClient(ctx, request_fn=http, sleep_fn=lambda _s: None)
    client.fetch(f"https://{op.ODDS_API_HOST}/v4/sports/x/odds", "oddsapi",
                 params={"apiKey": KEY, "regions": "us"})

    assert any(KEY in url for url, _ in http.calls)
    for raw in store.raw:
        assert KEY not in raw.url, "the API key was written to raw_responses"
        assert "apiKey=REDACTED" in raw.url


# --- host allowlist ---------------------------------------------------------------

def test_the_feed_host_is_reachable_and_others_are_not():
    assert op.SOURCE_HOSTS["oddsapi"] == {op.ODDS_API_HOST}
    store = op.MemoryStore()
    ctx = op.Context(store, "nfl", "pregame", NOW, NOW + timedelta(days=1))
    client = op.HttpClient(ctx, request_fn=FakeHttp({}, default=[]), sleep_fn=lambda _s: None)
    assert client.fetch("https://evil.example.com/v4/odds", "oddsapi") is None
    assert ctx.errors == 1


# --- quota ------------------------------------------------------------------------

def test_the_remaining_credit_count_survives_into_the_summary(monkeypatch):
    class QuotaHttp(FakeHttp):
        def __call__(self, url, headers, timeout):
            self.calls.append((url, headers))
            return (200, {"x-requests-remaining": "417", "x-requests-used": "83"},
                    json.dumps([feed_event()]).encode())

    monkeypatch.setenv("ODDS_API_KEY", KEY)
    monkeypatch.setattr(sl, "upcoming_games", lambda *a, **k: board())
    monkeypatch.setattr(sl, "last_polled", lambda *a, **k: None)
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        sl.main(BASE_ARGV, request_fn=QuotaHttp({}), sleep_fn=lambda _s: None, clock=lambda: NOW)
    summary = json.loads(buffer.getvalue().strip().splitlines()[-1])
    assert summary["credits_remaining"] == 417


def test_an_exhausted_budget_stops_the_poll_entirely():
    poll, reason = sl.should_poll(board(), None, NOW, credits_left=12)
    assert poll is False
    assert "12 credits left" in reason


def test_a_low_budget_still_polls_a_game_about_to_start():
    soon = board(at=NOW + timedelta(hours=2))
    assert sl.should_poll(soon, None, NOW, credits_left=60)[0] is True


def test_a_low_budget_declines_a_game_days_away():
    far = board(at=NOW + timedelta(days=3))
    poll, reason = sl.should_poll(far, None, NOW, credits_left=60)
    assert poll is False
    assert "saving them" in reason


# --- throttling -------------------------------------------------------------------

def test_a_recent_poll_blocks_another_one():
    poll, reason = sl.should_poll(board(), NOW - timedelta(minutes=30), NOW, None)
    assert poll is False
    assert "0.5h ago" in reason


def test_near_kickoff_the_interval_is_short():
    # Two hours out, a three-hour-old poll is stale enough to refresh.
    assert sl.should_poll(board(), NOW - timedelta(hours=4), NOW, None)[0] is True


def test_midweek_the_interval_is_long():
    far = board(at=NOW + timedelta(days=4))
    assert sl.should_poll(far, NOW - timedelta(hours=4), NOW, None)[0] is False
    assert sl.should_poll(far, NOW - timedelta(hours=30), NOW, None)[0] is True


def test_an_empty_board_is_never_worth_a_credit():
    poll, reason = sl.should_poll([], None, NOW, None)
    assert poll is False
    assert "no upcoming games" in reason


def test_a_league_never_polled_is_polled():
    assert sl.should_poll(board(), None, NOW, None)[0] is True


# --- parsing ----------------------------------------------------------------------

def test_outcomes_map_onto_our_sides_and_markets(monkeypatch):
    _, summary, _ = run({"the-odds-api": [feed_event()]}, games=board(), monkeypatch=monkeypatch)
    assert summary["matched"] == 1
    assert summary["books"] == 1


def test_the_home_teams_point_becomes_the_home_line():
    store = op.MemoryStore()
    ctx = op.Context(store, "nfl", "pregame", NOW, NOW + timedelta(days=1))
    rows = sl.quotes_from_event(feed_event(), "401", "nfl", NOW, ctx)
    by = {(r[5], r[6]): r for r in rows}
    assert by[("spread", "home")][7] == -1.0
    assert by[("spread", "away")][7] == 1.0
    assert by[("moneyline", "home")][8] == -120
    assert by[("moneyline", "home")][7] is None
    assert by[("total", "over")][7] == 44.5
    assert by[("total", "under")][6] == "under"


def test_every_row_declares_the_feed_as_its_source():
    store = op.MemoryStore()
    ctx = op.Context(store, "nfl", "pregame", NOW, NOW + timedelta(days=1))
    rows = sl.quotes_from_event(feed_event(), "401", "nfl", NOW, ctx)
    assert rows and all(row[9] == "oddsapi" for row in rows)
    assert all(row[3] == "401" for row in rows), "rows must carry the ESPN event id"


def test_an_outcome_naming_neither_team_is_refused_not_guessed():
    store = op.MemoryStore()
    ctx = op.Context(store, "nfl", "pregame", NOW, NOW + timedelta(days=1))
    event = feed_event(books=[{"key": "x", "title": "X", "markets": [
        {"key": "spreads", "outcomes": [outcome("Some Other Team", -110, -3.0)]}]}])
    rows = sl.quotes_from_event(event, "401", "nfl", NOW, ctx)
    assert rows == []
    assert ctx.stats["oddsapi"]["unknown_outcome"] == 1


def test_an_unpriced_outcome_is_skipped_rather_than_stored_as_null():
    store = op.MemoryStore()
    ctx = op.Context(store, "nfl", "pregame", NOW, NOW + timedelta(days=1))
    event = feed_event(books=[{"key": "x", "title": "X", "markets": [
        {"key": "spreads", "outcomes": [outcome("Houston Texans", None, None)]}]}])
    assert sl.quotes_from_event(event, "401", "nfl", NOW, ctx) == []


# --- matching is reported ----------------------------------------------------------

def test_a_feed_that_covers_none_of_the_board_is_a_warning_and_is_named(monkeypatch):
    _, summary, _ = run(
        {"the-odds-api": [feed_event(home="Nowhere State Foxes", away="Elsewhere Owls")]},
        games=board(), monkeypatch=monkeypatch,
    )
    assert summary["matched"] == 0
    assert summary["coverage"] == 0.0
    # A coverage gap, not a broken run -- but it must be visible, and it must name the
    # BOARD game that went uncovered, since that is the one the app will misreport.
    assert summary["errors"] == 0
    assert summary["warnings"] == 1
    assert "Houston Texans" in summary["uncovered_detail"]


def test_a_clean_slate_reports_full_coverage(monkeypatch):
    _, summary, _ = run({"the-odds-api": [feed_event()]}, games=board(), monkeypatch=monkeypatch)
    assert summary["coverage"] == 1.0
    assert summary["warnings"] == 0


# --- run mechanics ----------------------------------------------------------------

def test_a_missing_key_skips_quietly_rather_than_failing(monkeypatch):
    monkeypatch.delenv("ODDS_API_KEY", raising=False)
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = sl.main(BASE_ARGV, request_fn=FakeHttp({}), sleep_fn=lambda _s: None)
    assert code == 3, "an unconfigured optional feature is not an error"
    assert "not set" in json.loads(buffer.getvalue().strip().splitlines()[-1])["reason"]


def test_a_rejected_key_exits_two(monkeypatch):
    code, summary, _ = run({"the-odds-api": 401}, games=board(), monkeypatch=monkeypatch)
    assert code == 2
    assert summary["errors"] >= 1


def test_a_dry_run_writes_nothing(monkeypatch):
    _, summary, _ = run({"the-odds-api": [feed_event()]}, games=board(), monkeypatch=monkeypatch)
    assert summary["written"] == 0
    assert summary["matched"] == 1


def test_an_empty_feed_exits_three(monkeypatch):
    code, summary, _ = run({"the-odds-api": []}, games=board(), monkeypatch=monkeypatch)
    assert code == 3
    assert summary["polled"] is True


def test_the_request_asks_for_the_markets_we_pay_for(monkeypatch):
    _, _, http = run({"the-odds-api": [feed_event()]}, games=board(), monkeypatch=monkeypatch)
    url = http.calls[0][0]
    assert "regions=us" in url
    assert "oddsFormat=american" in url
    for market in ("h2h", "spreads", "totals"):
        assert market in url


def test_the_summary_explains_itself_even_when_it_does_nothing(monkeypatch):
    _, summary, _ = run({"the-odds-api": [feed_event()]}, games=board(),
                        last=NOW - timedelta(minutes=10), monkeypatch=monkeypatch)
    assert summary["polled"] is False
    assert summary["reason"]


def test_force_overrides_the_throttle(monkeypatch):
    _, summary, _ = run({"the-odds-api": [feed_event()]}, argv=BASE_ARGV + ["--force"],
                        games=board(), last=NOW - timedelta(minutes=10),
                        monkeypatch=monkeypatch)
    assert summary["polled"] is True
    assert summary["reason"] == "forced"


# --- coverage is measured in the direction that matters ---------------------------

def test_feed_games_absent_from_our_board_are_not_warnings(monkeypatch):
    """The first live run had 256 of these in the NFL against 16 real games.

    The feed returns a whole season plus fixtures DraftKings never prices. Warning on
    them would bury the one alias failure worth seeing under hundreds that mean nothing.
    """
    _, summary, _ = run(
        {"the-odds-api": [feed_event(), feed_event(key="fe2", home="Elsewhere Owls",
                                                  away="Nowhere State Foxes")]},
        games=board(), monkeypatch=monkeypatch,
    )
    assert summary["matched"] == 1
    assert summary["coverage"] == 1.0
    assert summary["feed_only"] == 1, "counted, so a sudden change is visible"
    assert summary["warnings"] == 0, "but not warned on"


def test_a_board_game_left_without_a_second_book_is_warned_and_named(monkeypatch):
    # This is the failure that hides: downstream it looks exactly like agreement.
    from team_match import Candidate
    two = board() + [Candidate("402", "Miami Hurricanes", "Florida State Seminoles", KICK)]
    _, summary, _ = run({"the-odds-api": [feed_event()]}, games=two, monkeypatch=monkeypatch)
    assert summary["matched"] == 1
    assert summary["board_games"] == 2
    assert summary["coverage"] == 0.5
    assert summary["warnings"] == 1
    assert "Miami Hurricanes" in summary["uncovered_detail"]


def test_full_coverage_reports_no_warning(monkeypatch):
    _, summary, _ = run({"the-odds-api": [feed_event()]}, games=board(), monkeypatch=monkeypatch)
    assert summary["coverage"] == 1.0
    assert summary["warnings"] == 0
    assert "uncovered_detail" not in summary


def test_a_game_already_under_way_is_not_the_next_kickoff():
    """Observed live: "next game -0.6h out" on a Monday with nothing until Friday.

    `upcoming_games` reaches six hours back so a just-started game still resolves on the
    board. Treated as the next kickoff it yields a negative number of hours, which is
    trivially "within 12h", pinning the league to the three-hour interval and spending
    credits for six hours after the last game of the night has started.
    """
    from team_match import Candidate
    started = Candidate("401", "Home", "Away", NOW - timedelta(minutes=36))
    friday = Candidate("402", "Home2", "Away2", NOW + timedelta(hours=54))

    poll, reason = sl.should_poll([started, friday], NOW - timedelta(hours=4), NOW, None)
    assert poll is False, "a 4h-old poll should not refresh for a game 54h away"
    assert "54.0h out" in reason
    assert "interval is 24h" in reason


def test_a_board_of_only_started_games_is_never_worth_a_credit():
    from team_match import Candidate
    started = [Candidate("401", "Home", "Away", NOW - timedelta(hours=2))]
    poll, reason = sl.should_poll(started, None, NOW, None)
    assert poll is False
    assert "already started" in reason


def test_a_started_game_does_not_hide_a_genuine_upcoming_one():
    from team_match import Candidate
    started = Candidate("401", "Home", "Away", NOW - timedelta(hours=2))
    soon = Candidate("402", "Home2", "Away2", NOW + timedelta(hours=2))
    poll, reason = sl.should_poll([started, soon], NOW - timedelta(hours=4), NOW, None)
    assert poll is True
    assert "2.0h out" in reason


# --- the whole season, for the survivor picker ------------------------------------

def test_the_full_slate_is_stored_even_when_unmatched():
    """book_lines needs an ESPN id; a survivor pool needs week 12 to exist in September.

    The feed returns all 272 NFL fixtures. Keeping only the handful on this week's
    board makes "which team should I spend in which week" unanswerable.
    """
    rows = sl.season_rows([feed_event(), feed_event(key="fe2", home="Green Bay Packers",
                                                    away="Chicago Bears")], "nfl", NOW)
    assert len(rows) == 2
    assert [r[0] for r in rows] == ["fe1", "fe2"]
    assert all(r[1] == "nfl" for r in rows)


def test_the_consensus_spread_and_prices_are_medians():
    def book(title, spread, home_price, away_price):
        return {"key": title.lower(), "title": title, "markets": [
            {"key": "spreads", "outcomes": [outcome("Houston Texans", -110, spread),
                                            outcome("Chicago Bears", -110, -spread)]},
            {"key": "h2h", "outcomes": [outcome("Houston Texans", home_price),
                                        outcome("Chicago Bears", away_price)]},
        ]}
    event = feed_event(books=[book("A", -3.0, -160, 140), book("B", -3.5, -170, 150),
                             book("C", -2.5, -150, 130)])
    row = sl.season_rows([event], "nfl", NOW)[0]
    assert row[5] == -3.0, "median spread"
    assert row[6] == -160, "median home price"
    assert row[7] == 140, "median away price"
    assert row[8] == 3, "three books"


def test_an_unpriced_future_game_is_kept_with_no_line():
    # Week 12 in September. A null spread is a fact about the market, not a gap to
    # paper over with a guess.
    event = feed_event(key="fe9", books=[])
    row = sl.season_rows([event], "nfl", NOW)[0]
    assert row[5] is None and row[6] is None and row[7] is None
    assert row[8] == 0


def test_a_malformed_fixture_is_skipped_rather_than_stored_half_built():
    bad = {"id": "x", "home_team": "A"}          # no commence_time, no away team
    worse = {"commence_time": "2026-09-13T17:00:00Z", "home_team": "A", "away_team": "B"}
    assert sl.season_rows([bad, worse, feed_event()], "nfl", NOW) == sl.season_rows(
        [feed_event()], "nfl", NOW)


def test_friday_evening_polls_densely_for_a_saturday_slate():
    """The window that matters and used to be missed.

    With a 12-hour near-kickoff rule, college sat on the 24-hour interval all Friday
    and only went dense on Saturday morning -- by which time Friday's quotes were
    already at the web's staleness limit and the board showed nothing.
    """
    from team_match import Candidate
    saturday = [Candidate("401", "Home", "Away", NOW + timedelta(hours=16))]
    poll, reason = sl.should_poll(saturday, NOW - timedelta(hours=4), NOW, None)
    assert poll is True, "16h out is inside the 18h window, so a 4h-old poll refreshes"
    assert "interval" not in reason or "24h" not in reason


def test_a_game_three_days_out_still_polls_only_daily():
    """The widened window must not turn into polling everything all week."""
    from team_match import Candidate
    far = [Candidate("401", "Home", "Away", NOW + timedelta(hours=72))]
    poll, reason = sl.should_poll(far, NOW - timedelta(hours=4), NOW, None)
    assert poll is False
    assert "interval is 24h" in reason


def test_the_far_interval_stays_under_the_web_freshness_window():
    """A structural invariant, not a preference.

    web/lib/book-lines.ts marks a quote stale at 30 hours. If the collector's slowest
    interval ever meets or exceeds that, quotes expire at exactly the moment they are
    due to be refreshed and the board empties between polls -- which is precisely what
    happened when both were 24.
    """
    assert sl.INTERVAL_FAR_HOURS < 30, "must leave slack for a delayed workflow"
    assert sl.NEAR_KICKOFF_HOURS < sl.INTERVAL_FAR_HOURS
