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

ANALYTICS_SCHEMA_VERSION = 8

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

-- Closing spread/total for completed games, used to fit the margin model.
-- Kept apart from odds_snapshots because these are a one-off historical pull with a
-- present-day observation time, not forward observations, and must never be mistaken
-- for line movement.
CREATE TABLE IF NOT EXISTS historical_lines (
    event_id VARCHAR PRIMARY KEY,
    league VARCHAR NOT NULL,
    provider VARCHAR,
    home_spread DOUBLE PRECISION,
    total DOUBLE PRECISION,
    fetched_at TIMESTAMPTZ NOT NULL
);

-- Fitted residual-margin model per league. Small, and refit from history rather than
-- from forward observations, so it is available before any alert has been graded.
CREATE TABLE IF NOT EXISTS margin_models (
    league VARCHAR PRIMARY KEY,
    fitted_at TIMESTAMPTZ NOT NULL,
    games INTEGER NOT NULL,
    mean DOUBLE PRECISION NOT NULL,
    sd DOUBLE PRECISION NOT NULL,
    lo INTEGER NOT NULL,
    hi INTEGER NOT NULL,
    pmf_json VARCHAR NOT NULL,
    -- Residual dispersion measured separately by how big the spread was.
    --
    -- One number for the whole league asserts a point of line is worth the same on a
    -- pick'em as on a 42-point blowout. Measuring it was meant to show big spreads
    -- scatter more; on 6,142 college games they do not. The sd is flat from 0 to 35
    -- (15.16-16.02 against a league 15.43) and LOWER above 35 (13.63 over 412 games,
    -- about four standard errors below), so a point out there buys slightly MORE
    -- probability rather than less.
    --
    -- Stored anyway: an assumption replaced by a measurement, and that 35+ band is a
    -- real effect. The prediction it was built to confirm was simply wrong.
    --
    -- JSON array of {lo, hi, games, mean, sd}, keyed on |home_spread|. Nullable
    -- because it arrives with schema v5 and an older row simply has none.
    buckets_json VARCHAR
);

-- Wagers, as placed. Deliberately immutable: nothing here is ever updated, and the
-- outcome is derived from game_results at read time rather than written back. A
-- corrected score therefore corrects the settlement by itself, and there is no way for
-- a stored result to drift out of step with the score it came from.
--
-- What the model thought at the time is recorded alongside, so a bet can later be
-- judged against the reasoning that produced it rather than against a model that has
-- since been refitted.
CREATE TABLE IF NOT EXISTS bets (
    bet_id VARCHAR PRIMARY KEY,
    placed_at TIMESTAMPTZ NOT NULL,
    league VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    home_team VARCHAR, away_team VARCHAR,
    commence_time TIMESTAMPTZ,
    market VARCHAR NOT NULL,
    side VARCHAR NOT NULL,
    line DOUBLE PRECISION,
    price BIGINT NOT NULL,
    stake DOUBLE PRECISION NOT NULL,
    book VARCHAR NOT NULL,
    -- Snapshot of the reasoning at placement time.
    model_probability DOUBLE PRECISION,
    market_probability DOUBLE PRECISION,
    rule_version_id VARCHAR,
    note VARCHAR,
    CHECK (stake > 0),
    CHECK (price <= -100 OR price >= 100),
    CHECK (market IN ('spread', 'total', 'moneyline')),
    CHECK (side IN ('home', 'away', 'over', 'under'))
);

CREATE TABLE IF NOT EXISTS book_lines (
    -- One book's number for one side of one market, at one moment.
    --
    -- Deliberately append-only and keyed by observation time rather than upserted per
    -- book: a line that moved and moved back is not the same as a line that never
    -- moved, and only the history distinguishes them. Reads take the latest row per
    -- book, so keeping every observation costs a WHERE clause and buys the movement.
    --
    -- ESPN returns exactly one book, so on its own it can never produce a comparison.
    -- The `source` column is what lets a second opinion arrive from anywhere -- an odds
    -- feed, or the user typing what their own book shows -- and be priced identically.
    quote_id VARCHAR PRIMARY KEY,
    observed_at TIMESTAMPTZ NOT NULL,
    league VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    book VARCHAR NOT NULL,
    market VARCHAR NOT NULL,
    side VARCHAR NOT NULL,
    line DOUBLE PRECISION,
    price BIGINT,
    -- 'manual' is a number the user read off their own book; 'oddsapi' came from a
    -- feed. Kept apart because a hand-typed line is a different kind of evidence and
    -- should never be silently mixed into an automated consensus without saying so.
    source VARCHAR NOT NULL,
    note VARCHAR,
    CHECK (price IS NULL OR price <= -100 OR price >= 100),
    CHECK (market IN ('spread', 'total', 'moneyline')),
    CHECK (side IN ('home', 'away', 'over', 'under')),
    CHECK (source IN ('manual', 'oddsapi', 'espn'))
);

CREATE INDEX IF NOT EXISTS book_lines_event ON book_lines (event_id, market, side);

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

CREATE TABLE IF NOT EXISTS app_settings (
    -- Preferences that must be readable without a browser.
    --
    -- Which books you hold an account at started as a cookie, which is right for
    -- rendering a page and useless for a notification: the dispatcher runs from a cron
    -- job with no request behind it, so a preference that lives only in the browser
    -- cannot be consulted when deciding whether to make the phone buzz.
    key VARCHAR PRIMARY KEY,
    value VARCHAR NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_notifications (
    -- One row per offer already pushed, so the same one never buzzes twice.
    --
    -- Keyed on the offer rather than on its price: a book, a game, a market, a side.
    -- Keying on the exact price instead would re-notify every time a number wiggled by
    -- a cent, which is how a useful alert becomes one you turn off. A materially better
    -- version of the same offer does re-notify, and `last_roi` is what that is measured
    -- against.
    offer_key VARCHAR PRIMARY KEY,
    event_id VARCHAR NOT NULL,
    book VARCHAR NOT NULL,
    market VARCHAR NOT NULL,
    side VARCHAR NOT NULL,
    last_roi DOUBLE PRECISION NOT NULL,
    notified_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS season_games (
    -- The whole season as the odds feed sees it, matched to ESPN or not.
    --
    -- `book_lines` only keeps games that matched a game on our board, which is right
    -- for line shopping: an unmatched game has no ESPN event id to hang a comparison
    -- on. But the feed returns all 272 NFL fixtures, and a survivor pool is a question
    -- about the whole season at once -- which team to spend in which week, given you
    -- may spend each only one time. Throwing away week 9 because it is not on this
    -- week's board makes that question unanswerable.
    --
    -- Keyed by the feed's own id, deliberately. There is no ESPN id for most of these
    -- and inventing one would be a lie; this table is not joined to results.
    feed_event_id VARCHAR PRIMARY KEY,
    league VARCHAR NOT NULL,
    commence_time TIMESTAMPTZ NOT NULL,
    home_team VARCHAR NOT NULL,
    away_team VARCHAR NOT NULL,
    -- Median across books, or NULL when nobody has priced it yet. Far-future weeks are
    -- usually unpriced, which is a fact about the market and not a gap to paper over.
    home_spread DOUBLE PRECISION,
    home_price BIGINT,
    away_price BIGINT,
    books INTEGER NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS season_games_when ON season_games (league, commence_time);

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


#: Column additions, which ``CREATE TABLE IF NOT EXISTS`` cannot perform on a table
#: that already exists. Every entry must be idempotent, because it runs on each upgrade
#: and against databases at any prior version. Both Postgres and DuckDB support the
#: ``IF NOT EXISTS`` clause here, so re-running is a no-op rather than an error.
ANALYTICS_MIGRATIONS = [
    # v5: residual dispersion by spread size.
    "ALTER TABLE margin_models ADD COLUMN IF NOT EXISTS buckets_json VARCHAR",
    # v8: promotional bets, where the stake is the book's and only winnings are yours.
    # A losing one costs nothing, so recording it as an ordinary wager books a loss
    # against a bet that cost zero.
    "ALTER TABLE bets ADD COLUMN IF NOT EXISTS bonus BOOLEAN NOT NULL DEFAULT FALSE",
]


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
    if existing < ANALYTICS_SCHEMA_VERSION:
        # New TABLES are handled by the DDL above, which is all CREATE TABLE IF NOT
        # EXISTS. A new COLUMN on an existing table is not, so those go here.
        for statement in ANALYTICS_MIGRATIONS:
            connection.execute(statement)
        connection.execute("DELETE FROM analytics_meta")
        connection.execute("INSERT INTO analytics_meta VALUES (?)",
                           [ANALYTICS_SCHEMA_VERSION])
