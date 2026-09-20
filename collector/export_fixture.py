"""Export the local DuckDB into a JSON fixture the web app can develop against.

The app talks to Neon in production. Until that database exists, this dumps the exact
shapes its queries return so the whole UI can be built and verified against real
collected data rather than invented placeholders — mock data hides empty states, wrong
sort orders and missing-field bugs until they reach production.

Queries here are written to run unchanged on Postgres (window functions, no dialect
extensions), so the app's SQL and this export cannot drift apart.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

from db import Database

UTC = timezone.utc

# Latest quote per (event, market, side). Window function rather than DISTINCT ON so the
# identical statement runs on DuckDB and Postgres.
LATEST_QUOTES = """
WITH ranked AS (
    SELECT event_id, league, commence_time, home_team, away_team,
           home_team_id, away_team_id, market, side, line, price, observed_at,
           row_number() OVER (PARTITION BY event_id, market, side
                              ORDER BY observed_at DESC) AS rn
      FROM odds_snapshots
     WHERE observation_kind = 'pregame_observation'
)
SELECT event_id, league, commence_time, home_team, away_team,
       home_team_id, away_team_id, market, side, line, price, observed_at
  FROM ranked WHERE rn = 1
"""

HISTORY = """
SELECT event_id, market, side, line, price, observed_at
  FROM odds_snapshots
 WHERE observation_kind = 'pregame_observation'
 ORDER BY observed_at
"""

ALERTS = """
SELECT alert_id, created_at, league, event_id, market, side, kind,
       prev_line, new_line, prev_price, new_price, predicted_side,
       line_at_alert, price_at_alert, magnitude, move_strength, message,
       rule_version_id, home_team, away_team, commence_time
  FROM alerts
 ORDER BY move_strength DESC, created_at DESC
"""

GRADES = """
SELECT g.grade_id, g.alert_id, g.graded_at, g.rule_version_id, g.market,
       g.predicted_side, g.move_strength, g.line_value_points, g.line_value_won,
       g.result_covered, g.result_push, a.kind, a.league
  FROM alert_grades g JOIN alerts a USING (alert_id)
"""

ACTIVE_RULE = "SELECT rule_version_id FROM active_rule WHERE id = 1"

MARGIN_MODELS = """
SELECT league, games, mean, sd, lo, hi, pmf_json FROM margin_models
"""

SCORE_MODELS = """
SELECT league, games, total_mean, total_sd, margin_mean, margin_sd, correlation
  FROM score_models
"""

RESULTS = """
SELECT event_id, league, home_team, away_team, home_score, away_score,
       went_overtime, commence_time
  FROM game_results WHERE completed = TRUE
"""


def jsonable(value):
    if isinstance(value, datetime):
        return value.astimezone(UTC).isoformat()
    return value


def rows_to_dicts(database: Database, sql: str, columns: list[str]) -> list[dict]:
    return [{c: jsonable(v) for c, v in zip(columns, row)}
            for row in database.fetchall(sql)]


def build_board(quotes: list[dict]) -> list[dict]:
    """Fold per-side quote rows into one card per game."""
    games: dict[str, dict] = {}
    for quote in quotes:
        game = games.setdefault(quote["event_id"], {
            "eventId": quote["event_id"], "league": quote["league"],
            "commenceTime": quote["commence_time"], "homeTeam": quote["home_team"],
            "awayTeam": quote["away_team"],
            "homeTeamId": quote["home_team_id"], "awayTeamId": quote["away_team_id"],
            "lastObserved": quote["observed_at"],
            "spread": {}, "total": {}, "moneyline": {},
        })
        game[quote["market"]][quote["side"]] = {
            "line": quote["line"], "price": quote["price"],
        }
        game["lastObserved"] = max(game["lastObserved"], quote["observed_at"])
    return sorted(games.values(), key=lambda g: (g["commenceTime"], g["eventId"]))


def build_history(rows: list[dict]) -> dict[str, list[dict]]:
    history: dict[str, list[dict]] = {}
    for row in rows:
        history.setdefault(row["event_id"], []).append({
            "market": row["market"], "side": row["side"], "line": row["line"],
            "price": row["price"], "observedAt": row["observed_at"],
        })
    return history


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--db", type=Path, default=Path("data/dev.duckdb"))
    parser.add_argument("--out", type=Path, default=Path("web/fixtures/snapshot.json"))
    args = parser.parse_args(argv)

    if not args.db.exists():
        print(f"No database at {args.db}. Run the collector first.", file=sys.stderr)
        return 1

    import duckdb
    database = Database.duckdb(duckdb.connect(str(args.db), read_only=True))
    try:
        quotes = rows_to_dicts(database, LATEST_QUOTES, [
            "event_id", "league", "commence_time", "home_team", "away_team",
            "home_team_id", "away_team_id", "market", "side", "line", "price",
            "observed_at"])
        history_rows = rows_to_dicts(database, HISTORY, [
            "event_id", "market", "side", "line", "price", "observed_at"])
        alerts = rows_to_dicts(database, ALERTS, [
            "alert_id", "created_at", "league", "event_id", "market", "side", "kind",
            "prev_line", "new_line", "prev_price", "new_price", "predicted_side",
            "line_at_alert", "price_at_alert", "magnitude", "move_strength", "message",
            "rule_version_id", "home_team", "away_team", "commence_time"])
        grades = rows_to_dicts(database, GRADES, [
            "grade_id", "alert_id", "graded_at", "rule_version_id", "market",
            "predicted_side", "move_strength", "line_value_points", "line_value_won",
            "result_covered", "result_push", "kind", "league"])
        results = rows_to_dicts(database, RESULTS, [
            "event_id", "league", "home_team", "away_team", "home_score",
            "away_score", "went_overtime", "commence_time"])
        active = database.fetchone(ACTIVE_RULE)
        margin_models = {}
        for league, games, mean, sd, lo, hi, pmf_json in database.fetchall(MARGIN_MODELS):
            margin_models[league] = {
                "league": league, "games": games, "mean": mean, "sd": sd,
                "lo": lo, "hi": hi, "pmf": json.loads(pmf_json),
            }
        score_models = {}
        for (league, games, total_mean, total_sd, margin_mean, margin_sd,
             correlation) in database.fetchall(SCORE_MODELS):
            score_models[league] = {
                "league": league, "games": games,
                "totalMean": float(total_mean), "totalSd": float(total_sd),
                "marginMean": float(margin_mean), "marginSd": float(margin_sd),
                "correlation": float(correlation),
            }
    finally:
        database.close()

    payload = {
        "generatedAt": datetime.now(UTC).isoformat(),
        "activeRuleVersion": active[0] if active else None,
        "marginModels": margin_models,
        "scoreModels": score_models,
        "games": build_board(quotes),
        "history": build_history(history_rows),
        "alerts": alerts,
        "grades": grades,
        "results": results,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    print(json.dumps({
        "type": "export_summary", "out": str(args.out),
        "games": len(payload["games"]), "alerts": len(alerts),
        "grades": len(grades), "results": len(results),
        "margin_models": len(margin_models),
        "bytes": args.out.stat().st_size,
    }))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
