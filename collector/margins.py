"""Converting a spread into a win/cover probability, from real score margins.

A spread is not a forecast you can read a probability off directly — the book sets it
so both sides are near coin-flips. What *is* recoverable is the distribution of final
margins, and with that you can answer two useful questions:

* What does a given spread imply about the moneyline?
* What does a given moneyline imply about the spread?

When those two disagree on the same game, one side of that book's own board is
mispriced relative to the other. That is a real, checkable signal that needs no
forward data — only history, which is why this is fitted from completed seasons.

Football margins are emphatically not normal. Scoring comes in 3s and 7s, so the
distribution has hard spikes at 3, 7, 10 and 14, and those spikes are exactly what
decides pushes and one-point cover swings. The empirical distribution is used where
there is data and a normal is used only in the sparse tails.
"""
from __future__ import annotations

import json
import math
from dataclasses import asdict, dataclass, field
from typing import Iterable, Sequence

# Below this many games a league's fit is not published; the caller falls back to the
# market's own implied probability rather than to a number invented from a thin sample.
MIN_GAMES = 200


@dataclass
class MarginModel:
    """Empirical distribution of the residual: (home margin) + (home closing spread).

    The pmf is keyed in **half-point units** (key = residual x 2), because most spreads
    are half-points and rounding residuals to whole numbers destroys the thing that
    matters most: a half-point line can never push, and the mass really sitting on 3
    gets smeared onto 4 instead. Half-points are the natural grid for both.
    """

    league: str
    games: int
    mean: float                      # positive = home-field advantage, in points
    sd: float
    # P(margin == k) for every observed k, as a share of games.
    pmf: dict[int, float] = field(default_factory=dict)
    lo: int = 0
    hi: int = 0

    @property
    def usable(self) -> bool:
        return self.games >= MIN_GAMES and self.sd > 0

    @staticmethod
    def _key(points: float) -> int:
        """Points -> half-point pmf key."""
        return int(round(points * 2))

    def _tails(self) -> tuple[float, float, float]:
        """(low tail, high tail, interior scale).

        The fitted pmf already sums to 1 over the observed range, so adding a normal
        tail on top of it double-counts and pushes total probability past 1 — which
        showed up as a pick'em reading 57% instead of 50%. The body is scaled down to
        leave room for the tails instead, so the three pieces sum to exactly 1.
        """
        high = 1.0 - _normal_cdf((self.hi + 0.25 - self.mean) / self.sd)
        low = _normal_cdf((self.lo - 0.25 - self.mean) / self.sd)
        return low, high, max(0.0, 1.0 - low - high)

    def probability_of(self, residual: float) -> float:
        """P(residual is exactly this), on the same scale as probability_above.

        Only lands on the half-point grid; anything off it has zero mass, which is
        exactly why a half-point spread cannot push.
        """
        if not self.usable or not self.lo <= residual <= self.hi:
            return 0.0
        if abs(residual * 2 - round(residual * 2)) > 1e-9:
            return 0.0
        return self.pmf.get(self._key(residual), 0.0) * self._tails()[2]

    def probability_above(self, threshold: float) -> float:
        """P(margin > threshold): empirical body, normal tails beyond the observed range."""
        if not self.usable:
            return float("nan")

        if threshold >= self.hi or threshold < self.lo:
            return max(0.0, min(1.0, 1.0 - _normal_cdf((threshold - self.mean) / self.sd)))

        _low, high, interior = self._tails()
        cutoff = threshold * 2
        inside = sum(p for key, p in self.pmf.items() if key > cutoff)
        return max(0.0, min(1.0, inside * interior + high))

    def cover_probability(self) -> tuple[float, float]:
        """(P(the side covers), P(push)).

        Covering *is* the residual being positive, by definition, so this takes no
        spread argument — the spread is already inside the residual. Pushing is the
        residual landing exactly on zero, which only a whole-number line allows.
        """
        return self.probability_above(0.0), self.probability_of(0.0)

    def win_probability(self, home_spread: float) -> float:
        """P(home wins outright), for comparing a spread against the moneyline.

        Since residual = margin + spread, winning outright (margin > 0) is the same as
        the residual exceeding the spread — so the threshold is the spread itself, not
        zero. Reading it as zero made every spread produce the same answer.

        Ties are excluded rather than split: an NFL tie is a moneyline push, not half
        a win, and college football has no ties at all.
        """
        if not self.usable:
            return float("nan")
        above = self.probability_above(home_spread)
        tie = (self.probability_of(int(home_spread))
               if float(home_spread).is_integer() else 0.0)
        denominator = 1.0 - tie
        return above / denominator if denominator > 0 else float("nan")

    def to_json(self) -> str:
        payload = asdict(self)
        payload["pmf"] = {str(k): v for k, v in self.pmf.items()}
        return json.dumps(payload)


def _normal_cdf(z: float) -> float:
    return 0.5 * (1.0 + math.erf(z / math.sqrt(2.0)))


def fit(league: str, residuals: Sequence[float]) -> MarginModel:
    """Fit from completed games. Values are (home margin) + (home closing spread)."""
    values = [round(float(r) * 2) / 2 for r in residuals]
    count = len(values)
    if count == 0:
        return MarginModel(league=league, games=0, mean=0.0, sd=0.0)

    mean = sum(values) / count
    variance = sum((v - mean) ** 2 for v in values) / max(1, count - 1)
    sd = math.sqrt(variance)

    pmf: dict[int, float] = {}
    for value in values:
        key = int(round(value * 2))
        pmf[key] = pmf.get(key, 0.0) + 1.0 / count

    return MarginModel(
        league=league,
        games=count,
        mean=round(mean, 4),
        sd=round(sd, 4),
        pmf={k: round(v, 8) for k, v in sorted(pmf.items())},
        lo=min(values),
        hi=max(values),
    )


def key_number_mass(model: MarginModel, keys: Iterable[int] = (3, 7, 10, 14, 6, 4)) -> dict[int, float]:
    """How much probability sits exactly on each key number, both signs.

    Measured on residuals, so this answers "how often does a game land exactly N points
    off the closing line" — which is what decides pushes and one-point cover swings.
    """
    return {
        key: round(model.probability_of(float(key)) + model.probability_of(float(-key)), 5)
        for key in keys
    }
