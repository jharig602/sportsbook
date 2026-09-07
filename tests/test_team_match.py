"""Matching feed games to ESPN games.

The tests that matter most here are the negative ones. A missed match costs one game's
comparison; a wrong match prices one team against a different team's line and reports
the difference as an edge.
"""
from datetime import datetime, timedelta, timezone

import team_match as tm

UTC = timezone.utc
KICK = datetime(2026, 9, 12, 23, 0, tzinfo=UTC)


def candidate(key, home, away, at=KICK):
    return tm.Candidate(key, home, away, at)


# --- normalization ---------------------------------------------------------------

def test_identical_names_normalize_identically():
    assert tm.normalize("Michigan Wolverines") == tm.normalize("Michigan Wolverines")


def test_accents_and_punctuation_are_stripped():
    assert tm.normalize("Hawai'i Rainbow Warriors") == tm.normalize("Hawaii Rainbow Warriors")
    assert tm.normalize("Miami (OH) RedHawks") == tm.normalize("Miami OH RedHawks")


def test_ampersand_and_state_abbreviations_expand():
    assert tm.normalize("Texas A&M Aggies") == tm.normalize("Texas A and M Aggies")
    assert tm.normalize("Ohio St Buckeyes") == tm.normalize("Ohio State Buckeyes")


def test_filler_words_are_dropped():
    assert tm.normalize("University of Michigan") == tm.normalize("Michigan")


def test_normalize_survives_empty_input():
    assert tm.normalize(None) == ""
    assert tm.normalize("") == ""


# --- similarity ------------------------------------------------------------------

def test_a_name_is_identical_to_itself():
    assert tm.similarity("Michigan Wolverines", "Michigan Wolverines") == 1.0


def test_spelling_drift_within_a_word_still_scores():
    assert tm.similarity("UMass Minutemen", "Massachusetts Minutemen") > 0.5


def test_different_schools_sharing_a_city_score_low():
    # The case that must never match. Both are "Miami"; only the mascot separates them,
    # and a matcher that leaned on the city alone would price one against the other.
    assert tm.similarity("Miami Hurricanes", "Miami RedHawks") < 0.75


def test_missing_name_scores_zero_rather_than_matching_everything():
    assert tm.similarity(None, "Michigan Wolverines") == 0.0


# --- matching --------------------------------------------------------------------

def test_an_exact_slate_matches_completely():
    feed = [candidate("f1", "Michigan Wolverines", "Oklahoma Sooners"),
            candidate("f2", "Texas A&M Aggies", "Arizona State Sun Devils")]
    espn = [candidate("e1", "Michigan Wolverines", "Oklahoma Sooners"),
            candidate("e2", "Texas A&M Aggies", "Arizona State Sun Devils")]
    matches, unmatched = tm.match_events(feed, espn)
    assert unmatched == []
    assert {(m.feed_key, m.espn_key) for m in matches} == {("f1", "e1"), ("f2", "e2")}


def test_spelling_differences_between_sources_still_match():
    feed = [candidate("f1", "Miami (OH) RedHawks", "Ohio St Bobcats")]
    espn = [candidate("e1", "Miami OH RedHawks", "Ohio State Bobcats")]
    matches, unmatched = tm.match_events(feed, espn)
    assert len(matches) == 1
    assert unmatched == []


def test_both_teams_must_match_not_just_one():
    # Same home team, completely different opponent: this is a different game.
    feed = [candidate("f1", "Michigan Wolverines", "Oklahoma Sooners")]
    espn = [candidate("e1", "Michigan Wolverines", "Rutgers Scarlet Knights")]
    matches, unmatched = tm.match_events(feed, espn)
    assert matches == []
    assert unmatched[0].reason == "no name match above threshold"


def test_the_two_miamis_are_not_confused():
    feed = [candidate("f1", "Miami Hurricanes", "Florida State Seminoles")]
    espn = [candidate("e1", "Miami RedHawks", "Florida State Seminoles")]
    matches, _ = tm.match_events(feed, espn)
    assert matches == []


def test_a_kickoff_far_outside_the_window_blocks_a_perfect_name_match():
    feed = [candidate("f1", "Michigan Wolverines", "Oklahoma Sooners")]
    espn = [candidate("e1", "Michigan Wolverines", "Oklahoma Sooners", KICK + timedelta(days=7))]
    matches, unmatched = tm.match_events(feed, espn)
    assert matches == []
    assert unmatched[0].reason == "no ESPN game within the kickoff window"


def test_a_small_kickoff_disagreement_is_tolerated():
    feed = [candidate("f1", "Michigan Wolverines", "Oklahoma Sooners")]
    espn = [candidate("e1", "Michigan Wolverines", "Oklahoma Sooners", KICK + timedelta(hours=2))]
    matches, _ = tm.match_events(feed, espn)
    assert len(matches) == 1


def test_two_indistinguishable_candidates_are_refused_not_guessed():
    # A doubleheader-shaped trap: the same two programmes, same window. Names cannot
    # separate them, so the honest answer is to place neither.
    feed = [candidate("f1", "Michigan Wolverines", "Oklahoma Sooners")]
    espn = [candidate("e1", "Michigan Wolverines", "Oklahoma Sooners"),
            candidate("e2", "Michigan Wolverines", "Oklahoma Sooners", KICK + timedelta(hours=1))]
    matches, unmatched = tm.match_events(feed, espn)
    assert matches == []
    assert unmatched[0].reason == "ambiguous: two ESPN games score alike"


def test_one_espn_game_is_never_claimed_twice():
    feed = [candidate("f1", "Michigan Wolverines", "Oklahoma Sooners"),
            candidate("f2", "Michigan Wolverines", "Oklahoma Sooners")]
    espn = [candidate("e1", "Michigan Wolverines", "Oklahoma Sooners")]
    matches, unmatched = tm.match_events(feed, espn)
    assert len(matches) <= 1
    assert len(matches) + len(unmatched) == 2


def test_a_feed_game_absent_from_espn_is_reported_not_dropped():
    feed = [candidate("f1", "Michigan Wolverines", "Oklahoma Sooners"),
            candidate("f2", "Sam Houston Bearkats", "Jacksonville State Gamecocks")]
    espn = [candidate("e1", "Michigan Wolverines", "Oklahoma Sooners")]
    matches, unmatched = tm.match_events(feed, espn)
    assert len(matches) == 1
    assert len(unmatched) == 1
    assert unmatched[0].feed_key == "f2"


def test_home_and_away_are_not_interchangeable():
    # A reversed fixture is a different game, and swapping it would flip the sign of
    # every line recorded against it.
    feed = [candidate("f1", "Michigan Wolverines", "Oklahoma Sooners")]
    espn = [candidate("e1", "Oklahoma Sooners", "Michigan Wolverines")]
    matches, _ = tm.match_events(feed, espn)
    assert matches == []


def test_a_strong_match_wins_its_game_over_a_weaker_rival():
    feed = [candidate("f1", "Michigan Wolverines", "Oklahoma Sooners"),
            candidate("f2", "Michigan Wolverines", "Oklahoma Panhandle State Aggies")]
    espn = [candidate("e1", "Michigan Wolverines", "Oklahoma Sooners")]
    matches, _ = tm.match_events(feed, espn)
    assert [(m.feed_key, m.espn_key) for m in matches] == [("f1", "e1")]


def test_an_empty_feed_matches_nothing_without_error():
    matches, unmatched = tm.match_events([], [candidate("e1", "Michigan", "Ohio State")])
    assert matches == [] and unmatched == []


def test_an_empty_espn_slate_reports_every_feed_game():
    feed = [candidate("f1", "Michigan Wolverines", "Oklahoma Sooners")]
    matches, unmatched = tm.match_events(feed, [])
    assert matches == []
    assert len(unmatched) == 1


def test_aliases_are_applied_when_present(monkeypatch):
    # The list ships empty by design; this proves the mechanism works so entries added
    # from a real run take effect.
    monkeypatch.setitem(tm.ALIASES, "louisiana ragin cajuns", "louisiana lafayette")
    assert tm.normalize("Louisiana Ragin' Cajuns") == "louisiana lafayette"


# --- reporting -------------------------------------------------------------------

def test_the_summary_names_what_failed_so_aliases_can_be_written():
    feed = [candidate("f1", "Sam Houston Bearkats", "Jacksonville State Gamecocks")]
    _, unmatched = tm.match_events(feed, [])
    line = tm.summarize_unmatched(unmatched)
    assert "Sam Houston Bearkats" in line
    assert "Jacksonville State Gamecocks" in line


def test_a_clean_run_says_so():
    assert tm.summarize_unmatched([]) == "all feed games matched"


def test_the_summary_truncates_rather_than_flooding_the_log():
    rows = [tm.Unmatched(f"f{i}", "Home", "Away", KICK, "no name match above threshold")
            for i in range(25)]
    line = tm.summarize_unmatched(rows, limit=5)
    assert "25 unmatched" in line
    assert "+20 more" in line
