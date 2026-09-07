"""Scoring alerts against what actually happened.

Every alert produced by ``signals.py`` states a side it expects the market to move
toward. This module answers two *separate* questions about that guess:

**Line value** — did the line keep moving our way between the alert and kickoff?
    Measurable with a single book, because it asks only about DraftKings' own line
    path. It is deliberately NOT called CLV: closing-line value compares against a
    sharp consensus we do not have. Line value is lower variance than results, so it
    becomes readable after tens of games rather than hundreds.

**Result** — did the predicted side actually cover?
    What you would have been paid on, and the thing people mean by "was it right".
    Very high variance; it means little until a large sample accumulates.

Keeping them apart matters. An alert can have excellent line value and lose, and over
a small sample that is the *expected* outcome rather than a contradiction.

Grading always uses the line available **at alert time**, since that is the number you
could actually have taken. Grading against the closing number would flatter every alert
by construction.
"""
from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

UTC = timezone.utc

PUSH = None  # a graded outcome of None means the bet pushed; it is not a loss


@dataclass(frozen=True)
class GameResult:
    event_id: str
    league: str
    home_score: int
    away_score: int
    went_overtime: bool
    completed: bool

    @property
    def margin(self) -> int:
        """Home margin. Negative when the away side won."""
        return self.home_score - self.away_score

    @property
    def total_points(self) -> int:
        return self.home_score + self.away_score


@dataclass
class Grade:
    grade_id: str
    alert_id: str
    graded_at: datetime
    rule_version_id: str
    market: str
    predicted_side: str
    move_strength: int
    line_at_alert: float | None
    price_at_alert: int | None
    closing_line: float | None
    closing_price: int | None
    line_value_points: float | None
    price_value_decimal: float | None
    line_value_won: bool | None
    result_covered: bool | None      # None means push
    result_push: bool


def american_to_decimal(price: int | None) -> float | None:
    """American odds to decimal (total return per unit staked, stake included)."""
    if price is None or abs(price) < 100:
        return None
    return 1.0 + (price / 100.0 if price > 0 else 100.0 / -price)


def implied_probability(price: int | None) -> float | None:
    """Break-even win probability implied by an American price, vig included.

    The right unit for comparing price moves. American odds are wildly non-linear and
    discontinuous at +/-100: -102 to +100 looks like a 202-cent jump but is a 0.5
    percentage-point move, while -110 to -102 looks like 8 cents and is nearly 2 points.
    Measuring in cents makes heavy favourites dominate every ranking for no reason.
    """
    decimal = american_to_decimal(price)
    return None if decimal is None else 1.0 / decimal


def line_value_points(market: str, predicted_side: str, alert_line: float | None,
                      closing_line: float | None) -> float | None:
    """Points of line value, quoted for the predicted side.

    Positive means the number available at alert time was better than the close, i.e.
    the market kept moving the way the alert said it would.

    Both lines must already be quoted **for the predicted side** — the caller reads
    them from the snapshot history rather than flipping signs, so that spread sign
    conventions are never inferred twice.
    """
    if alert_line is None or closing_line is None:
        return None
    if market == "spread":
        # A home handicap of +22.5 taken against a +20.5 close is 2 points of value.
        return round(alert_line - closing_line, 4)
    if market == "total":
        # Over wants the lower number; under wants the higher one.
        if predicted_side == "over":
            return round(closing_line - alert_line, 4)
        return round(alert_line - closing_line, 4)
    return None  # moneyline carries no handicap; price value covers it


def price_value_decimal(alert_price: int | None, closing_price: int | None) -> float | None:
    """Decimal-odds improvement. Positive means a better payout than the close."""
    taken, closed = american_to_decimal(alert_price), american_to_decimal(closing_price)
    if taken is None or closed is None:
        return None
    return round(taken - closed, 4)


def grade_spread(predicted_side: str, line: float, result: GameResult) -> bool | None:
    """``line`` is the handicap quoted for ``predicted_side``. None means a push."""
    margin = result.margin if predicted_side == "home" else -result.margin
    adjusted = margin + line
    if adjusted == 0:
        return PUSH
    return adjusted > 0


def grade_total(predicted_side: str, line: float, result: GameResult) -> bool | None:
    """Full-game totals include overtime at every mainstream book."""
    points = result.total_points
    if points == line:
        return PUSH
    return points > line if predicted_side == "over" else points < line


def grade_moneyline(predicted_side: str, result: GameResult) -> bool | None:
    if result.margin == 0:
        return PUSH  # NFL ties push the moneyline
    winner = "home" if result.margin > 0 else "away"
    return predicted_side == winner


def grade_outcome(market: str, predicted_side: str, line: float | None,
                  result: GameResult) -> bool | None:
    if market == "moneyline":
        return grade_moneyline(predicted_side, result)
    if line is None:
        return None
    if market == "spread":
        return grade_spread(predicted_side, line, result)
    if market == "total":
        return grade_total(predicted_side, line, result)
    return None


def grade_alert(alert, result: GameResult, closing_line: float | None,
                closing_price: int | None, now: datetime | None = None) -> Grade | None:
    """Score one alert. Returns None while the game is unfinished.

    ``alert`` is anything carrying the fields ``signals.Alert`` defines; ``closing_line``
    and ``closing_price`` must be quoted for ``alert.predicted_side``.
    """
    if not result.completed:
        return None

    covered = grade_outcome(alert.market, alert.predicted_side, alert.line_at_alert, result)
    points = line_value_points(alert.market, alert.predicted_side,
                               alert.line_at_alert, closing_line)
    price_value = price_value_decimal(alert.price_at_alert, closing_price)

    # Line value "won" if the number moved our way at all. For moneyline, where there is
    # no handicap, fall back to the price. Zero movement is not a win — a line that never
    # moved gave the alert no vindication either way.
    if points is not None:
        value_won = points > 0
    elif price_value is not None:
        value_won = price_value > 0
    else:
        value_won = None

    return Grade(
        grade_id=uuid.uuid4().hex,
        alert_id=alert.alert_id,
        graded_at=now or datetime.now(UTC),
        rule_version_id=alert.rule_version_id,
        market=alert.market,
        predicted_side=alert.predicted_side,
        move_strength=alert.move_strength,
        line_at_alert=alert.line_at_alert,
        price_at_alert=alert.price_at_alert,
        closing_line=closing_line,
        closing_price=closing_price,
        line_value_points=points,
        price_value_decimal=price_value,
        line_value_won=value_won,
        result_covered=covered,
        result_push=covered is PUSH,
    )
