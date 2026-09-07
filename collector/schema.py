"""Analytics tables: results, alerts, grades, calibration, push subscriptions.

Kept in a separate namespace from ``odds_poller``'s collection schema, with its own
version row. The collector's raw/snapshot tables are the audited core and should not
have to change version every time an analytics table is added — and vice versa, so a
calibration change can never invalidate a database full of collected prices.

DDL is written to the intersection of DuckDB and Postgres syntax (``DOUBLE PRECISION``
rather than ``DOUBLE``, no dialect-specific defaults) so local development and Neon
run the same statements.
"""
from __future__ import annotations

ANALYTICS_SCHEMA_VERSION = 1

ANALYTICS_DDL = """
CREATE TABLE IF NOT EXISTS analytics_meta (version INTEGER PRIMARY KEY);

CREATE TABLE IF NOT EXISTS game_results (
    event_id VARCHAR PRIMARY KEY,
    league VARCHAR NOT NULL,
    commence_time TIMESTAMPTZ NOT NULL,
    home_team_id VARCHAR, away_team_id VARCHAR,
    home_team VARCHAR, away_team VARCHAR,
    home_score INTEGER NOT NULL,
    away_score INTEGER NOT NULL,
    periods INTEGER,
    went_overtime BOOLEAN NOT NULL,
    status VARCHAR NOT NULL,
    completed BOOLEAN NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    run_id VARCHAR NOT NULL,
    response_id VARCHAR NOT NULL,
    CHECK (home_score >= 0 AND away_score >= 0)
);

CREATE TABLE IF NOT EXISTS alerts (
    alert_id VARCHAR PRIMARY KEY,
    created_at TIMESTAMPTZ NOT NULL,
    league VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    market VARCHAR NOT NULL,
    side VARCHAR NOT NULL,
    kind VARCHAR NOT NULL,
    prev_line DOUBLE PRECISION, new_line DOUBLE PRECISION,
    prev_price BIGINT, new_price BIGINT,
    predicted_side VARCHAR NOT NULL,
    predicted_direction VARCHAR NOT NULL,
    line_at_alert DOUBLE PRECISION,
    price_at_alert BIGINT,
    magnitude DOUBLE PRECISION NOT NULL,
    move_strength INTEGER NOT NULL,
    message VARCHAR NOT NULL,
    rule_version_id VARCHAR NOT NULL,
    home_team VARCHAR, away_team VARCHAR,
    commence_time TIMESTAMPTZ,
    notified_at TIMESTAMPTZ,
    -- move_strength is an ordering device, never a probability, and never certainty.
    CHECK (move_strength >= 0 AND move_strength <= 99),
    CHECK (kind IN ('key_number', 'steam', 'first_price', 'drift')),
    CHECK (predicted_side IN ('home', 'away', 'over', 'under'))
);

CREATE TABLE IF NOT EXISTS alert_grades (
    grade_id VARCHAR PRIMARY KEY,
    alert_id VARCHAR NOT NULL UNIQUE,
    graded_at TIMESTAMPTZ NOT NULL,
    rule_version_id VARCHAR NOT NULL,
    market VARCHAR NOT NULL,
    predicted_side VARCHAR NOT NULL,
    move_strength INTEGER NOT NULL,
    line_at_alert DOUBLE PRECISION, price_at_alert BIGINT,
    closing_line DOUBLE PRECISION, closing_price BIGINT,
    line_value_points DOUBLE PRECISION,
    price_value_decimal DOUBLE PRECISION,
    line_value_won BOOLEAN,
    result_covered BOOLEAN,
    result_push BOOLEAN NOT NULL
);

-- Which rule version is currently in force. Alerts are never deleted when thresholds
-- change — they stay for audit — but the app must not display analysis produced by
-- superseded rules alongside current ones as though they were equivalent.
CREATE TABLE IF NOT EXISTS active_rule (
    id INTEGER PRIMARY KEY,
    rule_version_id VARCHAR NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL,
    config_json VARCHAR NOT NULL
);

CREATE TABLE IF NOT EXISTS calibration_runs (
    calibration_id VARCHAR PRIMARY KEY,
    fitted_at TIMESTAMPTZ NOT NULL,
    fitted_through TIMESTAMPTZ NOT NULL,
    rule_version_id VARCHAR NOT NULL,
    outcome VARCHAR NOT NULL,
    league VARCHAR,
    kind VARCHAR,
    min_samples INTEGER NOT NULL,
    buckets_json VARCHAR NOT NULL,
    evaluation_json VARCHAR,
    baselines_json VARCHAR
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
    endpoint VARCHAR PRIMARY KEY,
    p256dh VARCHAR NOT NULL,
    auth VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    user_agent VARCHAR,
    muted_kinds VARCHAR,
    quiet_hours VARCHAR,
    last_success_at TIMESTAMPTZ,
    failure_count INTEGER NOT NULL
);
"""


def ensure_analytics_schema(connection) -> None:
    """Create the analytics tables if absent and record the version.

    Refuses to run against a newer analytics schema rather than writing rows a later
    version would misread.
    """
    connection.execute(ANALYTICS_DDL)
    rows = connection.execute("SELECT version FROM analytics_meta").fetchall()
    if not rows:
        connection.execute("INSERT INTO analytics_meta VALUES (?)",
                           [ANALYTICS_SCHEMA_VERSION])
        return
    existing = rows[0][0]
    if existing > ANALYTICS_SCHEMA_VERSION:
        raise ValueError(
            f"Database analytics schema is v{existing}, newer than this code "
            f"(v{ANALYTICS_SCHEMA_VERSION}). Upgrade the code rather than downgrading data."
        )
