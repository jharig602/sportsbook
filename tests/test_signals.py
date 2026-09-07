"""Signal engine tests.

The false-positive cases matter most here: a rule that fires on noise is what turns
the phone into a spam machine and makes the alerts worthless.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from signals import (DEFAULT_CONFIG, Observation, RuleConfig, collapse_for_display,
                     detect, detect_all, strength)

UTC = timezone.utc
KICKOFF = datetime(2026, 9, 12, 16, 0, tzinfo=UTC)


def obs(hours_before, line, price=-110, market="spread", side="home", event_id="E1"):
    return Observation(
        observed_at=KICKOFF - timedelta(hours=hours_before),
        league="ncaaf", event_id=event_id, market=market, side=side,
        line=line, price=price, commence_time=KICKOFF,
        home_team="Oklahoma State Cowboys", away_team="Oregon Ducks",
    )


def kinds(alerts):
    return sorted(a.kind for a in alerts)


# --- the case that protects your phone -----------------------------------------

def test_flat_series_produces_only_the_first_price_alert():
    series = [obs(h, 22.5) for h in (120, 96, 72, 48, 24)]
    alerts = detect(series)
    assert kinds(alerts) == ["first_price"], "an unmoving line must not generate movement alerts"


def test_sub_threshold_wobble_is_ignored():
    """Half-point noise is the normal breathing of a line, not a signal."""
    series = [obs(120, 22.5), obs(96, 23.0), obs(72, 22.5), obs(48, 23.0)]
    alerts = [a for a in detect(series) if a.kind != "first_price"]
    assert alerts == []


def test_unpriced_series_generates_nothing():
    series = [obs(h, None, price=None) for h in (120, 96, 72)]
    assert detect(series) == []


def test_empty_series_generates_nothing():
    assert detect([]) == []


# --- steam ---------------------------------------------------------------------

def test_steam_fires_on_a_large_line_move():
    alerts = detect([obs(48, 22.5), obs(24, 20.5)])
    steam = [a for a in alerts if a.kind == "steam"]
    assert len(steam) == 1
    assert steam[0].prev_line == 22.5 and steam[0].new_line == 20.5


def test_steam_direction_follows_the_shrinking_handicap():
    """Home handicap +22.5 -> +20.5 means money is coming in on the home side."""
    alerts = detect([obs(48, 22.5), obs(24, 20.5)])
    steam = next(a for a in alerts if a.kind == "steam")
    assert steam.predicted_side == "home"
    assert steam.predicted_direction == "toward_home"


def test_steam_direction_reverses_when_the_handicap_grows():
    alerts = detect([obs(48, 20.5), obs(24, 22.5)])
    steam = next(a for a in alerts if a.kind == "steam")
    assert steam.predicted_side == "away"


def test_total_rising_points_to_the_over():
    series = [obs(48, 54.5, market="total", side="over"),
              obs(24, 57.5, market="total", side="over")]
    steam = next(a for a in detect(series) if a.kind == "steam")
    assert steam.predicted_side == "over"
    assert steam.predicted_direction == "toward_over"


def test_price_steam_only_when_the_line_holds():
    moved = detect([obs(48, 22.5, price=-110), obs(24, 22.5, price=-130)])
    price_steam = [a for a in moved if a.kind == "steam" and "implied" in a.message]
    assert len(price_steam) == 1
    assert price_steam[0].prev_price == -110 and price_steam[0].new_price == -130

    # Same price move, but the line moved too — that is line steam, not price steam,
    # and counting it twice would double-weight one event.
    both = detect([obs(48, 22.5, price=-110), obs(24, 20.5, price=-130)])
    assert [a for a in both if "implied" in a.message] == []
    assert [a for a in both if a.kind == "steam"], "the line move should still fire"


# --- key numbers ---------------------------------------------------------------

def test_crossing_three_fires():
    alerts = detect([obs(48, 2.5), obs(24, 3.5)])
    assert "key_number" in kinds(alerts)


def test_key_number_weight_orders_three_above_fourteen():
    three = next(a for a in detect([obs(48, 2.5), obs(24, 3.5)]) if a.kind == "key_number")
    fourteen = next(a for a in detect([obs(48, 13.5), obs(24, 14.5)]) if a.kind == "key_number")
    assert three.move_strength > fourteen.move_strength


def test_landing_exactly_on_a_key_number_is_not_a_crossing():
    """2.5 -> 3.0 reaches 3 but does not pass through it; the push number still lives."""
    alerts = detect([obs(48, 2.5), obs(24, 3.0)])
    assert "key_number" not in kinds(alerts)


def test_key_numbers_use_absolute_value_so_both_sides_agree():
    home = detect([obs(48, -2.5), obs(24, -3.5)])
    away = detect([obs(48, 2.5), obs(24, 3.5)])
    assert ("key_number" in kinds(home)) == ("key_number" in kinds(away)) is True


# --- first price ---------------------------------------------------------------

def test_first_price_strength_rewards_earlier_posting():
    early = detect([obs(200, 22.5)])[0]
    late = detect([obs(6, 22.5)])[0]
    assert early.kind == late.kind == "first_price"
    assert early.move_strength > late.move_strength


def test_first_price_needs_a_price():
    assert detect([obs(48, 22.5, price=None)]) == []


# --- drift ---------------------------------------------------------------------

def test_drift_measures_the_whole_week_not_one_step():
    """Four sub-threshold steps that add up to a big repricing must still register."""
    series = [obs(120, 20.5), obs(96, 21.5), obs(72, 22.5), obs(48, 23.5), obs(24, 24.5)]
    drift = [a for a in detect(series) if a.kind == "drift"]
    assert len(drift) == 1
    assert drift[0].magnitude == pytest.approx(4.0)
    assert drift[0].predicted_side == "away"


def test_no_drift_when_the_line_returns_to_open():
    series = [obs(120, 20.5), obs(96, 24.5), obs(24, 20.5)]
    assert "drift" not in kinds([a for a in detect(series)])


# --- strength curve ------------------------------------------------------------

def test_strength_is_bounded_and_monotonic():
    values = [strength(m, 2.0) for m in (0, 0.5, 1, 2, 4, 8, 50)]
    assert values == sorted(values)
    assert values[0] == 0
    assert max(values) < 100, "strength must never assert certainty"


def test_zero_and_negative_magnitude_score_zero():
    assert strength(0, 2.0) == 0
    assert strength(-5, 2.0) == 0


# --- prediction integrity ------------------------------------------------------

def test_every_alert_is_falsifiable():
    """grading.py cannot score an alert that does not say what it expects."""
    series = [obs(120, 20.5), obs(96, 22.5), obs(48, 25.5), obs(24, 26.0)]
    alerts = detect(series)
    assert alerts
    for alert in alerts:
        assert alert.predicted_side in {"home", "away", "over", "under"}
        assert alert.predicted_direction.startswith("toward_")
        assert alert.line_at_alert is not None
        assert alert.rule_version_id


def test_rule_version_changes_when_thresholds_change():
    tighter = RuleConfig(steam_line_points=2.5)
    assert tighter.version_id() != DEFAULT_CONFIG.version_id()
    assert RuleConfig().version_id() == DEFAULT_CONFIG.version_id()


def test_detect_all_splits_series_and_ranks_by_strength():
    stream = [
        obs(48, 22.5, event_id="E1"), obs(24, 20.5, event_id="E1"),
        obs(48, 10.5, event_id="E2"), obs(24, 4.5, event_id="E2"),
    ]
    alerts = detect_all(stream)
    assert {a.event_id for a in alerts} == {"E1", "E2"}
    strengths = [a.move_strength for a in alerts]
    assert strengths == sorted(strengths, reverse=True)


# --- side-consistency (bugs found running against live data) --------------------

def test_both_spread_series_agree_on_who_the_money_is_on():
    """Home +22.5 -> +20.5 and away -22.5 -> -20.5 are one market move. Reading the
    sign alone made the two series disagree and mispredicted away-side spreads."""
    home = detect([obs(48, 22.5, side="home"), obs(24, 20.5, side="home")])
    away = detect([obs(48, -22.5, side="away"), obs(24, -20.5, side="away")])
    home_move = next(a for a in home if a.kind == "steam")
    assert home_move.predicted_side == "home"
    # The away series is not canonical, so it emits no line alert at all — but if the
    # rule is ever asked directly it must give the same answer.
    from signals import _favoured_side
    assert _favoured_side("spread", "away", +2.0) == "home"
    assert _favoured_side("spread", "home", -2.0) == "home"
    assert away == [a for a in away if a.kind == "first_price"]


def test_one_market_move_produces_one_line_alert_not_two():
    """Both sides see the same handicap move; the phone should get one card."""
    stream = [obs(48, 22.5, side="home"), obs(24, 20.5, side="home"),
              obs(48, -22.5, side="away"), obs(24, -20.5, side="away")]
    steam = [a for a in detect_all(stream) if a.kind == "steam"]
    assert len(steam) == 1


def test_total_line_move_produces_one_alert_not_two():
    stream = [obs(48, 54.5, market="total", side="over"),
              obs(24, 56.5, market="total", side="over"),
              obs(48, 54.5, market="total", side="under"),
              obs(24, 56.5, market="total", side="under")]
    steam = [a for a in detect_all(stream) if a.kind == "steam"]
    assert len(steam) == 1
    assert steam[0].predicted_side == "over"


# --- price movement in implied probability, not cents ---------------------------

def test_longshot_cent_moves_are_not_treated_as_huge():
    """-3600 to -4500 is 900 'cents' but half a point of implied probability. Ranking
    by cents put heavy favourites at the top of every list."""
    series = [obs(48, None, price=-3600, market="moneyline"),
              obs(24, None, price=-4500, market="moneyline")]
    assert [a for a in detect(series) if a.kind == "steam"] == []


def test_crossing_plus_minus_one_hundred_is_not_a_giant_move():
    """-102 to +100 looks like a 202-cent jump on the American scale and is really
    half a percentage point."""
    series = [obs(48, 47.5, price=-102, market="total", side="over"),
              obs(24, 47.5, price=100, market="total", side="over")]
    assert [a for a in detect(series) if a.kind == "steam"] == []


def test_a_real_price_move_still_fires():
    series = [obs(48, 47.5, price=-110, market="total", side="over"),
              obs(24, 47.5, price=-135, market="total", side="over")]
    steam = [a for a in detect(series) if a.kind == "steam"]
    assert len(steam) == 1
    assert steam[0].predicted_side == "over"


def test_price_steam_direction_follows_implied_probability():
    """A price getting cheaper means money is leaving that side, not backing it."""
    cheaper = [obs(48, None, price=-200, market="moneyline", side="home"),
               obs(24, None, price=-130, market="moneyline", side="home")]
    alert = next(a for a in detect(cheaper) if a.kind == "steam")
    assert alert.predicted_side == "away"

    pricier = [obs(48, None, price=-130, market="moneyline", side="home"),
               obs(24, None, price=-200, market="moneyline", side="home")]
    alert = next(a for a in detect(pricier) if a.kind == "steam")
    assert alert.predicted_side == "home"


def test_totals_render_without_a_misleading_sign():
    series = [obs(48, 54.5, market="total", side="over"),
              obs(24, 56.5, market="total", side="over")]
    message = next(a for a in detect(series) if a.kind == "steam").message
    assert "+54.5" not in message and "54.5" in message


def test_collapse_merges_two_sides_of_one_price_move():
    """The over growing pricier and the under growing cheaper is one money movement."""
    stream = [obs(48, 47.5, price=-110, market="total", side="over"),
              obs(24, 47.5, price=-135, market="total", side="over"),
              obs(48, 47.5, price=-110, market="total", side="under"),
              obs(24, 47.5, price=100, market="total", side="under")]
    raw = [a for a in detect_all(stream) if a.kind == "steam"]
    collapsed = [a for a in collapse_for_display(raw) if a.kind == "steam"]
    assert len(raw) == 2, "both observations are real and both are stored"
    assert len(collapsed) == 1, "but the phone should show one card"
    assert collapsed[0].predicted_side == "over"


def test_collapse_keeps_the_strongest_of_a_duplicate_pair():
    stream = [obs(48, 47.5, price=-110, market="total", side="over"),
              obs(24, 47.5, price=-160, market="total", side="over"),
              obs(48, 47.5, price=-110, market="total", side="under"),
              obs(24, 47.5, price=105, market="total", side="under")]
    collapsed = [a for a in collapse_for_display(detect_all(stream)) if a.kind == "steam"]
    assert len(collapsed) == 1
    assert collapsed[0].side == "over", "the larger move should be the one shown"


def test_collapse_keeps_genuinely_different_alerts():
    """Opposite conclusions, or different games, must never be merged."""
    stream = [obs(48, 22.5, side="home", event_id="E1"),
              obs(24, 20.5, side="home", event_id="E1"),
              obs(48, 10.5, side="home", event_id="E2"),
              obs(24, 13.5, side="home", event_id="E2")]
    collapsed = [a for a in collapse_for_display(detect_all(stream)) if a.kind == "steam"]
    assert len(collapsed) == 2
    assert {a.predicted_side for a in collapsed} == {"home", "away"}


def test_collapse_on_empty_input():
    assert collapse_for_display([]) == []


def test_rerunning_detection_produces_identical_alert_ids():
    """Detection re-scans the full history every poll. Ids must be stable or the same
    move is re-inserted and re-notified every 30 minutes."""
    series = [obs(48, 22.5), obs(24, 20.5)]
    first = {a.alert_id for a in detect(series)}
    second = {a.alert_id for a in detect(list(reversed(series)))}
    assert first == second
    assert len(first) == len(detect(series))


def test_two_key_numbers_crossed_at_once_stay_distinct():
    """20.5 -> 2.5 crosses several key numbers; none may collide into one alert."""
    alerts = [a for a in detect([obs(48, 20.5), obs(24, 2.5)]) if a.kind == "key_number"]
    assert len(alerts) > 1
    assert len({a.alert_id for a in alerts}) == len(alerts)


def test_changing_thresholds_changes_alert_ids():
    series = [obs(48, 22.5), obs(24, 20.5)]
    default = {a.alert_id for a in detect(series)}
    retuned = {a.alert_id for a in detect(series, RuleConfig(steam_scale_points=3.0))}
    assert default.isdisjoint(retuned), "a new rule version must mint new alerts"


def test_series_are_isolated_by_market_and_side():
    """A home-side move must not be compared against an over-side quote."""
    stream = [
        obs(48, 22.5, market="spread", side="home"),
        obs(24, 57.5, market="total", side="over"),
    ]
    alerts = detect_all(stream)
    assert all(a.kind == "first_price" for a in alerts)
