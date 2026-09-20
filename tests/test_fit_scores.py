"""Fitting the joint score model.

The correlation is the number a same-game parlay turns on, so these check it against
hand-computable cases rather than against whatever the season happened to produce.
"""
from __future__ import annotations

import pytest

from fit_scores import fit_joint


def test_means_and_spreads_are_the_sample_statistics():
    # Margins -1, 0, 1 and totals 9, 10, 11: mean 0 and 10, sample sd 1 for both.
    model = fit_joint("nfl", [(-1.0, 9.0), (0.0, 10.0), (1.0, 11.0)])
    assert model.games == 3
    assert model.margin_mean == 0
    assert model.total_mean == 10
    assert model.margin_sd == pytest.approx(1.0)
    assert model.total_sd == pytest.approx(1.0)


def test_a_perfect_relationship_reads_as_one_or_minus_one():
    up = fit_joint("nfl", [(-1.0, 9.0), (0.0, 10.0), (1.0, 11.0)])
    assert up.correlation == pytest.approx(1.0)
    down = fit_joint("nfl", [(-1.0, 11.0), (0.0, 10.0), (1.0, 9.0)])
    assert down.correlation == pytest.approx(-1.0)


def test_independent_residuals_read_as_no_correlation():
    # A symmetric square: every margin pairs with every total.
    pairs = [(m, t) for m in (-1.0, 1.0) for t in (-1.0, 1.0)]
    assert fit_joint("nfl", pairs).correlation == pytest.approx(0.0)


def test_correlation_matches_a_hand_computed_value():
    pairs = [(0.0, 0.0), (1.0, 1.0), (2.0, 1.0), (3.0, 3.0)]
    # Margins 0,1,2,3: mean 1.5, sample sd 1.2910. Totals 0,1,1,3: mean 1.25, sd 1.2583.
    # Covariance is (1.875 + 0.125 - 0.125 + 2.625) / 3 = 1.5, so r = 1.5 / 1.6245.
    assert fit_joint("nfl", pairs).correlation == pytest.approx(0.9233, abs=1e-4)


def test_nothing_to_fit_returns_nothing_rather_than_a_model_of_zeros():
    # A stored row of sd 0 and correlation 0 would price every same-game parlay as two
    # independent certainties -- a confident number with nothing behind it.
    assert fit_joint("nfl", []) is None
    assert fit_joint("nfl", [(1.0, 2.0)]) is None


def test_a_constant_residual_is_refused():
    # No spread means no correlation is defined; dividing by it would be a zero.
    assert fit_joint("nfl", [(0.0, 1.0), (0.0, 2.0), (0.0, 3.0)]) is None


def test_a_thin_sample_is_fitted_but_flagged_unusable():
    model = fit_joint("ncaaf", [(-3.0, 4.0), (2.0, -1.0), (0.5, 2.0)])
    assert model is not None
    assert model.usable is False, "three games must never be stored as a model"


def test_correlation_stays_inside_its_range():
    model = fit_joint("nfl", [(-10.0, -20.0), (10.0, 20.0), (-10.0, -20.0), (10.0, 20.0)])
    assert -1.0 <= model.correlation <= 1.0
