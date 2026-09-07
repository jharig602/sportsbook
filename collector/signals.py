"""Line-movement signal engine.

Turns the append-only ``odds_snapshots`` history into alerts. Every alert is written
as a *falsifiable prediction* — it records which side the movement points toward and
what the line was at the time — so that ``grading.py`` can later score whether the
guess was any good. An alert that cannot state what it expects is not an alert.

Two things this module deliberately does NOT do:

* It does not claim a bet is +EV. With a single book there is no price to arbitrage
  against and no validated model, so no expected value can be computed honestly.
* ``move_strength`` is NOT a win probability. It is a bounded 0-100 ordering device
  over how unusual an observed move is. It only becomes a probability after
  ``grading.py`` has calibrated it against enough settled games, and only for
  buckets that clear their baselines.
"""
from __future__ import annotations

import hashlib
import json
import math
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from typing import Iterable

from grading import implied_probability

UTC = timezone.utc

# Football key numbers, ordered by how much of the scoring distribution sits on them.
# Crossing 3 or 7 matters far more than crossing 14, so they carry more weight.
SPREAD_KEY_NUMBERS: dict[float, float] = {3.0: 1.0, 7.0: 0.85, 6.0: 0.5, 10.0: 0.45,
                                          14.0: 0.35, 4.0: 0.3}
TOTAL_KEY_NUMBERS: dict[float, float] = {41.0: 0.6, 44.0: 0.8, 47.0: 0.8, 51.0: 0.6,
                                         37.0: 0.4, 54.0: 0.4}

# Line-based rules run on one side only, so a single market move yields one alert.
LINE_CANONICAL_SIDE = {"spread": "home", "total": "over"}


@dataclass(frozen=True)
class RuleConfig:
    """Thresholds and scales. Any change produces a new ``rule_version`` id, so past
    alerts stay attributable to the exact rules that produced them."""

    steam_line_points: float = 1.5        # spread/total move since last poll
    steam_price_probability: float = 0.015  # implied-probability move since last poll
    drift_line_points: float = 3.0        # cumulative move since the line opened
    first_price_min_hours: float = 0.0    # ignore first prices closer than this to kickoff

    # Scales for the strength curve below. Roughly "the move size that reads as notable".
    steam_scale_points: float = 2.0
    steam_scale_probability: float = 0.03
    drift_scale_points: float = 4.0
    key_number_scale: float = 1.0
    first_price_scale_hours: float = 96.0

    def version_id(self) -> str:
        """Content hash. Retuning thresholds mints a new version rather than
        silently reinterpreting history."""
        payload = json.dumps(asdict(self), sort_keys=True).encode()
        return hashlib.sha256(payload).hexdigest()[:16]


DEFAULT_CONFIG = RuleConfig()


@dataclass(frozen=True)
class Observation:
    """One priced snapshot of one side of one market."""

    observed_at: datetime
    league: str
    event_id: str
    market: str          # spread | total | moneyline
    side: str            # home/away, or over/under
    line: float | None
    price: int | None
    commence_time: datetime
    home_team: str | None = None
    away_team: str | None = None


@dataclass
class Alert:
    alert_id: str
    created_at: datetime
    league: str
    event_id: str
    market: str
    side: str
    kind: str                     # key_number | steam | first_price | drift
    prev_line: float | None
    new_line: float | None
    prev_price: int | None
    new_price: int | None
    # --- the falsifiable part; grading.py reads these ---
    predicted_side: str
    predicted_direction: str      # toward_home | toward_away | toward_over | toward_under
    line_at_alert: float | None
    price_at_alert: int | None
    magnitude: float
    move_strength: int
    message: str
    rule_version_id: str
    home_team: str | None = None
    away_team: str | None = None
    commence_time: datetime | None = None
    notified_at: datetime | None = None


def alert_id_for(event_id: str, market: str, side: str, kind: str,
                 created_at: datetime, rule_version_id: str, magnitude: float) -> str:
    """Deterministic id from the natural key.

    Detection re-scans the whole history on every poll, so the same movement is found
    again every 30 minutes. A random id would insert a duplicate each time and spam the
    phone; deriving the id from what the alert *is* makes re-detection idempotent and
    lets the database reject repeats on the primary key.

    ``magnitude`` is part of the key so that one move crossing two key numbers produces
    two distinct alerts rather than colliding into one.
    """
    parts = (event_id, market, side, kind, created_at.isoformat(),
             rule_version_id, f"{magnitude:.4f}")
    return hashlib.sha256("|".join(parts).encode()).hexdigest()[:32]


def strength(magnitude: float, scale: float) -> int:
    """Bounded 0-100 ordering device.

    Saturating exponential: monotonic in magnitude, and needs no historical
    distribution to compute — which matters because on day one there is no history to
    compute one from. Capped at 99: rounding would otherwise let a large enough move
    display as 100, and nothing here is ever certain enough to earn that.
    """
    if scale <= 0 or magnitude <= 0:
        return 0
    return min(99, int(round(100 * (1 - math.exp(-magnitude / scale)))))


def _direction(market: str, side: str) -> str:
    if market == "total":
        return "toward_over" if side == "over" else "toward_under"
    return "toward_home" if side == "home" else "toward_away"


def _opposite(side: str) -> str:
    return {"home": "away", "away": "home", "over": "under", "under": "over"}[side]


def _favoured_side(market: str, side: str, delta: float) -> str:
    """Which side the market moved toward, given a move in ``side``'s own quote.

    Must be computed relative to the series being examined. Home +22.5 -> +20.5 and
    away -22.5 -> -20.5 are the *same* market move (the favourite is laying less, so
    money came in on home), but the deltas carry opposite signs. Keying off the sign
    alone made the two series disagree, mispredicting essentially every away-side spread.

    A shrinking handicap for ``side`` means ``side`` is being backed. For a total, a
    rising number means money on the over regardless of which side is quoted.
    """
    if market == "total":
        return "over" if delta > 0 else "under"
    return side if delta < 0 else _opposite(side)


def _favoured_side_by_price(side: str, previous: int, current: int) -> str | None:
    """Which side money moved to, judged by implied probability rather than cents.

    A price growing more expensive for ``side`` (implied probability rising) means
    money is coming in on ``side``.
    """
    before, after = implied_probability(previous), implied_probability(current)
    if before is None or after is None or after == before:
        return None
    return side if after > before else _opposite(side)


def _crossed_key_numbers(market: str, previous: float, current: float) -> list[tuple[float, float]]:
    """Key numbers strictly between the two lines, with their weights.

    Uses absolute values so a home ``-2.5 -> -3.5`` and an away ``+2.5 -> +3.5`` both
    register the same crossing of 3.
    """
    table = TOTAL_KEY_NUMBERS if market == "total" else SPREAD_KEY_NUMBERS
    low, high = sorted((abs(previous), abs(current)))
    return [(key, weight) for key, weight in table.items() if low < key < high]


def detect(history: Iterable[Observation], config: RuleConfig = DEFAULT_CONFIG) -> list[Alert]:
    """Detect alerts in one time-ordered series for a single (event, market, side).

    Pure and side-effect free so it can be tested without a database.
    """
    series = [o for o in sorted(history, key=lambda o: o.observed_at)]
    if not series:
        return []

    version = config.version_id()
    alerts: list[Alert] = []
    opening = series[0]

    def build(observation: Observation, kind: str, magnitude: float, scale: float,
              message: str, predicted: str, previous: Observation | None) -> Alert:
        return Alert(
            alert_id=alert_id_for(observation.event_id, observation.market,
                                  observation.side, kind, observation.observed_at,
                                  version, magnitude),
            created_at=observation.observed_at,
            league=observation.league,
            event_id=observation.event_id,
            market=observation.market,
            side=observation.side,
            kind=kind,
            prev_line=previous.line if previous else None,
            new_line=observation.line,
            prev_price=previous.price if previous else None,
            new_price=observation.price,
            predicted_side=predicted,
            predicted_direction=_direction(observation.market, predicted),
            line_at_alert=observation.line,
            price_at_alert=observation.price,
            magnitude=round(magnitude, 4),
            move_strength=strength(magnitude, scale),
            message=message,
            rule_version_id=version,
            home_team=observation.home_team,
            away_team=observation.away_team,
            commence_time=observation.commence_time,
        )

    # --- first_price: the softest number a book ever posts ------------------------
    # NCAAF lines appear late (6% priced 13 days out vs 59% at 6 days), so the first
    # posted price is both the earliest and the least-shopped number available.
    hours_out = (opening.commence_time - opening.observed_at).total_seconds() / 3600
    if opening.price is not None and hours_out >= config.first_price_min_hours:
        alerts.append(build(
            opening, "first_price", max(hours_out, 0.0), config.first_price_scale_hours,
            f"First price posted: {_format_line(opening)} ({hours_out:.0f}h to kickoff)",
            opening.side, None))

    # Both sides of a market carry the same handicap information — a spread's two lines
    # are exact opposites and a total's two sides share one number — so a line move seen
    # from each side would emit two cards describing one event. Line-based rules run only
    # on the canonical side; price rules still run per side, since prices genuinely differ.
    line_rules_apply = opening.side == LINE_CANONICAL_SIDE.get(opening.market)

    for previous, current in zip(series, series[1:]):
        # --- steam: a fast move since the previous poll --------------------------
        if line_rules_apply and previous.line is not None and current.line is not None:
            delta = current.line - previous.line
            if abs(delta) >= config.steam_line_points:
                favoured = _favoured_side(current.market, current.side, delta)
                alerts.append(build(
                    current, "steam", abs(delta), config.steam_scale_points,
                    f"Line moved {_number(current.market, previous.line)} to "
                    f"{_number(current.market, current.line)} "
                    f"({abs(delta):g} pts toward {favoured})",
                    favoured, previous))

            # --- key_number: crossing the numbers football actually lands on -----
            for key, weight in _crossed_key_numbers(current.market, previous.line, current.line):
                favoured = _favoured_side(current.market, current.side, delta)
                alerts.append(build(
                    current, "key_number", weight, config.key_number_scale,
                    f"Crossed {key:g}: {_number(current.market, previous.line)} to "
                    f"{_number(current.market, current.line)}",
                    favoured, previous))

        # --- steam on price, with the line unchanged ------------------------------
        if previous.price is not None and current.price is not None:
            before = implied_probability(previous.price)
            after = implied_probability(current.price)
            same_line = previous.line == current.line
            if same_line and before is not None and after is not None:
                shift = abs(after - before)
                favoured = _favoured_side_by_price(current.side, previous.price,
                                                   current.price)
                if shift >= config.steam_price_probability and favoured is not None:
                    alerts.append(build(
                        current, "steam", shift, config.steam_scale_probability,
                        f"Price moved {previous.price:+d} to {current.price:+d} "
                        f"({shift * 100:.1f} pts of implied probability toward {favoured})",
                        favoured, previous))

    # --- drift: total repricing since the line opened -----------------------------
    latest = series[-1]
    if (line_rules_apply and opening.line is not None and latest.line is not None
            and len(series) > 1):
        total_delta = latest.line - opening.line
        if abs(total_delta) >= config.drift_line_points:
            favoured = _favoured_side(latest.market, latest.side, total_delta)
            alerts.append(build(
                latest, "drift", abs(total_delta), config.drift_scale_points,
                f"Moved {abs(total_delta):g} pts since open "
                f"({opening.line:+g} to {latest.line:+g}) toward {favoured}",
                favoured, opening))

    return alerts


def _number(market: str, line: float) -> str:
    """Totals are magnitudes; only handicaps take a sign."""
    return f"{line:g}" if market == "total" else f"{line:+g}"


def _format_line(observation: Observation) -> str:
    parts = []
    if observation.line is not None:
        if observation.market == "total":
            # Totals are magnitudes, not handicaps: "o42.5" reads correctly where a
            # signed "+42.5" looks like a spread.
            parts.append(f"{observation.side[0]}{observation.line:g}")
        else:
            parts.append(f"{observation.line:+g}")
    if observation.price is not None:
        parts.append(f"{observation.price:+d}")
    return " ".join(parts) if parts else "unpriced"


def group_series(observations: Iterable[Observation]) -> dict[tuple[str, str, str], list[Observation]]:
    """Split a flat observation stream into per-(event, market, side) series."""
    grouped: dict[tuple[str, str, str], list[Observation]] = {}
    for observation in observations:
        key = (observation.event_id, observation.market, observation.side)
        grouped.setdefault(key, []).append(observation)
    return grouped


def detect_all(observations: Iterable[Observation],
               config: RuleConfig = DEFAULT_CONFIG) -> list[Alert]:
    """Run detection across every series in a flat observation stream."""
    alerts: list[Alert] = []
    for series in group_series(observations).values():
        alerts.extend(detect(series, config))
    alerts.sort(key=lambda a: (a.move_strength, a.created_at), reverse=True)
    return alerts


def collapse_for_display(alerts: Iterable[Alert]) -> list[Alert]:
    """Collapse alerts that say the same thing about the same market move.

    A two-sided market prices both sides, so one shift often shows up twice: the over
    growing more expensive and the under growing cheaper are the same money moving. Both
    observations are real and both are stored — but on a phone they are one card, and
    showing two makes a single move look like corroboration from two sources.

    Grouped by (event, market, kind, predicted side, time); the strongest survives.
    """
    best: dict[tuple, Alert] = {}
    for alert in alerts:
        key = (alert.event_id, alert.market, alert.kind,
               alert.predicted_side, alert.created_at)
        current = best.get(key)
        if current is None or alert.move_strength > current.move_strength:
            best[key] = alert
    return sorted(best.values(),
                  key=lambda a: (a.move_strength, a.created_at), reverse=True)
