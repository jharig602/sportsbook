"""Kalshi game prices: parsing, matching, pricing, flags, and the pregame-only rule.

Ticker examples are real, copied from Kalshi's public feed on 2026-10-18.
"""
import json
from datetime import date, datetime, timedelta, timezone

import duckdb
import pytest

import kalshi as k
from db import Database
from schema import ensure_analytics_schema

UTC = timezone.utc
ALIASES = k.load_aliases()
CONFIG = k.load_config()


def market(ticker, name, bid, ask, bid_size="5000.00", ask_size="5000.00"):
    return {
        "ticker": ticker, "yes_sub_title": name,
        "yes_bid_dollars": f"{bid:.4f}", "yes_ask_dollars": f"{ask:.4f}",
        "no_bid_dollars": f"{1 - ask:.4f}", "no_ask_dollars": f"{1 - bid:.4f}",
        "yes_bid_size_fp": bid_size, "yes_ask_size_fp": ask_size,
        "last_price_dollars": f"{ask:.4f}", "volume_fp": "100000.00",
    }


def event(ticker, title, *markets):
    return {"event_ticker": ticker, "title": title, "markets": list(markets)}


ARI_LAR = event(
    "KXNFLGAME-26OCT18ARILAR", "ARI Cardinals vs LA Rams",
    market("KXNFLGAME-26OCT18ARILAR-LAR", "Los Angeles R", 0.85, 0.86),
    market("KXNFLGAME-26OCT18ARILAR-ARI", "Arizona", 0.14, 0.15),
)
RAMS = k.Game("401", "nfl", "Los Angeles Rams", "Arizona Cardinals",
              datetime(2026, 10, 18, 20, 5, tzinfo=UTC))


# --- parsing ---------------------------------------------------------------------------

def test_parses_a_real_nfl_ticker():
    e = k.parse_event(ARI_LAR, "nfl")
    assert e.game_date == date(2026, 10, 18)
    assert {m.code for m in e.markets} == {"LAR", "ARI"}
    lar = next(m for m in e.markets if m.code == "LAR")
    assert (lar.yes_bid, lar.yes_ask, lar.bid_size) == (0.85, 0.86, 5000.0)


def test_rejects_anything_that_is_not_a_two_team_game():
    three = dict(ARI_LAR, markets=ARI_LAR["markets"] + [market("KXNFLGAME-26OCT18ARILAR-TIE", "Tie", 0.01, 0.02)])
    assert k.parse_event(three, "nfl") is None
    assert k.parse_event(event("KXNFLGAME-BADTICKER", "x"), "nfl") is None


# --- matching --------------------------------------------------------------------------

def test_nfl_matches_by_alias_codes_and_assigns_sides():
    result = k.match_event(k.parse_event(ARI_LAR, "nfl"), [RAMS], ALIASES, {})
    assert isinstance(result, k.Matched)
    assert result.game.event_id == "401" and result.how == "alias"
    assert result.sides == {"LAR": "home", "ARI": "away"}


def test_monday_night_matches_on_the_eastern_date():
    # Kickoff 00:15 UTC on the 20th is Monday the 19th in New York, which is the ticker date.
    mnf = event("KXNFLGAME-26OCT19WASSF", "WAS Commanders vs SF 49ers",
                market("KXNFLGAME-26OCT19WASSF-SF", "San Francisco", 0.77, 0.78),
                market("KXNFLGAME-26OCT19WASSF-WAS", "Washington", 0.22, 0.23))
    game = k.Game("402", "nfl", "San Francisco 49ers", "Washington Commanders",
                  datetime(2026, 10, 20, 0, 15, tzinfo=UTC))
    result = k.match_event(k.parse_event(mnf, "nfl"), [game], ALIASES, {})
    assert isinstance(result, k.Matched)
    assert result.sides == {"SF": "home", "WAS": "away"}


def test_jaguars_are_jac_on_kalshi():
    jax = event("KXNFLGAME-26OCT18HOUJAC", "HOU Texans vs JAC Jaguars",
                market("KXNFLGAME-26OCT18HOUJAC-JAC", "Jacksonville", 0.55, 0.56),
                market("KXNFLGAME-26OCT18HOUJAC-HOU", "Houston", 0.44, 0.45))
    game = k.Game("403", "nfl", "Jacksonville Jaguars", "Houston Texans",
                  datetime(2026, 10, 18, 13, 30, tzinfo=UTC))
    assert isinstance(k.match_event(k.parse_event(jax, "nfl"), [game], ALIASES, {}), k.Matched)


def test_unknown_nfl_code_is_refused_not_guessed():
    odd = event("KXNFLGAME-26OCT18ARIXYZ", "x",
                market("KXNFLGAME-26OCT18ARIXYZ-XYZ", "Los Angeles R", 0.5, 0.51),
                market("KXNFLGAME-26OCT18ARIXYZ-ARI", "Arizona", 0.49, 0.5))
    result = k.match_event(k.parse_event(odd, "nfl"), [RAMS], ALIASES, {})
    assert isinstance(result, k.Unmatched) and "XYZ" in result.reason


def test_wrong_date_is_refused():
    shifted = k.Game("401", "nfl", "Los Angeles Rams", "Arizona Cardinals",
                     datetime(2026, 10, 25, 20, 5, tzinfo=UTC))
    result = k.match_event(k.parse_event(ARI_LAR, "nfl"), [shifted], ALIASES, {})
    assert isinstance(result, k.Unmatched)


COLLEGE = event("KXNCAAFGAME-26OCT20MOSUDEL", "Missouri St. vs Delaware",
                market("KXNCAAFGAME-26OCT20MOSUDEL-DEL", "Delaware", 0.57, 0.58),
                market("KXNCAAFGAME-26OCT20MOSUDEL-MOSU", "Missouri St.", 0.42, 0.43))


def test_college_matches_by_both_names_on_the_eastern_date():
    game = k.Game("501", "ncaaf", "Delaware Blue Hens", "Missouri State Bears",
                  datetime(2026, 10, 21, 0, 0, tzinfo=UTC))
    result = k.match_event(k.parse_event(COLLEGE, "ncaaf"), [game], ALIASES, {})
    assert isinstance(result, k.Matched) and result.how == "name"
    assert result.sides == {"DEL": "home", "MOSU": "away"}


def test_college_refuses_when_one_team_does_not_match():
    game = k.Game("501", "ncaaf", "Delaware Blue Hens", "Liberty Flames",
                  datetime(2026, 10, 21, 0, 0, tzinfo=UTC))
    assert isinstance(k.match_event(k.parse_event(COLLEGE, "ncaaf"), [game], ALIASES, {}), k.Unmatched)


def test_college_refuses_an_ambiguous_pair():
    miami = event("KXNCAAFGAME-26OCT24MIATOL", "Miami vs Toledo",
                  market("KXNCAAFGAME-26OCT24MIATOL-TOL", "Toledo", 0.5, 0.51),
                  market("KXNCAAFGAME-26OCT24MIATOL-MIA", "Miami", 0.49, 0.5))
    kick = datetime(2026, 10, 24, 18, 0, tzinfo=UTC)
    games = [k.Game("601", "ncaaf", "Toledo Rockets", "Miami Hurricanes", kick),
             k.Game("602", "ncaaf", "Toledo Rockets", "Miami (OH) RedHawks", kick)]
    result = k.match_event(k.parse_event(miami, "ncaaf"), games, ALIASES, {})
    assert isinstance(result, k.Unmatched) and "ambiguous" in result.reason


def test_a_manual_link_wins_and_still_orients_by_name():
    game = k.Game("501", "ncaaf", "Delaware Blue Hens", "Missouri State Bears",
                  datetime(2026, 10, 25, 0, 0, tzinfo=UTC))  # different date: only the link can join them
    result = k.match_event(k.parse_event(COLLEGE, "ncaaf"), [game], ALIASES,
                           {"KXNCAAFGAME-26OCT20MOSUDEL": "501"})
    assert isinstance(result, k.Matched) and result.how == "manual"
    assert result.sides["DEL"] == "home"


# --- pricing ---------------------------------------------------------------------------

def test_fee_adjusted_ask_matches_the_plan_example():
    cost = k.effective_ask(0.56, CONFIG["fee"]["takerCoefficient"])
    assert cost == pytest.approx(0.56 + 0.07 * 0.56 * 0.44)
    american = round(-100 * cost / (1 - cost))
    assert american == -137


def test_thin_markets_are_marked():
    e = k.parse_event(ARI_LAR, "nfl")
    assert not k.is_thin(e.markets[0], CONFIG["thin"])
    wide = k.parse_event(event("KXNFLGAME-26OCT18ARILAR", "x",
                               market("KXNFLGAME-26OCT18ARILAR-LAR", "a", 0.80, 0.84),
                               market("KXNFLGAME-26OCT18ARILAR-ARI", "b", 0.16, 0.20)), "nfl")
    shallow = k.parse_event(event("KXNFLGAME-26OCT18ARILAR", "x",
                                  market("KXNFLGAME-26OCT18ARILAR-LAR", "a", 0.85, 0.86, "50.00"),
                                  market("KXNFLGAME-26OCT18ARILAR-ARI", "b", 0.14, 0.15)), "nfl")
    assert k.is_thin(wide.markets[0], CONFIG["thin"])
    assert k.is_thin(shallow.markets[0], CONFIG["thin"])


def test_fair_price_averages_the_mirrored_midpoints():
    e = k.parse_event(ARI_LAR, "nfl")
    lar, ari = e.markets
    assert k.kalshi_fair(lar, ari) == pytest.approx((0.855 + (1 - 0.145)) / 2)


# --- flags -----------------------------------------------------------------------------

T = CONFIG["flags"]


def test_stale_book_fires_when_a_book_is_well_below_kalshi():
    quotes = [k.BookQuote("DraftKings", "home", -150, 130), k.BookQuote("DraftKings", "away", 130, -150)]
    flags = k.compute_flags(0.705, {"home": None, "away": None}, quotes, T)
    stale = [f for f in flags if f.kind == "stale_book"]
    assert len(stale) == 1 and stale[0].side == "home"
    assert stale[0].edge_points == pytest.approx((0.705 - k.no_vig(-150, 130)) * 100)


def test_no_flags_when_book_and_kalshi_agree():
    quotes = [k.BookQuote("DraftKings", "home", -240, 200), k.BookQuote("DraftKings", "away", 200, -240)]
    fair = k.no_vig(-240, 200)
    cost = {"home": fair + 0.03, "away": 1 - fair + 0.03}
    assert k.compute_flags(fair, cost, quotes, T) == []


def test_arb_fires_when_book_plus_kalshi_cost_under_100():
    quotes = [k.BookQuote("FanDuel", "away", 130, -150)]  # away at +130 costs 43.5%
    cost = {"home": k.effective_ask(0.50, 0.07), "away": None}  # home on Kalshi ~51.75%
    arbs = [f for f in k.compute_flags(0.5, cost, quotes, T) if f.kind == "arb"]
    assert len(arbs) == 1 and arbs[0].book == "FanDuel"
    assert arbs[0].edge_points == pytest.approx((1 - 100 / 230 - cost["home"]) * 100)


def test_kalshi_value_needs_two_books_and_a_cheap_ask():
    books = [k.BookQuote("A", "home", -150, 130), k.BookQuote("A", "away", 130, -150),
             k.BookQuote("B", "home", -155, 135), k.BookQuote("B", "away", 135, -155)]
    cheap = {"home": 0.55, "away": None}
    value = [f for f in k.compute_flags(0.58, cheap, books, T) if f.kind == "kalshi_value"]
    assert len(value) == 1 and value[0].books == 2
    one_book = [f for f in k.compute_flags(0.58, cheap, books[:2], T) if f.kind == "kalshi_value"]
    assert one_book == []


def test_flag_id_is_one_row_per_offer():
    f = k.Flag("stale_book", "home", "DraftKings", -150, 0.58, 0.705, None, None, 12.5, 1)
    assert k.flag_id("401", f) == k.flag_id("401", f)
    moved = k.Flag("stale_book", "home", "DraftKings", -145, 0.58, 0.705, None, None, 12.5, 1)
    assert k.flag_id("401", f) != k.flag_id("401", moved)


# --- the whole run ---------------------------------------------------------------------

NOW = datetime(2026, 10, 18, 15, 0, tzinfo=UTC)


def _warehouse(tmp_path, rams_kickoff):
    path = tmp_path / "w.duckdb"
    con = duckdb.connect(str(path))
    con.execute("""CREATE TABLE odds_snapshots (event_id VARCHAR, league VARCHAR, home_team VARCHAR,
                   away_team VARCHAR, commence_time TIMESTAMPTZ, market VARCHAR, side VARCHAR,
                   line DOUBLE, price BIGINT, observation_kind VARCHAR, observed_at TIMESTAMPTZ)""")
    for side, price in (("home", -150), ("away", 130)):
        con.execute("INSERT INTO odds_snapshots VALUES (?,?,?,?,?,?,?,?,?,?,?)",
                    ["401", "nfl", "Los Angeles Rams", "Arizona Cardinals", rams_kickoff,
                     "moneyline", side, None, price, "pregame_observation", NOW - timedelta(hours=1)])
    ensure_analytics_schema(Database.duckdb(con))
    con.close()
    return path


def _feed(payloads):
    def request(url, headers, timeout):
        series = "KXNFLGAME" if "KXNFLGAME" in url else "KXNCAAFGAME"
        return 200, {}, json.dumps({"events": payloads.get(series, []), "cursor": ""}).encode()
    return request


def _run(path, payloads, capsys, at=NOW):
    k.main(["--db", str(path)], request_fn=_feed(payloads), sleep_fn=lambda s: None, clock=lambda: at)
    return json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_run_writes_pregame_quotes_and_flags_once(tmp_path, capsys):
    path = _warehouse(tmp_path, NOW + timedelta(hours=5))
    summary = _run(path, {"KXNFLGAME": [ARI_LAR]}, capsys)
    assert summary["matched"] == 1 and summary["quotes"] == 2
    assert summary["flags"] >= 1  # DK has the Rams ~58% no-vig against Kalshi ~85%
    _run(path, {"KXNFLGAME": [ARI_LAR]}, capsys)  # the same poll re-run: nothing new
    _run(path, {"KXNFLGAME": [ARI_LAR]}, capsys, at=NOW + timedelta(minutes=10))  # a later poll
    con = duckdb.connect(str(path))
    assert con.execute("SELECT COUNT(*) FROM exchange_quotes").fetchone()[0] == 4  # every poll kept, once
    kinds = con.execute("SELECT kind, COUNT(*) FROM exchange_flags GROUP BY kind").fetchall()
    assert dict(kinds)["stale_book"] == 1  # the same offer seen twice is one row


def test_run_writes_nothing_after_kickoff(tmp_path, capsys):
    path = _warehouse(tmp_path, NOW - timedelta(minutes=30))
    summary = _run(path, {"KXNFLGAME": [ARI_LAR]}, capsys)
    assert summary["after_kickoff"] == 1 and summary["quotes"] == 0 and summary["flags"] == 0


def test_run_lists_unmatched_events_on_board_dates_only(tmp_path, capsys):
    path = _warehouse(tmp_path, NOW + timedelta(hours=5))
    stray = event("KXNFLGAME-26OCT18ARIXYZ", "x",
                  market("KXNFLGAME-26OCT18ARIXYZ-XYZ", "a", 0.5, 0.51),
                  market("KXNFLGAME-26OCT18ARIXYZ-ARI", "b", 0.49, 0.5))
    far = event("KXNFLGAME-26DEC06ARIXYZ", "x",
                market("KXNFLGAME-26DEC06ARIXYZ-XYZ", "a", 0.5, 0.51),
                market("KXNFLGAME-26DEC06ARIXYZ-ARI", "b", 0.49, 0.5))
    _run(path, {"KXNFLGAME": [ARI_LAR, stray, far]}, capsys)
    con = duckdb.connect(str(path))
    rows = con.execute("SELECT event_ticker FROM exchange_unmatched").fetchall()
    assert rows == [("KXNFLGAME-26OCT18ARIXYZ",)]


def test_one_college_alias_fixes_a_name_kalshi_spells_differently():
    # Kalshi says "UMass"; ESPN says "Massachusetts Minutemen". MASS is in the alias table,
    # UConn still matches by name.
    umass = event("KXNCAAFGAME-26OCT23MASSCONN", "UMass vs UConn",
                  market("KXNCAAFGAME-26OCT23MASSCONN-CONN", "UConn", 0.8, 0.81),
                  market("KXNCAAFGAME-26OCT23MASSCONN-MASS", "UMass", 0.19, 0.2))
    game = k.Game("701", "ncaaf", "UConn Huskies", "Massachusetts Minutemen",
                  datetime(2026, 10, 23, 23, 0, tzinfo=UTC))
    result = k.match_event(k.parse_event(umass, "ncaaf"), [game], ALIASES, {})
    assert isinstance(result, k.Matched) and result.sides == {"CONN": "home", "MASS": "away"}


def test_an_old_book_price_never_makes_a_flag(tmp_path, capsys):
    # The same game and prices, but DraftKings last seen 10 hours ago: too old to compare
    # with this minute's Kalshi price, so no stale book and no arb -- and it says so.
    path = _warehouse(tmp_path, NOW + timedelta(hours=5))
    con = duckdb.connect(str(path))
    con.execute("UPDATE odds_snapshots SET observed_at = ?", [NOW - timedelta(hours=10)])
    con.close()
    summary = _run(path, {"KXNFLGAME": [ARI_LAR]}, capsys)
    assert summary["quotes"] == 2 and summary["flags"] == 0
    assert summary["books_too_old"] == 1


# --- player props ------------------------------------------------------------------------

def prop_market(ticker, title, strike, bid, ask):
    return {"ticker": ticker, "title": title, "yes_sub_title": title.split(" receiving")[0],
            "floor_strike": strike, "yes_bid_dollars": f"{bid:.4f}", "yes_ask_dollars": f"{ask:.4f}",
            "yes_bid_size_fp": "3000.00", "yes_ask_size_fp": "3000.00", "volume_fp": "5000.00"}


REC_YDS = {"event_ticker": "KXNFLRECYDS-26OCT18ARILAR", "markets": [
    prop_market("KXNFLRECYDS-26OCT18ARILAR-LARPNACUA17-60", "Puka Nacua: 60+ receiving yards", 59.5, 0.62, 0.63),
    prop_market("KXNFLRECYDS-26OCT18ARILAR-ARIMHARRISON18-50", "Marvin Harrison: 50+ receiving yards", 49.5, 0.48, 0.49),
]}
FIRST_TD = {"event_ticker": "KXNFLFIRSTTD-26OCT18ARILAR", "markets": [
    {"ticker": "KXNFLFIRSTTD-26OCT18ARILAR-LARKWILLIAMS23", "title": "Kyren Williams: 1st Touchdown",
     "floor_strike": None, "yes_bid_dollars": "0.1400", "yes_ask_dollars": "0.1500",
     "yes_bid_size_fp": "5000.00", "yes_ask_size_fp": "5000.00", "volume_fp": "100.00"},
]}


def test_props_parse_player_team_and_line():
    props = k.parse_props(REC_YDS, "rec_yds", ["LAR", "ARI"])
    nacua = next(p for p in props if p.player == "Puka Nacua")
    assert (nacua.team_code, nacua.line, nacua.yes_bid) == ("LAR", 59.5, 0.62)
    first = k.parse_props(FIRST_TD, "first_td", ["LAR", "ARI"])[0]
    assert (first.player, first.team_code, first.line) == ("Kyren Williams", "LAR", None)


def _prop_feed(payloads):
    def request(url, headers, timeout):
        series = url.split("series_ticker=")[1].split("&")[0]
        return 200, {}, json.dumps({"events": payloads.get(series, []), "cursor": ""}).encode()
    return request


def _prop_run(path, payloads, capsys, at=NOW):
    k.main(["--db", str(path), "--league", "nfl"], request_fn=_prop_feed(payloads),
           sleep_fn=lambda s: None, clock=lambda: at)
    return json.loads(capsys.readouterr().out.strip().splitlines()[-1])


def test_props_link_through_the_matched_game_and_store_price_changes_only(tmp_path, capsys):
    path = _warehouse(tmp_path, NOW + timedelta(hours=5))
    stray = dict(REC_YDS, event_ticker="KXNFLRECYDS-26OCT18DALGB")  # no matched game
    feed = {"KXNFLGAME": [ARI_LAR], "KXNFLRECYDS": [REC_YDS, stray], "KXNFLFIRSTTD": [FIRST_TD]}
    summary = _prop_run(path, feed, capsys)
    assert summary["props"] == 3 and summary["props_unlinked"] == 1
    _prop_run(path, feed, capsys, at=NOW + timedelta(minutes=10))  # nothing moved
    moved = json.loads(json.dumps(feed))
    moved["KXNFLRECYDS"][0]["markets"][0]["yes_ask_dollars"] = "0.6500"
    _prop_run(path, moved, capsys, at=NOW + timedelta(minutes=20))  # Nacua's ask moved
    con = duckdb.connect(str(path))
    rows = con.execute("SELECT player, team_side, line, last_seen FROM exchange_props ORDER BY player, last_seen").fetchall()
    assert len(rows) == 4, "three contracts plus one price change"
    sides = {player: side for player, side, _, _ in rows}
    assert sides == {"Puka Nacua": "home", "Marvin Harrison": "away", "Kyren Williams": "home"}
    harrison = [r for r in rows if r[0] == "Marvin Harrison"]
    assert len(harrison) == 1 and harrison[0][3] == NOW + timedelta(minutes=20), "re-seen, not re-written"


def test_no_props_after_kickoff(tmp_path, capsys):
    path = _warehouse(tmp_path, NOW - timedelta(minutes=5))
    summary = _prop_run(path, {"KXNFLGAME": [ARI_LAR], "KXNFLRECYDS": [REC_YDS]}, capsys)
    assert summary["props"] == 0
