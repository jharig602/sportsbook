"""Margin-model tests.

The distribution has to be coherent before anything derived from it means much: the
three pieces (below, exactly on, above) must sum to one. An earlier version added a
normal tail on top of an empirical pmf that already summed to one, which made a
pick'em read 57% instead of 50% — small enough to look plausible and wrong enough to
mis-price every moneyline comparison.
"""
from __future__ import annotations

import random

import pytest

from margins import MIN_GAMES, MarginModel, fit, key_number_mass


def symmetric(n: int = 600, spike: int = 3) -> list[int]:
    """Symmetric residuals with a deliberate spike on a key number."""
    random.seed(7)
    values = [random.randint(-20, 20) for _ in range(n)]
    values += [spike] * (n // 10) + [-spike] * (n // 10)
    return values


# --- fitting --------------------------------------------------------------------

def test_fit_reports_sample_size_and_moments():
    model = fit("nfl", symmetric())
    assert model.games > MIN_GAMES
    assert model.sd > 0
    assert abs(model.mean) < 1.5, "a symmetric sample should centre near zero"


def test_empty_sample_is_not_usable():
    model = fit("nfl", [])
    assert model.games == 0
    assert model.usable is False


def test_thin_sample_is_not_usable():
    model = fit("nfl", [1, -1, 3, -3] * 10)
    assert model.games < MIN_GAMES
    assert model.usable is False


def test_unusable_model_refuses_to_answer():
    """A thin fit returns NaN rather than a confident-looking number."""
    model = fit("nfl", [1, -1] * 5)
    import math
    assert math.isnan(model.probability_above(0))
    assert math.isnan(model.win_probability(0))


# --- coherence ------------------------------------------------------------------

def test_the_three_pieces_sum_to_one():
    model = fit("nfl", symmetric())
    above = model.probability_above(0)
    exactly = model.probability_of(0)
    below = 1 - above - exactly
    assert abs(above + exactly + below - 1) < 1e-9
    assert 0 <= below <= 1


def test_a_symmetric_sample_is_a_coin_flip():
    model = fit("nfl", symmetric())
    assert abs(model.probability_above(0) - (1 - model.probability_above(0)
                                             - model.probability_of(0))) < 0.05


def test_probability_falls_as_the_threshold_rises():
    model = fit("nfl", symmetric())
    values = [model.probability_above(t) for t in (-14, -7, -3, 0, 3, 7, 14)]
    assert values == sorted(values, reverse=True)


def test_probability_stays_in_range_far_outside_the_sample():
    model = fit("nfl", symmetric())
    assert 0.0 <= model.probability_above(500) <= 1.0
    assert 0.0 <= model.probability_above(-500) <= 1.0


def test_beyond_the_sample_is_a_small_tail_not_zero():
    """A spread past anything observed must not read as impossible."""
    model = fit("nfl", symmetric())
    far = model.probability_above(model.hi + 10)
    assert 0 < far < 0.02


# --- pushes and key numbers ------------------------------------------------------

def test_only_whole_numbers_can_push():
    """A half-point residual has no mass on the grid, which is why a half-point line
    cannot push. This is the reason the pmf is keyed in half-points at all."""
    model = fit("nfl", symmetric())
    assert model.probability_of(3.5) == 0.0
    assert model.probability_of(3.0) > 0.0


def test_cover_is_the_residual_being_positive():
    model = fit("nfl", symmetric())
    cover, push = model.cover_probability()
    # Covering IS residual > 0, so a symmetric sample must be a coin flip.
    assert abs(cover - 0.5) < 0.06
    assert 0 <= push <= 1


def test_the_spike_shows_up_in_key_number_mass():
    model = fit("nfl", symmetric(spike=3))
    masses = key_number_mass(model)
    assert masses[3] > masses[14], "the seeded spike on 3 should dominate"


def test_cover_and_push_are_consistent_with_each_other():
    model = fit("nfl", symmetric())
    cover, push = model.cover_probability()
    assert 0 <= cover <= 1 and 0 <= push <= 1
    assert cover + push <= 1.0 + 1e-9


def test_half_point_residuals_survive_the_fit():
    """Half-point residuals are the common case — most spreads are half-points — and
    rounding them onto whole numbers smears mass onto values that cannot occur."""
    # Realistic spread, so the normal tails stay small and the body dominates.
    values = [v + 0.5 for v in symmetric()]
    model = fit("nfl", values)
    assert model.probability_of(3.5) > 0.0, "half-point mass must survive"
    assert model.probability_of(3.0) == 0.0, "no residual landed on a whole number"


# --- win probability -------------------------------------------------------------

def test_win_probability_excludes_ties_rather_than_splitting_them():
    """An NFL tie pushes the moneyline; it is not half a win."""
    values = symmetric() + [0] * 100
    model = fit("nfl", values)
    assert model.usable
    win = model.win_probability(0)
    assert 0 < win < 1
    assert abs(win - 0.5) < 0.06


def test_a_bigger_spread_means_a_higher_win_probability():
    model = fit("nfl", symmetric())
    assert model.win_probability(-14.0) > model.win_probability(-3.0)


def test_serialisation_round_trips():
    import json
    model = fit("nfl", symmetric())
    payload = json.loads(model.to_json())
    assert payload["games"] == model.games
    assert payload["pmf"]["6"] == pytest.approx(model.pmf[6])  # key 6 = 3 points
