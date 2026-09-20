"""Fit how the final score scatters around what the market priced, per league.

``fit_margins`` already fits one half: the margin residual, ``margin + home_spread``.
This fits the other half -- the total residual, ``points - total`` -- and the number
neither can hold alone: how the two move together.

That correlation is the point. A same-game parlay is two legs decided by one scoreline,
so multiplying their separate probabilities is wrong in a direction that depends on the
legs. "Home wins AND the game goes over" is not the product of its parts if favourites
winning big also puts points on the board. With margin and total fitted jointly, any leg
that resolves off the final score -- moneyline, spread, game total, team total -- gets a
joint probability instead of a guess.

Team totals come free: home points are ``(total + margin) / 2`` and away points
``(total - margin) / 2``, so a bet on either is a line through the same two numbers.

Player props are not here and cannot be. Nothing in this database holds a player line,
so a parlay touching one has to be refused rather than estimated.
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from db import Database, clean_database_url, insert_sql
from margins import MIN_GAMES
from odds_poller import DuckStore, utcnow
from schema import ensure_analytics_schema

LOG = logging.getLogger("fit_scores")

COLUMNS = [
    "league", "fitted_at", "games", "total_mean", "total_sd",
    "margin_mean", "margin_sd", "correlation",
]

#: Both residuals for every completed game the historical pull priced.
#:
#: Inner join on purpose: a game with a spread but no total cannot contribute to a
#: correlation, and filling the gap with a league average would invent agreement between
#: two numbers that were never observed together.
RESIDUALS = """
SELECT r.league,
       (r.home_score - r.away_score) + l.home_spread AS margin_residual,
       (r.home_score + r.away_score) - l.total       AS total_residual
  FROM game_results r
  JOIN historical_lines l USING (event_id)
 WHERE r.completed = TRUE
   AND l.home_spread IS NOT NULL
   AND l.total IS NOT NULL
"""


@dataclass(frozen=True)
class JointFit:
    league: str
    games: int
    margin_mean: float
    margin_sd: float
    total_mean: float
    total_sd: float
    correlation: float

    @property
    def usable(self) -> bool:
        return self.games >= MIN_GAMES and self.margin_sd > 0 and self.total_sd > 0


def fit_joint(league: str, pairs: Sequence[tuple[float, float]]) -> JointFit | None:
    """Means, spreads and the correlation between the two residuals.

    Returns None when there is nothing to fit rather than a model of zeros: a stored row
    reading sd 0 and correlation 0 would price every same-game parlay as if the two legs
    were independent and certain, which is exactly the confident-looking wrong answer
    this project keeps having to delete.

    Sample standard deviations (n-1), because these are estimates from a sample and the
    population divisor understates the spread on the smaller leagues.
    """
    n = len(pairs)
    if n < 2:
        return None
    margins = [float(m) for m, _ in pairs]
    totals = [float(t) for _, t in pairs]
    margin_mean = sum(margins) / n
    total_mean = sum(totals) / n

    margin_var = sum((m - margin_mean) ** 2 for m in margins) / (n - 1)
    total_var = sum((t - total_mean) ** 2 for t in totals) / (n - 1)
    margin_sd = margin_var ** 0.5
    total_sd = total_var ** 0.5
    if margin_sd <= 0 or total_sd <= 0:
        return None

    covariance = sum(
        (m - margin_mean) * (t - total_mean) for m, t in zip(margins, totals)
    ) / (n - 1)
    correlation = covariance / (margin_sd * total_sd)
    # Clamped only against floating-point overshoot, never against a real value.
    correlation = max(-1.0, min(1.0, correlation))

    return JointFit(
        league=league,
        games=n,
        margin_mean=round(margin_mean, 4),
        margin_sd=round(margin_sd, 4),
        total_mean=round(total_mean, 4),
        total_sd=round(total_sd, 4),
        correlation=round(correlation, 5),
    )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--db", type=Path, default=Path("data/dev.duckdb"))
    parser.add_argument("--postgres", action="store_true")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s")
    logging.Formatter.converter = time.gmtime

    store: Any = None
    try:
        if args.postgres:
            import os
            from pg_store import PostgresStore
            store = PostgresStore(clean_database_url(os.environ.get("DATABASE_URL")))
            database = Database.postgres(store.con)
        else:
            store = DuckStore(args.db)
            database = Database.duckdb(store.con)
        ensure_analytics_schema(database)

        by_league: dict[str, list[tuple[float, float]]] = {}
        for league, margin_residual, total_residual in database.fetchall(RESIDUALS):
            if margin_residual is None or total_residual is None:
                continue
            by_league.setdefault(league, []).append(
                (float(margin_residual), float(total_residual))
            )

        summary: dict[str, Any] = {"type": "score_fit", "leagues": {}}
        for league, pairs in sorted(by_league.items()):
            model = fit_joint(league, pairs)
            if model is None:
                LOG.warning("%s: nothing fittable.", league)
                continue
            summary["leagues"][league] = {
                "games": model.games,
                "margin_mean": model.margin_mean, "margin_sd": model.margin_sd,
                "total_mean": model.total_mean, "total_sd": model.total_sd,
                "correlation": model.correlation, "usable": model.usable,
                "min_required": MIN_GAMES,
            }
            if not model.usable:
                LOG.warning("%s: %d games is below the %d needed; not stored.",
                            league, model.games, MIN_GAMES)
                continue
            database.execute("DELETE FROM score_models WHERE league = ?", [league])
            database.execute(
                insert_sql("score_models", COLUMNS),
                [league, utcnow(), model.games, model.total_mean, model.total_sd,
                 model.margin_mean, model.margin_sd, model.correlation],
            )
        database.commit()
        print(json.dumps(summary))
        return 0 if summary["leagues"] else 3
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
