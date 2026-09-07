"""Turning Move Strength into a probability — or refusing to.

``signals.move_strength`` is an ordering device, not a probability. This module is the
only thing allowed to promote it into one, and only once settled games justify it.

The discipline that makes automatic retuning trustworthy rather than self-flattering:

* **Walk-forward only.** Fit on games before a cutoff, evaluate on games after it.
  Refitting on everything and reporting the fit as performance is the single easiest
  way to convince yourself a worthless rule works.
* **Minimum sample gates.** A bucket under ``min_samples`` returns ``None``. The app
  must show "insufficient data", never a confident-looking number built on nine games.
* **Monotonicity.** A higher Move Strength may not map to a lower probability. Where
  raw bucket rates violate that, pool-adjacent-violators fixes it — noise in a small
  sample should not produce a non-monotonic curve the UI would present as a finding.
* **Baselines.** Every result is reported beside always-home, always-favourite and
  coin-flip. A rule that cannot beat those has not earned attention.

Nothing here assumes the alerts work. The expected finding, for a liquid market, is
that they do not — and this module is built to say so.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import datetime
from typing import Callable, Iterable, Sequence

# Below this many settled observations a bucket publishes no probability at all.
DEFAULT_MIN_SAMPLES = 50
DEFAULT_BUCKETS = 5
_EPSILON = 1e-15  # keeps log loss finite when a calibrated probability hits 0 or 1


@dataclass(frozen=True)
class Bucket:
    low: int
    high: int
    count: int
    hits: int
    pushes: int

    @property
    def rate(self) -> float | None:
        """Empirical hit rate, pushes excluded. None when nothing is decided."""
        decided = self.count - self.pushes
        return self.hits / decided if decided > 0 else None

    def sufficient(self, min_samples: int = DEFAULT_MIN_SAMPLES) -> bool:
        return (self.count - self.pushes) >= min_samples


@dataclass
class CalibrationMap:
    """Move Strength -> probability, with an explicit refusal when data is thin."""

    buckets: list[Bucket] = field(default_factory=list)
    probabilities: list[float | None] = field(default_factory=list)
    min_samples: int = DEFAULT_MIN_SAMPLES
    fitted_through: datetime | None = None
    outcome: str = "line_value"          # which axis this map was fitted on
    rule_version_id: str | None = None

    def probability(self, move_strength: int) -> float | None:
        """Calibrated probability, or None if this bucket has not earned one yet."""
        for bucket, probability in zip(self.buckets, self.probabilities):
            if bucket.low <= move_strength <= bucket.high:
                return probability
        return None

    @property
    def is_usable(self) -> bool:
        return any(p is not None for p in self.probabilities)

    def summary(self) -> list[dict]:
        return [
            {"range": f"{b.low}-{b.high}", "n": b.count, "pushes": b.pushes,
             "raw_rate": b.rate, "calibrated": p,
             "sufficient": b.sufficient(self.min_samples)}
            for b, p in zip(self.buckets, self.probabilities)
        ]


def _outcome_of(grade, outcome: str) -> bool | None:
    """Pull the graded axis off a Grade. None means push/ungradable and is excluded."""
    if outcome == "line_value":
        return grade.line_value_won
    if outcome == "result":
        return grade.result_covered
    raise ValueError(f"unknown outcome axis: {outcome!r}")


def build_buckets(grades: Iterable, outcome: str = "line_value",
                  bucket_count: int = DEFAULT_BUCKETS) -> list[Bucket]:
    """Split move_strength 0-99 into equal-width buckets and tally each."""
    width = 100 / bucket_count
    edges = [(int(i * width), int((i + 1) * width) - 1) for i in range(bucket_count)]
    tallies = {edge: [0, 0, 0] for edge in edges}   # count, hits, pushes

    for grade in grades:
        for edge in edges:
            if edge[0] <= grade.move_strength <= edge[1]:
                value = _outcome_of(grade, outcome)
                tallies[edge][0] += 1
                if value is None:
                    tallies[edge][2] += 1
                elif value:
                    tallies[edge][1] += 1
                break

    return [Bucket(low, high, *tallies[(low, high)]) for low, high in edges]


def pool_adjacent_violators(values: Sequence[float], weights: Sequence[float]) -> list[float]:
    """Least-squares isotonic (non-decreasing) regression.

    Small-sample noise routinely makes bucket 3 out-perform bucket 4. Presenting that
    as "medium alerts beat strong ones" would be reading noise as signal, so the curve
    is forced monotonic instead.
    """
    if not values:
        return []
    # Each block carries its pooled value, total weight, and how many buckets it spans,
    # so re-expansion afterwards is exact rather than reconstructed from the weights.
    blocks: list[list[float]] = [[float(v), float(w), 1] for v, w in zip(values, weights)]
    index = 0
    while index < len(blocks) - 1:
        if blocks[index][0] <= blocks[index + 1][0]:
            index += 1
            continue
        value_a, weight_a, span_a = blocks[index]
        value_b, weight_b, span_b = blocks[index + 1]
        total_weight = weight_a + weight_b
        pooled = ((value_a * weight_a + value_b * weight_b) / total_weight
                  if total_weight else value_a)
        blocks[index:index + 2] = [[pooled, total_weight, span_a + span_b]]
        index = max(index - 1, 0)

    expanded: list[float] = []
    for value, _weight, span in blocks:
        expanded.extend([value] * int(span))
    return expanded


def fit(grades: Iterable, outcome: str = "line_value",
        min_samples: int = DEFAULT_MIN_SAMPLES,
        bucket_count: int = DEFAULT_BUCKETS,
        fitted_through: datetime | None = None,
        rule_version_id: str | None = None) -> CalibrationMap:
    """Fit a calibration map. Thin buckets get None, not a guess."""
    buckets = build_buckets(grades, outcome, bucket_count)
    usable = [b for b in buckets if b.sufficient(min_samples) and b.rate is not None]

    probabilities: list[float | None] = [None] * len(buckets)
    if usable:
        smoothed = pool_adjacent_violators(
            [b.rate for b in usable],                       # type: ignore[misc]
            [float(b.count - b.pushes) for b in usable],
        )
        for bucket, probability in zip(usable, smoothed):
            probabilities[buckets.index(bucket)] = round(probability, 4)

    return CalibrationMap(buckets=buckets, probabilities=probabilities,
                          min_samples=min_samples, fitted_through=fitted_through,
                          outcome=outcome, rule_version_id=rule_version_id)


# --- scoring rules -------------------------------------------------------------

def brier_score(pairs: Iterable[tuple[float, bool]]) -> float | None:
    """Mean squared error of probabilistic forecasts. Lower is better; 0.25 is the
    score of always saying 50%."""
    items = list(pairs)
    if not items:
        return None
    return round(sum((p - float(o)) ** 2 for p, o in items) / len(items), 6)


def log_loss(pairs: Iterable[tuple[float, bool]]) -> float | None:
    items = list(pairs)
    if not items:
        return None
    total = 0.0
    for probability, outcome in items:
        clamped = min(max(probability, _EPSILON), 1 - _EPSILON)
        total += -math.log(clamped if outcome else 1 - clamped)
    return round(total / len(items), 6)


# --- walk-forward evaluation ---------------------------------------------------

def split_walk_forward(grades: Iterable, cutoff: datetime,
                       timestamp: Callable = lambda g: g.graded_at) -> tuple[list, list]:
    """Everything at or before ``cutoff`` trains; everything after is held out.

    The evaluation set must never touch the fit. This is the whole guardrail.
    """
    train, test = [], []
    for grade in grades:
        (train if timestamp(grade) <= cutoff else test).append(grade)
    return train, test


def evaluate(calibration: CalibrationMap, grades: Iterable,
             outcome: str = "line_value") -> dict:
    """Score a fitted map against games it has never seen."""
    pairs: list[tuple[float, bool]] = []
    skipped_no_probability = 0
    pushes = 0

    for grade in grades:
        value = _outcome_of(grade, outcome)
        if value is None:
            pushes += 1
            continue
        probability = calibration.probability(grade.move_strength)
        if probability is None:
            skipped_no_probability += 1
            continue
        pairs.append((probability, value))

    hits = sum(1 for _, outcome_value in pairs if outcome_value)
    return {
        "n_scored": len(pairs),
        "n_pushes": pushes,
        "n_uncalibrated": skipped_no_probability,
        "hit_rate": round(hits / len(pairs), 4) if pairs else None,
        "brier": brier_score(pairs),
        "log_loss": log_loss(pairs),
        "outcome": outcome,
    }


# --- baselines -----------------------------------------------------------------

def baseline_rates(grades: Iterable, outcome: str = "result") -> dict:
    """What the naive strategies scored on the same games.

    A rule that cannot clear these has not demonstrated anything, and the Track Record
    screen is required to show them side by side.
    """
    items = [g for g in grades if _outcome_of(g, outcome) is not None]
    if not items:
        return {"n": 0, "alerts": None, "always_home": None, "coin_flip": 0.5}

    decided = len(items)
    alerts_rate = sum(1 for g in items if _outcome_of(g, outcome)) / decided
    home_picks = [g for g in items if g.predicted_side == "home"]
    home_rate = (sum(1 for g in home_picks if _outcome_of(g, outcome)) / len(home_picks)
                 if home_picks else None)

    return {
        "n": decided,
        "alerts": round(alerts_rate, 4),
        "always_home": round(home_rate, 4) if home_rate is not None else None,
        "coin_flip": 0.5,
        "beats_coin_flip": alerts_rate > 0.5,
    }
