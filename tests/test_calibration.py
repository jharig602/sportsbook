"""Calibration tests.

The important assertions here are the refusals: thin data must produce None rather
than a number, and a fitted map must never be scored on the games it was fitted on.
Those are the two failure modes that would let a worthless rule look profitable.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from calibration import (Bucket, CalibrationMap, baseline_rates, brier_score,
                         build_buckets, evaluate, fit, log_loss,
                         pool_adjacent_violators, split_walk_forward)

UTC = timezone.utc
START = datetime(2026, 9, 1, tzinfo=UTC)


class FakeGrade:
    """Minimal stand-in carrying only the fields calibration reads."""

    def __init__(self, move_strength, line_value_won=True, result_covered=True,
                 days=0, predicted_side="home"):
        self.move_strength = move_strength
        self.line_value_won = line_value_won
        self.result_covered = result_covered
        self.graded_at = START + timedelta(days=days)
        self.predicted_side = predicted_side


def grades(strength, n, won=True, **kwargs):
    return [FakeGrade(strength, line_value_won=won, **kwargs) for _ in range(n)]


# --- the refusals --------------------------------------------------------------

def test_thin_bucket_publishes_no_probability():
    """Nine games must never produce a confident-looking number."""
    calibration = fit(grades(90, 9), min_samples=50)
    assert calibration.probability(90) is None
    assert calibration.is_usable is False


def test_bucket_at_the_threshold_publishes():
    calibration = fit(grades(90, 50), min_samples=50)
    assert calibration.probability(90) == pytest.approx(1.0)
    assert calibration.is_usable is True


def test_pushes_do_not_count_toward_the_sample_gate():
    """A push is not evidence. 60 grades of which 20 pushed is 40 decided, not 60."""
    sample = grades(90, 40) + [FakeGrade(90, line_value_won=None) for _ in range(20)]
    calibration = fit(sample, min_samples=50)
    assert calibration.probability(90) is None

    bucket = next(b for b in calibration.buckets if b.low <= 90 <= b.high)
    assert bucket.count == 60 and bucket.pushes == 20
    assert bucket.sufficient(min_samples=40) is True


def test_empty_input_is_not_usable():
    calibration = fit([])
    assert calibration.is_usable is False
    assert calibration.probability(50) is None


def test_unknown_outcome_axis_is_rejected():
    with pytest.raises(ValueError):
        fit(grades(50, 60), outcome="vibes")


# --- bucketing -----------------------------------------------------------------

def test_buckets_tile_the_whole_range_without_gaps():
    buckets = build_buckets([], bucket_count=5)
    assert [(b.low, b.high) for b in buckets] == [(0, 19), (20, 39), (40, 59),
                                                  (60, 79), (80, 99)]


def test_each_grade_lands_in_exactly_one_bucket():
    sample = [FakeGrade(s) for s in (0, 19, 20, 59, 60, 99)]
    buckets = build_buckets(sample, bucket_count=5)
    assert sum(b.count for b in buckets) == len(sample)


def test_bucket_rate_excludes_pushes():
    bucket = Bucket(low=0, high=19, count=10, hits=6, pushes=2)
    assert bucket.rate == pytest.approx(6 / 8)


def test_bucket_rate_is_none_when_everything_pushed():
    assert Bucket(0, 19, count=5, hits=0, pushes=5).rate is None


# --- monotonicity --------------------------------------------------------------

def test_pava_leaves_a_monotonic_sequence_alone():
    assert pool_adjacent_violators([0.4, 0.5, 0.6], [10, 10, 10]) == [0.4, 0.5, 0.6]


def test_pava_pools_a_violation():
    pooled = pool_adjacent_violators([0.6, 0.4], [10, 10])
    assert pooled == [pytest.approx(0.5), pytest.approx(0.5)]


def test_pava_preserves_length():
    for values in ([0.9, 0.1, 0.5], [0.5, 0.4, 0.3, 0.2], [0.1] * 6):
        weights = [10] * len(values)
        assert len(pool_adjacent_violators(values, weights)) == len(values)


def test_pava_weights_the_pooled_average():
    pooled = pool_adjacent_violators([0.8, 0.4], [30, 10])
    assert pooled[0] == pytest.approx(0.7)   # (0.8*30 + 0.4*10) / 40


def test_pava_result_is_non_decreasing():
    values = [0.9, 0.2, 0.7, 0.3, 0.8]
    pooled = pool_adjacent_violators(values, [10] * len(values))
    assert pooled == sorted(pooled)


def test_fitted_probabilities_never_decrease_with_strength():
    """Small-sample noise must not surface as 'medium alerts beat strong ones'."""
    sample = (grades(10, 60, won=True) +      # noisy: weak bucket over-performs
              grades(50, 60, won=False) +
              grades(90, 60, won=True))
    calibration = fit(sample, min_samples=50)
    published = [p for p in calibration.probabilities if p is not None]
    assert published == sorted(published)


def test_pava_on_empty_input():
    assert pool_adjacent_violators([], []) == []


# --- scoring rules -------------------------------------------------------------

def test_brier_rewards_confident_correctness():
    assert brier_score([(1.0, True)]) == 0.0
    assert brier_score([(0.5, True)]) == pytest.approx(0.25)
    assert brier_score([(0.0, True)]) == pytest.approx(1.0)


def test_brier_of_always_fifty_percent_is_a_quarter():
    pairs = [(0.5, True), (0.5, False), (0.5, True), (0.5, False)]
    assert brier_score(pairs) == pytest.approx(0.25)


def test_log_loss_stays_finite_at_the_extremes():
    """A calibrated 0 or 1 that turns out wrong must not produce infinity."""
    value = log_loss([(1.0, False)])
    assert value is not None and value > 0 and value < float("inf")


def test_scores_are_none_without_data():
    assert brier_score([]) is None
    assert log_loss([]) is None


# --- walk-forward --------------------------------------------------------------

def test_split_is_strict_about_the_cutoff():
    sample = [FakeGrade(50, days=d) for d in range(10)]
    train, test = split_walk_forward(sample, START + timedelta(days=4))
    assert len(train) == 5 and len(test) == 5
    assert all(g.graded_at <= START + timedelta(days=4) for g in train)
    assert all(g.graded_at > START + timedelta(days=4) for g in test)


def test_evaluation_ignores_buckets_with_no_calibration():
    """Held-out alerts in an uncalibrated bucket are counted, not silently scored."""
    calibration = fit(grades(90, 60), min_samples=50)
    held_out = grades(90, 10) + grades(10, 10)
    report = evaluate(calibration, held_out)
    assert report["n_scored"] == 10
    assert report["n_uncalibrated"] == 10


def test_evaluation_separates_pushes_from_losses():
    calibration = fit(grades(90, 60), min_samples=50)
    held_out = grades(90, 5) + [FakeGrade(90, line_value_won=None) for _ in range(3)]
    report = evaluate(calibration, held_out)
    assert report["n_scored"] == 5
    assert report["n_pushes"] == 3


def test_a_worthless_rule_scores_like_a_coin_flip():
    """The negative case has to work: a 50/50 rule must not look good."""
    sample = [FakeGrade(90, line_value_won=(i % 2 == 0), days=i) for i in range(120)]
    train, test = split_walk_forward(sample, START + timedelta(days=59))
    calibration = fit(train, min_samples=50)
    report = evaluate(calibration, test)
    assert report["hit_rate"] == pytest.approx(0.5, abs=0.05)
    assert report["brier"] == pytest.approx(0.25, abs=0.02)


def test_evaluation_of_an_unusable_map_scores_nothing():
    calibration = fit(grades(90, 5), min_samples=50)
    report = evaluate(calibration, grades(90, 10))
    assert report["n_scored"] == 0
    assert report["hit_rate"] is None


# --- baselines -----------------------------------------------------------------

def test_baselines_report_the_naive_comparison():
    sample = grades(90, 30, won=True) + grades(90, 70, won=False)
    report = baseline_rates(sample, outcome="line_value")
    assert report["n"] == 100
    assert report["alerts"] == pytest.approx(0.3)
    assert report["beats_coin_flip"] is False


def test_baselines_flag_a_rule_that_clears_the_coin_flip():
    sample = grades(90, 70, won=True) + grades(90, 30, won=False)
    report = baseline_rates(sample, outcome="line_value")
    assert report["beats_coin_flip"] is True


def test_baselines_on_empty_input():
    report = baseline_rates([], outcome="result")
    assert report["n"] == 0 and report["alerts"] is None


# --- provenance ----------------------------------------------------------------

def test_map_records_what_it_was_fitted_on():
    calibration = fit(grades(90, 60), min_samples=50,
                      fitted_through=START, rule_version_id="abc123")
    assert calibration.fitted_through == START
    assert calibration.rule_version_id == "abc123"
    assert calibration.outcome == "line_value"


def test_summary_exposes_sufficiency_per_bucket():
    calibration = fit(grades(90, 60) + grades(10, 5), min_samples=50)
    rows = {row["range"]: row for row in calibration.summary()}
    assert rows["80-99"]["sufficient"] is True
    assert rows["0-19"]["sufficient"] is False
    assert rows["0-19"]["calibrated"] is None
