"""Fit the residual-margin model per league and store it.

The residual is ``margin + home_spread``: the part of the result the market did not
already price in. Fitting that rather than the raw margin is the whole point —
raw college margins imply a +10.7 point home-field edge, which is not home advantage
but Power-conference teams hosting overmatched visitors.

Two things fall out, both usable before a single alert has been graded:

* **Dispersion and lumpiness.** How far results scatter around the line, and how much
  probability sits exactly on 3 and 7. That converts any spread into a win probability
  and gives honest push odds.
* **Market bias.** The residual mean is a direct measurement of whether the closing
  line is systematically off. It should be near zero; if it is not, that is a finding.
"""
from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path
from typing import Any

from db import Database, clean_database_url, insert_sql
from margins import MIN_GAMES, fit, key_number_mass
from odds_poller import DuckStore, utcnow
from schema import ensure_analytics_schema

LOG = logging.getLogger("fit_margins")

COLUMNS = ["league", "fitted_at", "games", "mean", "sd", "lo", "hi", "pmf_json",
           "buckets_json"]

#: Upper edges of the |home_spread| bands dispersion is measured in, in points.
#:
#: Chosen around the key numbers where football results actually cluster (3, 7, 10, 14)
#: and then widening, because big spreads are rarer and need broader bands to hold a
#: usable sample. The last band is open-ended.
BUCKET_EDGES = [3.0, 7.0, 10.0, 14.0, 21.0, 28.0, 35.0]

#: Below this a bucket's own dispersion is noise, and the league-wide figure is used.
#: The standard error of an sd is roughly sd/sqrt(2n), so 200 games gives about 5%.
MIN_BUCKET_GAMES = 200

RESIDUALS = """
SELECT r.league, (r.home_score - r.away_score) + l.home_spread AS residual,
       l.home_spread AS home_spread
  FROM game_results r
  JOIN historical_lines l USING (event_id)
 WHERE r.completed = TRUE AND l.home_spread IS NOT NULL
"""


def bucket_index(spread: float) -> int:
    """Which dispersion band a game belongs to, by how big the spread was."""
    size = abs(float(spread))
    for index, edge in enumerate(BUCKET_EDGES):
        if size < edge:
            return index
    return len(BUCKET_EDGES)


def bucket_bounds(index: int) -> tuple[float, float]:
    lo = 0.0 if index == 0 else BUCKET_EDGES[index - 1]
    hi = BUCKET_EDGES[index] if index < len(BUCKET_EDGES) else 999.0
    return lo, hi


def fit_buckets(rows: list[tuple[float, float]], league_sd: float) -> list[dict]:
    """Dispersion of the residual within each band of spread size.

    Only the standard deviation is applied downstream. The mean is measured and
    reported but deliberately not used: a per-bucket mean is a directional claim that
    big favourites beat or miss their number, and this project has already been caught
    once treating a small-sample tilt as forty separate opportunities. It is recorded
    here so the claim can be tested on its own terms, with its own standard error.
    """
    grouped: dict[int, list[float]] = {}
    for residual, spread in rows:
        grouped.setdefault(bucket_index(spread), []).append(residual)

    buckets = []
    for index in sorted(grouped):
        values = grouped[index]
        games = len(values)
        mean = sum(values) / games
        variance = sum((v - mean) ** 2 for v in values) / (games - 1) if games > 1 else 0.0
        sd = variance ** 0.5
        lo, hi = bucket_bounds(index)
        usable = games >= MIN_BUCKET_GAMES and sd > 0
        buckets.append({
            "lo": lo, "hi": hi, "games": games,
            "mean": round(mean, 4),
            # A thin bucket falls back to the league figure rather than publishing a
            # dispersion estimated from a handful of blowouts.
            "sd": round(sd if usable else league_sd, 4),
            "measured_sd": round(sd, 4),
            "usable": usable,
            # The mean against its own standard error, so "is this real" is answerable
            # from the stored row without refitting.
            "mean_se": round(sd / (games ** 0.5), 4) if games else None,
        })
    return buckets


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
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

        by_league: dict[str, list[float]] = {}
        with_spread: dict[str, list[tuple[float, float]]] = {}
        for league, residual, home_spread in database.fetchall(RESIDUALS):
            if residual is None:
                continue
            # Kept on the natural half-point grid; margins.fit does the bucketing.
            by_league.setdefault(league, []).append(float(residual))
            if home_spread is not None:
                with_spread.setdefault(league, []).append(
                    (float(residual), float(home_spread)))

        summary = {"type": "margin_fit", "leagues": {}}
        for league, residuals in sorted(by_league.items()):
            model = fit(league, residuals)
            buckets = fit_buckets(with_spread.get(league, []), model.sd)
            summary["leagues"][league] = {
                "games": model.games, "mean": model.mean, "sd": model.sd,
                "usable": model.usable, "min_required": MIN_GAMES,
                "key_numbers": key_number_mass(model),
                "buckets": buckets,
            }
            if not model.usable:
                LOG.warning("%s: %d games is below the %d needed; not stored.",
                            league, model.games, MIN_GAMES)
                continue

            database.execute("DELETE FROM margin_models WHERE league = ?", [league])
            database.execute(
                insert_sql("margin_models", COLUMNS),
                [league, utcnow(), model.games, model.mean, model.sd, model.lo,
                 model.hi, json.dumps({str(k): v for k, v in model.pmf.items()}),
                 json.dumps(buckets)],
            )

        database.commit()
        print(json.dumps(summary, default=str))
        return 0 if summary["leagues"] else 3
    except Exception as error:
        LOG.error("Fit failed (%s): %s", type(error).__name__, error)
        return 2
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
