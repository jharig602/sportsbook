"""The loop: observations -> alerts -> grades -> calibration.

Runs after each collection. Every stage is idempotent, because the scheduler re-runs
this over overlapping history and a duplicate alert means a duplicate notification.

Ordering matters and is deliberate:

1. Detect alerts over the full snapshot history (cheap; deterministic ids dedupe).
2. Grade alerts whose games have finished, using the line available **at alert time**.
3. Refit calibration walk-forward, never on the games being scored.
"""
from __future__ import annotations

import argparse
import json
import logging
import time
import uuid
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Sequence

from calibration import DEFAULT_MIN_SAMPLES, baseline_rates, evaluate, fit, split_walk_forward
from db import Database, insert_sql
from grading import GameResult, grade_alert
from schema import ensure_analytics_schema
from signals import DEFAULT_CONFIG, Alert, Observation, RuleConfig, detect_all

LOG = logging.getLogger("pipeline")
UTC = timezone.utc

ALERT_COLUMNS = [
    "alert_id", "created_at", "league", "event_id", "market", "side", "kind",
    "prev_line", "new_line", "prev_price", "new_price", "predicted_side",
    "predicted_direction", "line_at_alert", "price_at_alert", "magnitude",
    "move_strength", "message", "rule_version_id", "home_team", "away_team",
    "commence_time", "notified_at",
]

GRADE_COLUMNS = [
    "grade_id", "alert_id", "graded_at", "rule_version_id", "market", "predicted_side",
    "move_strength", "line_at_alert", "price_at_alert", "closing_line", "closing_price",
    "line_value_points", "price_value_decimal", "line_value_won", "result_covered",
    "result_push",
]


# --- reading -------------------------------------------------------------------

def load_observations(database: Database, league: str | None = None) -> list[Observation]:
    """Every pregame priced snapshot, oldest first.

    Historical backfills are excluded: they carry a present-day observation timestamp
    for a past line, so letting them into a movement series would manufacture moves
    that never happened.
    """
    clause = "AND league = ?" if league else ""
    rows = database.fetchall(
        f"""SELECT observed_at, league, event_id, market, side, line, price,
                   commence_time, home_team, away_team
              FROM odds_snapshots
             WHERE observation_kind = 'pregame_observation' {clause}
             ORDER BY observed_at""",
        [league] if league else None,
    )
    return [Observation(*row) for row in rows]


def quote_at(database: Database, event_id: str, market: str, side: str,
             at: datetime) -> tuple[float | None, int | None] | None:
    """The quote for one side at an exact observation time."""
    row = database.fetchone(
        """SELECT line, price FROM odds_snapshots
            WHERE event_id = ? AND market = ? AND side = ? AND observed_at = ?
            LIMIT 1""",
        [event_id, market, side, at],
    )
    return (row[0], row[1]) if row else None


def closing_quote(database: Database, event_id: str, market: str,
                  side: str) -> tuple[float | None, int | None] | None:
    """Last pregame quote before kickoff.

    This is a *closing proxy*, not a verified close: it is simply the final number we
    happened to observe. Its distance from the true final market is unmeasured, which
    is why line value is reported as a movement statistic and never as CLV.
    """
    row = database.fetchone(
        """SELECT line, price FROM odds_snapshots
            WHERE event_id = ? AND market = ? AND side = ?
              AND observation_kind = 'pregame_observation'
              AND observed_at < commence_time
            ORDER BY observed_at DESC
            LIMIT 1""",
        [event_id, market, side],
    )
    return (row[0], row[1]) if row else None


def load_results(database: Database) -> dict[str, GameResult]:
    rows = database.fetchall(
        """SELECT event_id, league, home_score, away_score, went_overtime, completed
             FROM game_results WHERE completed = TRUE"""
    )
    return {row[0]: GameResult(*row) for row in rows}


def load_ungraded_alerts(database: Database) -> list[Alert]:
    rows = database.fetchall(
        f"""SELECT {','.join(ALERT_COLUMNS)} FROM alerts
             WHERE alert_id NOT IN (SELECT alert_id FROM alert_grades)"""
    )
    return [Alert(**dict(zip(ALERT_COLUMNS, row))) for row in rows]


# --- writing -------------------------------------------------------------------

def store_alerts(database: Database, alerts: Sequence[Alert]) -> int:
    """Insert only alerts we have not seen. Ids are deterministic, so re-detection of
    the same movement is a no-op rather than a second notification."""
    if not alerts:
        return 0
    known = {row[0] for row in database.fetchall("SELECT alert_id FROM alerts")}
    fresh = [a for a in alerts if a.alert_id not in known]
    if not fresh:
        return 0
    database.executemany(
        insert_sql("alerts", ALERT_COLUMNS),
        [[getattr(alert, column) for column in ALERT_COLUMNS] for alert in fresh],
    )
    return len(fresh)


def store_grades(database: Database, grades: Sequence) -> int:
    if not grades:
        return 0
    database.executemany(
        insert_sql("alert_grades", GRADE_COLUMNS),
        [[getattr(grade, column) for column in GRADE_COLUMNS] for grade in grades],
    )
    return len(grades)


def record_active_rule(database: Database, config: RuleConfig) -> str:
    """Stamp which rule version is currently in force.

    Retuning thresholds does not delete old alerts — they stay for audit — but the app
    must not mix analysis from superseded rules in with current output as though the two
    were equivalent. This single row is how the app knows which is which.
    """
    version = config.version_id()
    database.execute("DELETE FROM active_rule WHERE id = 1")
    database.execute(
        insert_sql("active_rule", ["id", "rule_version_id", "updated_at", "config_json"]),
        [1, version, datetime.now(UTC), json.dumps(asdict(config), sort_keys=True)],
    )
    return version


# --- stages --------------------------------------------------------------------

def detect_stage(database: Database, league: str | None,
                 config: RuleConfig = DEFAULT_CONFIG) -> tuple[int, int]:
    observations = load_observations(database, league)
    alerts = detect_all(observations, config)
    return len(alerts), store_alerts(database, alerts)


def grade_stage(database: Database) -> tuple[int, int]:
    """Grade every ungraded alert whose game has finished."""
    results = load_results(database)
    pending = load_ungraded_alerts(database)
    if not results:
        # Before any game has settled, every alert is waiting — not zero. Reporting 0
        # here would show "nothing awaiting results" on a fresh database, which is
        # exactly when someone is checking whether the loop is alive.
        return 0, len(pending)

    graded, skipped = [], 0
    for alert in pending:
        result = results.get(alert.event_id)
        if result is None:
            skipped += 1
            continue

        # Grade the side the alert actually predicted, which is not always the side the
        # series was keyed on. Read that side's quotes rather than flipping signs, so
        # the spread convention is never inferred a second time.
        at_alert = quote_at(database, alert.event_id, alert.market,
                            alert.predicted_side, alert.created_at)
        closing = closing_quote(database, alert.event_id, alert.market,
                                alert.predicted_side)
        if at_alert is not None:
            alert.line_at_alert, alert.price_at_alert = at_alert

        grade = grade_alert(alert, result,
                            closing[0] if closing else None,
                            closing[1] if closing else None)
        if grade is not None:
            graded.append(grade)

    return store_grades(database, graded), skipped


def calibrate_stage(database: Database, outcome: str = "line_value",
                    min_samples: int = DEFAULT_MIN_SAMPLES,
                    holdout_days: int = 7) -> dict:
    """Refit walk-forward and record the run.

    The most recent ``holdout_days`` are never fitted on — they are the evaluation set.
    Reporting a fit's performance on its own training games is the fastest way to
    believe a worthless rule works.
    """
    from grading import Grade

    rows = database.fetchall(f"SELECT {','.join(GRADE_COLUMNS)} FROM alert_grades")
    grades = [Grade(**dict(zip(GRADE_COLUMNS, row))) for row in rows]
    if not grades:
        return {"status": "no_grades", "usable": False}

    cutoff = max(g.graded_at for g in grades) - timedelta(days=holdout_days)
    train, test = split_walk_forward(grades, cutoff)
    calibration = fit(train, outcome=outcome, min_samples=min_samples,
                      fitted_through=cutoff)
    report = evaluate(calibration, test, outcome=outcome)
    baselines = baseline_rates(test, outcome=outcome)

    database.execute(
        insert_sql("calibration_runs",
                   ["calibration_id", "fitted_at", "fitted_through", "rule_version_id",
                    "outcome", "league", "kind", "min_samples", "buckets_json",
                    "evaluation_json", "baselines_json"]),
        [uuid.uuid4().hex, datetime.now(UTC), cutoff,
         train[0].rule_version_id if train else "none", outcome, None, None,
         min_samples, json.dumps(calibration.summary(), default=str),
         json.dumps(report, default=str), json.dumps(baselines, default=str)],
    )

    return {"status": "ok", "usable": calibration.is_usable,
            "n_train": len(train), "n_test": len(test),
            "buckets": calibration.summary(), "evaluation": report,
            "baselines": baselines}


# --- entry point ---------------------------------------------------------------

def run(database: Database, league: str | None = None,
        config: RuleConfig = DEFAULT_CONFIG) -> dict:
    ensure_analytics_schema(database.connection)
    record_active_rule(database, config)
    detected, stored = detect_stage(database, league, config)
    graded, ungradable = grade_stage(database)
    calibration = calibrate_stage(database)
    database.commit()
    return {
        "type": "pipeline_summary",
        "ran_at": datetime.now(UTC).isoformat(),
        "league": league or "all",
        "rule_version": config.version_id(),
        "alerts_detected": detected,
        "alerts_new": stored,
        "grades_written": graded,
        "alerts_awaiting_results": ungradable,
        "calibration": calibration,
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", choices=["ncaaf", "nfl"])
    parser.add_argument("--db", type=Path, default=Path("data/warehouse-v4.duckdb"))
    parser.add_argument("--postgres", action="store_true",
                        help="Read/write the Postgres URL in DATABASE_URL instead of --db. "
                             "Taken from the environment, never argv, so credentials stay "
                             "out of shell history, CI logs and process lists.")
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s")
    logging.Formatter.converter = time.gmtime

    database: Database | None = None
    try:
        if args.postgres:
            import os
            import psycopg
            database_url = os.environ.get("DATABASE_URL")
            if not database_url:
                parser.error("--postgres requires DATABASE_URL in the environment")
            database = Database.postgres(psycopg.connect(database_url))
        else:
            import duckdb
            database = Database.duckdb(duckdb.connect(str(args.db)))
        summary = run(database, args.league)
        print(json.dumps(summary, default=str))
        return 0
    except Exception as error:
        LOG.error("Pipeline failed (%s): %s", type(error).__name__, error)
        return 2
    finally:
        if database is not None:
            database.close()


if __name__ == "__main__":
    raise SystemExit(main())
