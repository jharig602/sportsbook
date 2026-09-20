"""A power rating, and — first — the thing that decides whether it is worth having.

The rating itself is the easy half. Solve `margin = rating(home) - rating(away) + hfa`
across every game at once and strength of schedule falls out of the simultaneous solve;
it is not a separate adjustment, it is what solving simultaneously MEANS. Home field
comes out as a fitted coefficient rather than an assumption.

The hard half, and the reason the grader is written before anything is built on top of
it, is that a power rating always produces confident numbers whether or not it knows
anything. It will rank all 134 college teams to two decimal places on its first run with
no data worth the name. That is this project's recurring failure in its purest form: an
error that presents as a finding. So this module's product is not a ranking. It is an
out-of-sample answer to one question:

    When the rating disagrees with the closing line by more than X points, how often
    does the rating's side actually cover?

Two bars, and they answer different questions. **50%** asks whether the rating knows
anything at all. **52.38%** asks whether it is bettable at -110. A rating can clear the
first and fail the second, and that is the likeliest outcome -- the closing spread was
measured on these same seven seasons to be unbiased to within a third of a point, so it
is already an excellent power rating and the one to beat.

## What keeps this honest

**Walk-forward.** Ratings for a game come only from games that finished before the week
it was played. Fitting on a season and then testing on it would produce a spectacular
number describing nothing.

**No searching for a configuration.** The parameters in `DEFAULTS` were chosen before
the first run and are stated with their reasons. Picking the best cell of a grid and
reporting its p-value is how a rating that knows nothing gets published, so if these are
ever tuned, the tuning must be reported as a search with a family correction rather than
as a result. The disagreement thresholds ARE several looks at one dataset, so
`family_p()` corrects for them and is reported beside the cells.

**Blowouts are capped.** A 49-point win is not twice the evidence of a 25-point one; it
mostly means someone stopped trying. Standard practice, and the cap is a parameter so
its cost can be measured rather than argued about.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Sequence

from db import Database, clean_database_url
from odds_poller import DuckStore
from schema import ensure_analytics_schema

LOG = logging.getLogger("ratings")
UTC = timezone.utc

#: Chosen before the first run, with reasons, so that no result below is the survivor of
#: a search. Each is measured in `sensitivity()` rather than defended.
#:
#: ``ridge``      Shrinks every rating toward the league average. Without it the system
#:                is rank-deficient (ratings are identified only up to a constant) and a
#:                team with two games gets a rating built from two games.
#: ``cap``        Points of margin past which a game stops being more informative.
#: ``half_life``  Days after which a game counts half. A season is ~365 days, so last
#:                season carries half the weight of this one -- rosters turn over.
#: ``min_games``  Games that must already be fitted before the rating is allowed to have
#:                an opinion about anything.
#: ``min_team_games`` Prior appearances a team needs before its games join the fit.
DEFAULTS = {"ridge": 10.0, "cap": 28.0, "half_life": 365.0, "min_games": 200,
            "min_team_games": 0}

#: The same, with teams that barely appear excluded from the fit.
#:
#: Not a search for a better answer. The first run measured college home-field advantage
#: at **6.54 points**, roughly double any credible estimate, while the NFL came out at
#: **1.67** -- which is right. A parameter that is correct on clean data and absurd on
#: dirty data is pointing at the data.
#:
#: The cause is structural. College results include teams that appear a handful of times,
#: and those games are almost always played at the bigger school. The ridge pulls a team
#: with three games hard toward the league average, making it look far better than it is;
#: the margin it actually lost by has to go somewhere, and the only term left to absorb it
#: is home-field advantage. So HFA silently becomes "how much better the home team usually
#: is", and every prediction inherits that.
#:
#: Excluding teams the rating has barely seen is the fix, and it is a fix to the
#: specification rather than to the result -- it was chosen from a broken coefficient, not
#: from a p-value. Both specifications are reported.
RATED_ONLY = {**DEFAULTS, "min_team_games": 10}

#: What a -110 bet must win to break even. Not 50%: the vig is the whole difference
#: between "knows something" and "is worth betting".
BREAK_EVEN = 110 / 210

RESULTS = """
SELECT event_id, league, commence_time, home_team, away_team, home_score, away_score
  FROM game_results
 WHERE completed = TRUE
   AND home_team IS NOT NULL AND away_team IS NOT NULL
 ORDER BY commence_time
"""

CLOSING_LINES = """
SELECT event_id, home_spread FROM historical_lines WHERE home_spread IS NOT NULL
"""


@dataclass(frozen=True)
class Game:
    event_id: str
    league: str
    kickoff: datetime
    home: str
    away: str
    margin: float


@dataclass
class Ratings:
    ratings: dict[str, float]
    hfa: float
    games: int
    iterations: int

    def predicted_spread(self, home: str, away: str) -> float | None:
        """The home handicap this rating implies, in the market's convention.

        Negative when home is favoured, matching `historical_lines.home_spread`. Returns
        None when either team is unrated -- a team seen for the first time has no rating,
        and substituting the league average would quietly turn "no opinion" into an
        opinion of exactly zero, which is a different claim.
        """
        if home not in self.ratings or away not in self.ratings:
            return None
        return -(self.ratings[home] - self.ratings[away] + self.hfa)


def fit_ratings(
    games: Sequence[Game],
    *,
    asof: datetime | None = None,
    ridge: float = DEFAULTS["ridge"],
    cap: float | None = DEFAULTS["cap"],
    half_life: float | None = DEFAULTS["half_life"],
    tolerance: float = 1e-9,
    max_iterations: int = 500,
) -> Ratings | None:
    """Least squares with a ridge penalty, solved by conjugate gradient.

    The normal equations are symmetric and positive definite once the ridge term is
    present, so conjugate gradient converges to the exact solution rather than
    approaching it -- which matters because an iterative fit that merely got close would
    be indistinguishable, on screen, from one that converged.

    Nothing is materialised: the design matrix has one row per game with a +1, a -1 and
    a 1, so each product is a pass over the games. That is also why this needs no numpy.
    """
    if not games:
        return None
    teams = sorted({g.home for g in games} | {g.away for g in games})
    if not teams:
        return None
    index = {team: i for i, team in enumerate(teams)}
    n = len(teams) + 1  # the last unknown is home-field advantage
    hfa = n - 1

    rows: list[tuple[int, int, float, float]] = []
    for game in games:
        margin = game.margin
        if cap is not None:
            margin = max(-cap, min(cap, margin))
        weight = 1.0
        if half_life is not None and half_life > 0 and asof is not None:
            age = (asof - game.kickoff).total_seconds() / 86400.0
            # A game from the future carries full weight rather than more than full: the
            # caller is responsible for not passing one, and an exponent above 1 here
            # would silently let a leak weigh more than the honest data.
            weight = 0.5 ** (max(0.0, age) / half_life)
        rows.append((index[game.home], index[game.away], margin, weight))

    def multiply(vector: list[float]) -> list[float]:
        out = [0.0] * n
        for home_i, away_i, _, weight in rows:
            scaled = weight * (vector[home_i] - vector[away_i] + vector[hfa])
            out[home_i] += scaled
            out[away_i] -= scaled
            out[hfa] += scaled
        # The ridge penalises ratings only. Penalising home-field advantage would pull a
        # quantity we actually want measured toward zero for no reason.
        for i in range(n - 1):
            out[i] += ridge * vector[i]
        return out

    target = [0.0] * n
    for home_i, away_i, margin, weight in rows:
        target[home_i] += weight * margin
        target[away_i] -= weight * margin
        target[hfa] += weight * margin

    solution = [0.0] * n
    residual = list(target)
    direction = list(residual)
    rs_old = sum(r * r for r in residual)
    iterations = 0
    for iterations in range(1, max_iterations + 1):
        if rs_old <= tolerance:
            break
        product = multiply(direction)
        denominator = sum(d * p for d, p in zip(direction, product))
        if denominator <= 0:
            break
        step = rs_old / denominator
        for i in range(n):
            solution[i] += step * direction[i]
            residual[i] -= step * product[i]
        rs_new = sum(r * r for r in residual)
        beta = rs_new / rs_old
        for i in range(n):
            direction[i] = residual[i] + beta * direction[i]
        rs_old = rs_new

    return Ratings(
        ratings={team: solution[i] for team, i in index.items()},
        hfa=solution[hfa],
        games=len(games),
        iterations=iterations,
    )


def week_of(kickoff: datetime) -> tuple[int, int]:
    """The ISO week a game belongs to, used as the refit boundary.

    Refitting weekly rather than per game is both realistic -- it is when a bettor would
    actually recompute -- and enough: two games in one weekend cannot inform each other.
    """
    iso = kickoff.isocalendar()
    return (iso[0], iso[1])


@dataclass
class Prediction:
    event_id: str
    league: str
    kickoff: datetime
    closing_spread: float
    predicted_spread: float
    margin: float

    @property
    def disagreement(self) -> float:
        """How far the rating is from the close, in points. Signed toward home."""
        return self.closing_spread - self.predicted_spread

    @property
    def side(self) -> str:
        """The side the rating prefers at the closing number."""
        return "home" if self.disagreement > 0 else "away"

    @property
    def covered(self) -> bool | None:
        """Did the rating's side cover the CLOSING line. None on a push."""
        adjusted = self.margin + self.closing_spread
        if adjusted == 0:
            return None
        return adjusted > 0 if self.side == "home" else adjusted < 0


def walk_forward(
    games: Sequence[Game],
    lines: dict[str, float],
    **options: Any,
) -> list[Prediction]:
    """Predict every game from ratings fitted only on games that finished before it.

    The refit happens at each week boundary, and the games of that week are predicted
    from ratings that have never seen them. A rating fitted on a season and then tested
    on it would report something spectacular and describe nothing.
    """
    min_games = int(options.pop("min_games", DEFAULTS["min_games"]))
    min_team_games = int(options.pop("min_team_games", DEFAULTS["min_team_games"]))
    ordered = sorted(games, key=lambda g: g.kickoff)

    weeks: list[tuple[tuple[int, int], list[Game]]] = []
    for game in ordered:
        key = week_of(game.kickoff)
        if weeks and weeks[-1][0] == key:
            weeks[-1][1].append(game)
        else:
            weeks.append((key, [game]))

    predictions: list[Prediction] = []
    history: list[Game] = []
    for _, week_games in weeks:
        if len(history) >= min_games:
            asof = min(g.kickoff for g in week_games)
            model = fit_ratings(eligible(history, min_team_games), asof=asof, **options)
            if model is not None:
                for game in week_games:
                    spread = lines.get(game.event_id)
                    if spread is None:
                        continue
                    predicted = model.predicted_spread(game.home, game.away)
                    if predicted is None:
                        continue
                    predictions.append(Prediction(
                        event_id=game.event_id, league=game.league, kickoff=game.kickoff,
                        closing_spread=spread, predicted_spread=predicted,
                        margin=game.margin,
                    ))
        history.extend(week_games)
    return predictions


def eligible(history: Sequence[Game], min_team_games: int) -> list[Game]:
    """Games between teams the rating has actually seen enough of.

    A team that appears three times cannot be rated, and pretending otherwise does not
    merely produce one bad rating -- it pushes the error into home-field advantage, which
    then biases every prediction in the league. Dropping the game is the honest option;
    the alternative is a rating that quietly means something else.
    """
    if min_team_games <= 0:
        return list(history)
    seen: dict[str, int] = {}
    for game in history:
        seen[game.home] = seen.get(game.home, 0) + 1
        seen[game.away] = seen.get(game.away, 0) + 1
    return [
        g for g in history
        if seen.get(g.home, 0) >= min_team_games and seen.get(g.away, 0) >= min_team_games
    ]


def binomial_tail(hits: int, n: int, p: float) -> float:
    """P(at least `hits` successes in `n`) under `p`. Exact, in log space.

    Exact rather than normal-approximated because the interesting samples here are the
    small ones -- the whole point of a disagreement threshold is that raising it thins
    the sample -- and that is precisely where the approximation drifts.
    """
    if n <= 0:
        return 1.0
    if hits <= 0:
        return 1.0
    if p <= 0:
        return 0.0
    if p >= 1:
        return 1.0
    total = 0.0
    log_p, log_q = math.log(p), math.log1p(-p)
    for k in range(hits, n + 1):
        log_term = (
            math.lgamma(n + 1) - math.lgamma(k + 1) - math.lgamma(n - k + 1)
            + k * log_p + (n - k) * log_q
        )
        total += math.exp(log_term)
    return min(1.0, total)


@dataclass
class Cell:
    threshold: float
    n: int
    pushes: int
    covered: int
    cover_rate: float
    #: Against a coin flip: does the rating know anything.
    p_knows: float
    #: Against the vig: is it worth betting.
    p_beats_vig: float
    roi: float


def grade(predictions: Iterable[Prediction], thresholds: Sequence[float]) -> list[Cell]:
    """Cover rate by how far the rating disagrees with the close.

    Pushes leave the denominator rather than counting as half. A push returns the stake,
    so it is neither a win nor a loss, and splitting it would move the rate toward 50%
    for a reason that has nothing to do with the rating.
    """
    rows = list(predictions)
    cells: list[Cell] = []
    for threshold in thresholds:
        chosen = [p for p in rows if abs(p.disagreement) >= threshold]
        pushes = sum(1 for p in chosen if p.covered is None)
        decided = [p for p in chosen if p.covered is not None]
        n = len(decided)
        covered = sum(1 for p in decided if p.covered)
        rate = covered / n if n else 0.0
        cells.append(Cell(
            threshold=threshold, n=n, pushes=pushes, covered=covered,
            cover_rate=round(rate, 4),
            p_knows=round(binomial_tail(covered, n, 0.5), 5),
            p_beats_vig=round(binomial_tail(covered, n, BREAK_EVEN), 5),
            # At -110 a winner returns 100/110 and a loser costs 1.
            roi=round(rate * (100 / 110) - (1 - rate), 4) if n else 0.0,
        ))
    return cells


def family_p(cells: Sequence[Cell]) -> float:
    """How often the BEST of these cells looks this good when nothing works.

    Bonferroni, on the cell most favourable to the rating. Several thresholds are tried
    here, and reporting the winner's own p-value would be reporting the best of several
    draws as though it were the only one.
    """
    if not cells:
        return 1.0
    best = min(c.p_beats_vig for c in cells)
    return min(1.0, best * len(cells))


def load(database: Database) -> tuple[dict[str, list[Game]], dict[str, float]]:
    by_league: dict[str, list[Game]] = {}
    for event_id, league, kickoff, home, away, home_score, away_score in database.fetchall(RESULTS):
        when = kickoff if isinstance(kickoff, datetime) else datetime.fromisoformat(str(kickoff))
        if when.tzinfo is None:
            when = when.replace(tzinfo=UTC)
        by_league.setdefault(league, []).append(Game(
            event_id=event_id, league=league, kickoff=when,
            home=home, away=away, margin=float(home_score) - float(away_score),
        ))
    lines = {row[0]: float(row[1]) for row in database.fetchall(CLOSING_LINES)}
    return by_league, lines


THRESHOLDS = (0.0, 1.0, 1.5, 2.0, 3.0, 4.0)


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

        by_league, lines = load(database)
        summary: dict[str, Any] = {"type": "rating_grade", "break_even": round(BREAK_EVEN, 4),
                                   "defaults": DEFAULTS, "leagues": {}}
        for league, games in sorted(by_league.items()):
            runs: dict[str, Any] = {}
            for name, options in (("all_games", DEFAULTS), ("rated_only", RATED_ONLY)):
                predictions = walk_forward(games, lines, **options)
                if not predictions:
                    LOG.warning("%s/%s: nothing predictable out of sample.", league, name)
                    continue
                cells = grade(predictions, THRESHOLDS)
                fit_options = {k: v for k, v in options.items() if k != "min_games"}
                min_team = int(fit_options.pop("min_team_games", 0))
                final = fit_ratings(
                    eligible(games, min_team),
                    asof=max(g.kickoff for g in games),
                    **fit_options,
                )
                top = sorted(final.ratings.items(), key=lambda kv: -kv[1])[:5] if final else []
                runs[name] = {
                    "predicted": len(predictions),
                    "teams_rated": len(final.ratings) if final else 0,
                    "hfa_points": round(final.hfa, 3) if final else None,
                    "cells": [vars(c) for c in cells],
                    # Six thresholds are six looks at one dataset; the winner's own
                    # p-value would be the best of six reported as though it were the only.
                    "family_p": round(family_p(cells), 5),
                    "family_p_knows": round(
                        min(1.0, min(c.p_knows for c in cells) * len(cells)), 5),
                    "top5": [{"team": t, "rating": round(r, 2)} for t, r in top],
                }
            if not runs:
                continue
            summary["leagues"][league] = {"games": len(games), "runs": runs}
        print(json.dumps(summary))
        return 0 if summary["leagues"] else 3
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
