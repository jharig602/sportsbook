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

COLUMNS = ["league", "fitted_at", "games", "mean", "sd", "lo", "hi", "pmf_json"]

RESIDUALS = """
SELECT r.league, (r.home_score - r.away_score) + l.home_spread AS residual
  FROM game_results r
  JOIN historical_lines l USING (event_id)
 WHERE r.completed = TRUE AND l.home_spread IS NOT NULL
"""


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

        by_league: dict[str, list[int]] = {}
        for league, residual in database.fetchall(RESIDUALS):
            if residual is None:
                continue
            # Kept on the natural half-point grid; margins.fit does the bucketing.
            by_league.setdefault(league, []).append(float(residual))

        summary = {"type": "margin_fit", "leagues": {}}
        for league, residuals in sorted(by_league.items()):
            model = fit(league, residuals)
            summary["leagues"][league] = {
                "games": model.games, "mean": model.mean, "sd": model.sd,
                "usable": model.usable, "min_required": MIN_GAMES,
                "key_numbers": key_number_mass(model),
            }
            if not model.usable:
                LOG.warning("%s: %d games is below the %d needed; not stored.",
                            league, model.games, MIN_GAMES)
                continue

            database.execute("DELETE FROM margin_models WHERE league = ?", [league])
            database.execute(
                insert_sql("margin_models", COLUMNS),
                [league, utcnow(), model.games, model.mean, model.sd, model.lo,
                 model.hi, json.dumps({str(k): v for k, v in model.pmf.items()})],
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
