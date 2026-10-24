"""Settling prop legs from the box score: right answers, and refusals where it cannot know."""
import json
from datetime import datetime, timezone

import duckdb

import prop_results as pr
from db import Database
from schema import ensure_analytics_schema

UTC = timezone.utc


def athlete(name, stats, pid=None):
    return {"athlete": {"id": pid or name, "displayName": name}, "stats": stats}


BOX = {"boxscore": {"players": [
    {"team": {"abbreviation": "DET"}, "statistics": [
        {"name": "passing", "labels": ["C/ATT", "YDS", "AVG", "TD", "INT"], "athletes": [athlete("Jared Goff", ["24/33", "281", "8.5", "2", "0"])]},
        {"name": "rushing", "labels": ["CAR", "YDS", "AVG", "TD", "LONG"], "athletes": [athlete("Jahmyr Gibbs", ["15", "88", "5.9", "0", "21"])]},
        {"name": "receiving", "labels": ["REC", "YDS", "AVG", "TD", "LONG", "TGTS"], "athletes": [
            athlete("Jahmyr Gibbs", ["4", "31", "7.8", "1", "12", "5"]),
            athlete("Amon-Ra St. Brown", ["9", "104", "11.6", "1", "28", "11"]),
        ]},
        {"name": "kickReturns", "labels": ["NO", "YDS", "AVG", "LONG", "TD"], "athletes": [athlete("Kalif Raymond", ["2", "120", "60.0", "98", "1"])]},
    ]},
]}}


def test_box_stats_and_values():
    stats = pr.box_stats(BOX)
    key = pr.normalise
    assert pr.stat_value(stats[key("Jared Goff")], "pass_yds") == 281
    assert pr.stat_value(stats[key("Jahmyr Gibbs")], "anytime_td") == 1, "a receiving TD counts"
    assert pr.stat_value(stats[key("Jahmyr Gibbs")], "rush_rec_yds") == 119
    assert pr.stat_value(stats[key("Kalif Raymond")], "anytime_td") == 1, "a return TD counts"
    assert pr.stat_value(stats[key("Jared Goff")], "anytime_td") == 0, "his passing TDs are not his"
    assert pr.stat_value(stats[key("Jared Goff")], "first_td") is None, "first TD is left for a tap"
    assert key("Amon Ra St Brown") in stats and key("AmonRa St.Brown") in stats  # spacing and punctuation


def test_names_normalise_and_collisions_are_dropped():
    assert pr.normalise("Marvin Harrison Jr.") == pr.normalise("Marvin Harrison")
    box = {"boxscore": {"players": [{"statistics": [
        {"name": "rushing", "labels": ["CAR", "YDS", "AVG", "TD"], "athletes": [
            athlete("Josh Allen", ["5", "30", "6", "1"], "1"), athlete("Josh Allen", ["2", "4", "2", "0"], "2")]}]}]}}
    assert pr.normalise("Josh Allen") not in pr.box_stats(box)


def test_decisions():
    assert pr.decide(281, "over", 274.5) == "won"
    assert pr.decide(0, "over", 0.5) == "lost"
    assert pr.decide(48, "under", 49.5) == "won"
    assert pr.decide(50, "over", 50) == "push"


def _db(tmp_path):
    path = tmp_path / "w.duckdb"
    con = duckdb.connect(str(path))
    ensure_analytics_schema(Database.duckdb(con))
    now = datetime(2026, 10, 26, 2, 0, tzinfo=UTC)
    con.execute("INSERT INTO game_results VALUES ('GBDET', 'nfl', ?, NULL, NULL, 'Detroit Lions', 'Green Bay Packers', "
                "31, 24, 4, FALSE, 'final', TRUE, ?, 'r', 'x')", [now, now])
    legs = [("g", "Jared Goff", "pass_yds", 274.5), ("j", "Jahmyr Gibbs", "anytime_td", 0.5),
            ("x", "Somebody Else", "rec_yds", 40.5), ("t", "Jahmyr Gibbs", "first_td", 0.5),
            ("m", "Jared Goff", "pass_tds", 1.5)]
    for bet_id, player, stat, line in legs:
        con.execute("INSERT INTO bets (bet_id, owner_id, placed_at, league, event_id, market, side, line, price, stake, book, "
                    "parlay_id, parlay_price, prop_player, prop_stat) VALUES (?, 'owner', ?, 'nfl', 'GBDET', 'prop', 'over', ?, NULL, 25, "
                    "'BetRivers', 'P', 195, ?, ?)", [bet_id, now, line, player, stat])
    # Already tapped by hand: the box score must not override it.
    con.execute("INSERT INTO leg_results VALUES ('r1', 'owner', 'm', 'lost', 'manual', ?)", [now])
    con.close()
    return path


def test_run_settles_what_it_can_and_leaves_the_rest(tmp_path, capsys):
    path = _db(tmp_path)
    pr.main(["--db", str(path)], request_fn=lambda url, headers, timeout: (200, {}, json.dumps(BOX).encode()))
    summary = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert summary["settled"] == 2 and summary["player_not_found"] == 1 and summary["left_for_a_tap"] == 1
    con = duckdb.connect(str(path))
    got = dict(con.execute("SELECT bet_id, result FROM leg_results WHERE source = 'boxscore'").fetchall())
    assert got == {"g": "won", "j": "won"}
    assert con.execute("SELECT result FROM leg_results WHERE bet_id = 'm'").fetchall() == [("lost",)], "the tap stands"
    con.close()
    # Running again writes nothing new: every leg it could settle has a result now.
    pr.main(["--db", str(path)], request_fn=lambda url, headers, timeout: (200, {}, json.dumps(BOX).encode()))
    assert json.loads(capsys.readouterr().out.strip().splitlines()[-1])["settled"] == 0
