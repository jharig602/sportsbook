"""Grading tests.

Sign conventions and pushes are where this goes wrong silently: a flipped sign makes
a losing rule look profitable, and a push counted as a loss quietly understates every
alert kind. Both are covered explicitly here.
"""
from __future__ import annotations

from datetime import datetime, timezone

import pytest

from grading import (GameResult, american_to_decimal, grade_alert, grade_moneyline,
                     grade_outcome, grade_spread, grade_total, line_value_points,
                     price_value_decimal)
from signals import Alert

UTC = timezone.utc


def result(home=28, away=24, ot=False, completed=True):
    return GameResult("E1", "ncaaf", home, away, ot, completed)


def alert(market="spread", predicted_side="home", line=-3.0, price=-110, strength=60):
    return Alert(
        alert_id="A1", created_at=datetime(2026, 9, 10, tzinfo=UTC), league="ncaaf",
        event_id="E1", market=market, side=predicted_side, kind="steam",
        prev_line=None, new_line=line, prev_price=None, new_price=price,
        predicted_side=predicted_side, predicted_direction="toward_home",
        line_at_alert=line, price_at_alert=price, magnitude=2.0,
        move_strength=strength, message="test", rule_version_id="v1",
    )


# --- spreads -------------------------------------------------------------------

def test_home_favourite_covers():
    # Home wins by 4 laying 3.
    assert grade_spread("home", -3.0, result(28, 24)) is True


def test_home_favourite_fails_to_cover():
    # Home wins by 2 laying 3.
    assert grade_spread("home", -3.0, result(26, 24)) is False


def test_away_underdog_covers_on_a_narrow_loss():
    # Away loses by 2 getting 3.
    assert grade_spread("away", 3.0, result(26, 24)) is True


def test_away_underdog_covers_by_winning_outright():
    assert grade_spread("away", 3.0, result(20, 24)) is True


def test_spread_push_is_not_a_loss():
    """Home wins by exactly 3 laying 3. This must be a push, not False."""
    assert grade_spread("home", -3.0, result(27, 24)) is None
    assert grade_spread("away", 3.0, result(27, 24)) is None


def test_both_sides_of_a_spread_cannot_both_win():
    game = result(31, 24)
    home = grade_spread("home", -6.5, game)
    away = grade_spread("away", 6.5, game)
    assert home is not away
    assert {home, away} == {True, False}


# --- totals --------------------------------------------------------------------

def test_over_wins_when_points_exceed_the_line():
    assert grade_total("over", 47.5, result(28, 24)) is True     # 52 points
    assert grade_total("under", 47.5, result(28, 24)) is False


def test_under_wins_on_a_low_scoring_game():
    assert grade_total("under", 47.5, result(10, 7)) is True
    assert grade_total("over", 47.5, result(10, 7)) is False


def test_total_push_on_the_number():
    assert grade_total("over", 52.0, result(28, 24)) is None
    assert grade_total("under", 52.0, result(28, 24)) is None


def test_overtime_points_count_toward_the_total():
    """Full-game totals include OT at every mainstream book, so an OT game is graded
    on its final score with no special casing."""
    game = result(35, 31, ot=True)
    assert grade_total("over", 60.5, game) is True
    assert game.total_points == 66


# --- moneyline -----------------------------------------------------------------

def test_moneyline_follows_the_winner():
    assert grade_moneyline("home", result(28, 24)) is True
    assert grade_moneyline("away", result(28, 24)) is False
    assert grade_moneyline("away", result(20, 24)) is True


def test_moneyline_tie_is_a_push():
    assert grade_moneyline("home", result(24, 24)) is None
    assert grade_moneyline("away", result(24, 24)) is None


# --- line value ----------------------------------------------------------------

def test_spread_line_value_positive_when_market_moved_our_way():
    """Took home +22.5, closed +20.5: two points of value."""
    assert line_value_points("spread", "home", 22.5, 20.5) == pytest.approx(2.0)


def test_spread_line_value_negative_when_market_moved_against_us():
    assert line_value_points("spread", "home", 20.5, 22.5) == pytest.approx(-2.0)


def test_spread_line_value_on_a_favourite():
    """Took home -3, closed -4: one point of value."""
    assert line_value_points("spread", "home", -3.0, -4.0) == pytest.approx(1.0)


def test_total_line_value_is_direction_aware():
    # Over wants the lower number, under wants the higher one.
    assert line_value_points("total", "over", 47.5, 49.5) == pytest.approx(2.0)
    assert line_value_points("total", "under", 47.5, 49.5) == pytest.approx(-2.0)
    assert line_value_points("total", "under", 49.5, 47.5) == pytest.approx(2.0)


def test_line_value_is_none_without_both_lines():
    assert line_value_points("spread", "home", None, 20.5) is None
    assert line_value_points("spread", "home", 22.5, None) is None


def test_moneyline_has_no_points_of_line_value():
    assert line_value_points("moneyline", "home", None, None) is None


# --- price conversion ----------------------------------------------------------

@pytest.mark.parametrize("price,decimal", [
    (100, 2.0), (-100, 2.0), (200, 3.0), (-200, 1.5), (-110, pytest.approx(1.9090909)),
])
def test_american_to_decimal(price, decimal):
    assert american_to_decimal(price) == decimal


def test_american_to_decimal_rejects_impossible_prices():
    assert american_to_decimal(None) is None
    assert american_to_decimal(50) is None


def test_price_value_positive_when_we_got_the_better_payout():
    assert price_value_decimal(120, 100) == pytest.approx(0.2)
    assert price_value_decimal(100, 120) == pytest.approx(-0.2)


# --- whole-alert grading -------------------------------------------------------

def test_unfinished_game_is_not_graded():
    assert grade_alert(alert(), result(completed=False), 20.5, -110) is None


def test_grade_records_both_axes_independently():
    """The case that proves the two axes are separate: good line value, losing bet."""
    graded = grade_alert(alert(market="spread", predicted_side="home", line=-3.0),
                         result(26, 24), closing_line=-4.0, closing_price=-110)
    assert graded.line_value_points == pytest.approx(1.0)
    assert graded.line_value_won is True
    assert graded.result_covered is False       # won by 2 laying 3
    assert graded.result_push is False


def test_push_is_flagged_and_not_recorded_as_a_loss():
    graded = grade_alert(alert(line=-3.0), result(27, 24), closing_line=-3.0,
                         closing_price=-110)
    assert graded.result_covered is None
    assert graded.result_push is True


def test_unmoved_line_is_not_a_line_value_win():
    """A line that never moved vindicates the alert in neither direction."""
    graded = grade_alert(alert(line=-3.0), result(), closing_line=-3.0, closing_price=-110)
    assert graded.line_value_points == pytest.approx(0.0)
    assert graded.line_value_won is False


def test_moneyline_line_value_falls_back_to_price():
    graded = grade_alert(alert(market="moneyline", line=None, price=150),
                         result(28, 24), closing_line=None, closing_price=120)
    assert graded.line_value_points is None
    assert graded.price_value_decimal == pytest.approx(0.3)
    assert graded.line_value_won is True
    assert graded.result_covered is True


def test_grade_carries_the_rule_version_forward():
    """Grades must stay attributable to the exact thresholds that fired the alert."""
    graded = grade_alert(alert(), result(), 20.5, -110)
    assert graded.rule_version_id == "v1"
    assert graded.move_strength == 60


def test_grade_outcome_dispatches_by_market():
    game = result(28, 24)
    assert grade_outcome("spread", "home", -3.0, game) is True
    assert grade_outcome("total", "over", 47.5, game) is True
    assert grade_outcome("moneyline", "home", None, game) is True
    assert grade_outcome("spread", "home", None, game) is None
