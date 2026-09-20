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

ANALYTICS_SCHEMA_VERSION = 20

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
CREATE TABLE IF NOT EXISTS score_models (
    -- How the FINAL SCORE scatters around what the market priced, per league.
    --
    -- margin_models already fits one half of this: the margin residual, `margin +
    -- home_spread`. This adds the other half -- the total residual, `points - total` --
    -- and the one number neither can hold alone: how the two move together.
    --
    -- That correlation is the whole point. A same-game parlay is two legs decided by one
    -- scoreline, so multiplying their separate probabilities is wrong in a direction
    -- that depends on the legs: "home wins AND the game goes over" is not the product of
    -- its parts when favourites winning big also puts points on the board. With margin
    -- and total jointly modelled, any leg that resolves off the final score -- moneyline,
    -- spread, game total, team total -- has a joint probability rather than a guess.
    --
    -- Player props are not in here and cannot be: nothing in this database holds a
    -- player line, so a parlay touching one is refused rather than estimated.
    league VARCHAR PRIMARY KEY,
    fitted_at TIMESTAMPTZ NOT NULL,
    games INTEGER NOT NULL,
    -- Residual total: actual points minus the closing total. Mean says whether the
    -- market's totals are systematically off; it should sit near zero.
    total_mean DOUBLE PRECISION NOT NULL,
    total_sd DOUBLE PRECISION NOT NULL,
    -- Residual margin, repeated here so the pair that produced the correlation is stored
    -- together. It should agree with margin_models; if it ever does not, one of them was
    -- fitted on a different set of games and the disagreement is the finding.
    margin_mean DOUBLE PRECISION NOT NULL,
    margin_sd DOUBLE PRECISION NOT NULL,
    -- Pearson correlation of the two residuals, on the games where both exist.
    correlation DOUBLE PRECISION NOT NULL
);

CREATE TABLE IF NOT EXISTS bets (
    bet_id VARCHAR PRIMARY KEY,
    -- Whose ledger this row belongs to. See ANALYTICS_MIGRATIONS v14.
    owner_id VARCHAR NOT NULL DEFAULT 'owner',
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
    -- bet_id of a row this one corrects. See ANALYTICS_MIGRATIONS v11.
    supersedes VARCHAR,
    -- True when this row removes the one it supersedes instead of replacing it.
    voided BOOLEAN,
    -- Legs of one parlay share this. See ANALYTICS_MIGRATIONS v13.
    parlay_id VARCHAR,
    parlay_price BIGINT,
    -- Cash paid to end the ticket early. See ANALYTICS_MIGRATIONS v15.
    cashout DOUBLE PRECISION,
    -- Which team's points a 'total' row is about. See ANALYTICS_MIGRATIONS v20.
    team VARCHAR,
    CHECK (stake > 0),
    CHECK (price <= -100 OR price >= 100),
    CHECK (market IN ('spread', 'total', 'moneyline')),
    CHECK (side IN ('home', 'away', 'over', 'under')),
    CHECK (team IS NULL OR team IN ('home', 'away'))
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

CREATE TABLE IF NOT EXISTS pick_popularity (
    -- What share of survivor entrants took each team, by week.
    --
    -- The missing input for pool strategy. Survival alone says take the biggest
    -- favourite; a pool pays the LAST entrant standing, so what matters is surviving
    -- weeks the field does not. That is unanswerable without knowing what the field
    -- picked, and no amount of odds data substitutes for it.
    --
    -- Sourced from survivorgrid.com, which averages Yahoo and ESPN public pools. That
    -- is a national average: a good proxy for a large pool and a rough one for a pool
    -- of thirteen people, where a single entrant moves a share by eight points.
    league VARCHAR NOT NULL,
    week INTEGER NOT NULL,
    team VARCHAR NOT NULL,
    -- Share of entrants picking this team, 0-1.
    pick_share DOUBLE PRECISION NOT NULL,
    -- The source's own win probability, kept for comparison against our fitted model
    -- rather than used. Two independent estimates disagreeing is a finding.
    source_win_probability DOUBLE PRECISION,
    observed_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (league, week, team)
);

CREATE TABLE IF NOT EXISTS survivor_notifications (
    -- One row per reminder already sent, so a thirty-minute cron does not send
    -- thirty reminders.
    --
    -- Keyed on (week, window) rather than on the pick, because the point is a
    -- reminder at a time you asked for, not an alert when something changes. A pick
    -- that has NOT moved still needs saying on Sunday morning -- "still the Chargers"
    -- is the message. The team is stored so a change between windows is visible.
    week INTEGER NOT NULL,
    -- 'saturday' or 'sunday': the two moments worth interrupting for.
    -- Named send_window, not window: DuckDB reserves the latter for window functions
    -- and the CREATE fails outright on it.
    send_window VARCHAR NOT NULL,
    picks_json VARCHAR NOT NULL,
    sent_at TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (week, send_window)
);

CREATE TABLE IF NOT EXISTS shop_picks (
    -- A cross-book edge, written down as a falsifiable prediction.
    --
    -- This table exists because the instrumentation was exactly inverted. The alert
    -- pipeline grades line-movement signals, which are demoted to the point of not even
    -- notifying; the cross-book disagreement this whole app is named after was surfaced,
    -- acted on, and never once checked against what happened. `shop_notifications` looks
    -- like it should have covered that and cannot: it stores no line and no price, so
    -- nothing in it can be graded either way.
    --
    -- So every field needed to settle the claim is here, and `fair_probability` is the
    -- claim itself: this side, at this number, wins that often. That is a sharper thing
    -- to be wrong about than a side, and it is the reason this record will be worth
    -- something long before the cover rate is -- calibration converges on dozens where
    -- a win rate needs hundreds.
    pick_id VARCHAR PRIMARY KEY,
    observed_at TIMESTAMPTZ NOT NULL,
    league VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL,
    commence_time TIMESTAMPTZ,
    home_team VARCHAR, away_team VARCHAR,
    book VARCHAR NOT NULL,
    market VARCHAR NOT NULL,
    side VARCHAR NOT NULL,
    -- The two fields shop_notifications lacks, and without which nothing can be scored.
    line DOUBLE PRECISION,
    price BIGINT,
    consensus_line DOUBLE PRECISION,
    consensus_probability DOUBLE PRECISION,
    fair_probability DOUBLE PRECISION NOT NULL,
    break_even DOUBLE PRECISION,
    expected_roi DOUBLE PRECISION,
    edge_points DOUBLE PRECISION,
    books_compared INTEGER NOT NULL,
    thin_consensus BOOLEAN NOT NULL,
    rule_version_id VARCHAR NOT NULL,
    -- Reconstructed from stored history rather than seen live. See MIGRATIONS v17.
    replayed BOOLEAN NOT NULL DEFAULT FALSE,
    CHECK (market IN ('spread', 'total', 'moneyline')),
    CHECK (side IN ('home', 'away', 'over', 'under')),
    CHECK (fair_probability > 0 AND fair_probability < 1)
);

CREATE TABLE IF NOT EXISTS shop_grades (
    -- Did the edge actually win. Mirrors alert_grades, and deliberately copies the
    -- prediction forward rather than joining for it: a calibration curve is read by
    -- predicted probability, and a join to a table that can be re-fitted underneath it
    -- would quietly re-bucket history.
    grade_id VARCHAR PRIMARY KEY,
    pick_id VARCHAR NOT NULL UNIQUE,
    graded_at TIMESTAMPTZ NOT NULL,
    rule_version_id VARCHAR NOT NULL,
    league VARCHAR NOT NULL,
    market VARCHAR NOT NULL,
    side VARCHAR NOT NULL,
    line DOUBLE PRECISION,
    price BIGINT,
    fair_probability DOUBLE PRECISION NOT NULL,
    expected_roi DOUBLE PRECISION,
    -- NULL means push: neither a hit nor a miss, and it must leave the denominator.
    result_covered BOOLEAN,
    result_push BOOLEAN NOT NULL
);

CREATE INDEX IF NOT EXISTS shop_picks_event ON shop_picks (event_id);

CREATE TABLE IF NOT EXISTS promos (
    -- A promotional offer, as the book worded it, entered by hand.
    --
    -- Entered rather than scraped on purpose. Promo terms sit behind a login and are
    -- rendered in the book's own app; scraping an account you hold risks that account,
    -- and there is no public feed. Thirty seconds of typing a few times a week is the
    -- cheaper trade.
    --
    -- The money this table saves is not in picking better. It is in a token expiring
    -- unused and a bonus-bet refund lapsing in the account -- which is why `expires_at`
    -- is the only required term and why the dashboard sorts by it.
    promo_id VARCHAR PRIMARY KEY,
    owner_id VARCHAR NOT NULL DEFAULT 'owner',
    book VARCHAR NOT NULL,
    type VARCHAR NOT NULL,
    title VARCHAR NOT NULL,
    claimed_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    -- Terms. Which ones matter depends on the type; the rest stay null rather than
    -- being defaulted, because a wrong default here silently changes what a promo is
    -- worth and reads exactly like a right one.
    cap_refund DOUBLE PRECISION,        -- stake_back: most that comes back
    max_stake DOUBLE PRECISION,         -- profit_boost, odds_boost
    boost_pct DOUBLE PRECISION,         -- profit_boost: 0.5 is a 50% boost
    bonus_face DOUBLE PRECISION,        -- bonus_bet: face value of the token
    boosted_price BIGINT,               -- odds_boost: the enhanced American price
    base_price BIGINT,                  -- odds_boost: what it pays elsewhere
    deposit_bonus DOUBLE PRECISION,     -- deposit_match
    rollover_multiple DOUBLE PRECISION, -- deposit_match: 10 means 10x the bonus
    min_odds_american BIGINT,
    min_legs INTEGER,
    eligible_markets VARCHAR,           -- JSON array of free-text tags
    eligible_from TIMESTAMPTZ,
    eligible_to TIMESTAMPTZ,
    excluded VARCHAR,                   -- JSON array: "bonus funds", "cashed out bets"
    -- Books rarely let two promos touch one bet. Assumed false; set only when the terms
    -- actually say otherwise.
    stackable BOOLEAN NOT NULL DEFAULT FALSE,
    -- available or used. Deliberately NOT 'expired': that is `expires_at` compared with
    -- now, and a stored copy of a derived fact drifts out of step with the thing it was
    -- derived from. See the same reasoning behind deriving bet outcomes from scores.
    status VARCHAR NOT NULL DEFAULT 'available',
    created_at TIMESTAMPTZ NOT NULL,
    CHECK (type IN ('stake_back', 'profit_boost', 'odds_boost', 'bonus_bet', 'deposit_match')),
    CHECK (status IN ('available', 'used'))
);

CREATE TABLE IF NOT EXISTS promo_uses (
    -- What was actually done with a promo, and what came back.
    --
    -- `ev_at_placement` and `fair_prob` are stored as they stood when the bet was
    -- struck. Recomputing them later would mark our own homework: the point of keeping
    -- them is to compare summed expectations against realised returns, which is the
    -- only honest check on the bonus-conversion assumption every one of these formulas
    -- leans on.
    --
    -- Cash and bonus are returned separately because they are not the same money: a $50
    -- bonus bet that wins pays cash winnings and keeps the stake, and totalling them
    -- would overstate what landed in the account.
    use_id VARCHAR PRIMARY KEY,
    promo_id VARCHAR NOT NULL,
    owner_id VARCHAR NOT NULL DEFAULT 'owner',
    placed_at TIMESTAMPTZ NOT NULL,
    stake DOUBLE PRECISION NOT NULL,
    odds_american BIGINT NOT NULL,
    legs INTEGER NOT NULL DEFAULT 1,
    -- The ledger row this promo bet was logged as, when it was.
    bet_id VARCHAR,
    fair_prob DOUBLE PRECISION,
    ev_at_placement DOUBLE PRECISION,
    settled_at TIMESTAMPTZ,
    result VARCHAR,
    returned_cash DOUBLE PRECISION,
    returned_bonus DOUBLE PRECISION,
    CHECK (result IS NULL OR result IN ('win', 'loss', 'push', 'void')),
    CHECK (stake > 0),
    CHECK (odds_american <= -100 OR odds_american >= 100)
);

CREATE INDEX IF NOT EXISTS promos_expiry ON promos (owner_id, status, expires_at);
CREATE INDEX IF NOT EXISTS promo_uses_promo ON promo_uses (promo_id);

CREATE TABLE IF NOT EXISTS ledger_transfers (
    -- A short-lived code that moves one anonymous ledger to a second device.
    --
    -- The owner_id is a random identifier in a cookie, which is what makes a ledger
    -- personal without anyone having an account. That alone would strand it in one
    -- browser -- and a betting ledger's entire value is the sample it accumulates, so
    -- one stranded on a laptop is worth much less than the same rows reachable from
    -- the phone the bets are actually placed on.
    --
    -- The code IS a bearer credential for the duration: anyone holding it becomes that
    -- ledger. Hence short, single-use, and deleted on claim rather than kept. Eight
    -- characters from a 31-letter alphabet is 8.5e11 combinations against a
    -- fifteen-minute window, which is not a space worth searching for someone else's
    -- record of $5 bets.
    --
    -- The owner's own ledger is deliberately NOT reachable this way; see owner.ts.
    code VARCHAR PRIMARY KEY,
    owner_id VARCHAR NOT NULL,
    created_at TIMESTAMPTZ NOT NULL,
    claimed_at TIMESTAMPTZ
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
    # v11: corrections. The bets table is append-only -- the outcome is derived from
    # game_results at read time, so nothing here is ever updated -- which left no way to
    # fix a row recorded wrongly. A bet carrying `supersedes` replaces the one it names;
    # both are kept, because what was originally written is part of the history even
    # when it was wrong, and silently editing a ledger is how a ledger stops being one.
    "ALTER TABLE bets ADD COLUMN IF NOT EXISTS supersedes VARCHAR",
    # v12: a correction that removes rather than replaces. For a row that should never
    # have existed -- a mis-entry, a bet decided against, a duplicate. Still a tombstone
    # rather than a DELETE: the table records what was written, including the times it
    # was written wrongly.
    "ALTER TABLE bets ADD COLUMN IF NOT EXISTS voided BOOLEAN NOT NULL DEFAULT FALSE",
    # v13: parlays. A parlay is stored as one row per leg sharing a parlay_id, because
    # every leg has its own game and its own result and each must be graded separately.
    # Storing it as a single row on one game would settle a three-leg ticket against one
    # of them -- right money, wrong verdict, and no way to notice.
    #
    # parlay_price is the COMBINED price the book actually offered, kept rather than
    # derived: books round the product of the legs down, and recomputing it here would
    # silently pay better than the ticket does. stake is repeated on every leg and must
    # therefore be counted once per parlay, not once per row.
    "ALTER TABLE bets ADD COLUMN IF NOT EXISTS parlay_id VARCHAR",
    "ALTER TABLE bets ADD COLUMN IF NOT EXISTS parlay_price BIGINT",
    # v14: whose ledger a row belongs to.
    #
    # The DEFAULT is what makes this safe to run against a live table: every row written
    # before multiple people could use the app was written by the one person who could,
    # so backfilling them all to 'owner' is not a guess -- it is the only thing they
    # could have meant. Without the default the column would be NULL on the whole
    # existing season and every reader filtering by owner would report an empty ledger,
    # which is this project's cardinal failure: a lost record that looks like no record.
    #
    # NOT NULL, because a row that belongs to nobody is unreachable and ungradeable but
    # still counts toward the table -- it would sit there affecting nothing and
    # explaining nothing.
    "ALTER TABLE bets ADD COLUMN IF NOT EXISTS owner_id VARCHAR NOT NULL DEFAULT 'owner'",
    # v15: cash-out. The one outcome that cannot be derived.
    #
    # Every other verdict in this table is recomputed from game_results on each read,
    # which is why nothing here is ever updated and a corrected score corrects the P&L
    # by itself. A cash-out breaks that: the ticket was sold back at a price the book
    # and I agreed on, and the final score no longer decides anything. Leaving it
    # derived would book a $50 bonus moneyline at +920 as either +$460 or $0 when the
    # actual result was $193.98 -- a number that is wrong in the ledger and looks
    # exactly like a number that is right.
    #
    # So the amount is stored, and it is the ONLY stored verdict in the schema. The
    # bet row still records what was struck; this records that it ended early.
    #
    # The score is still kept and still graded, because the counterfactual is worth
    # measuring: over enough cash-outs, "what holding would have paid" versus "what I
    # took" says whether these decisions are any good, which is not something intuition
    # can answer.
    "ALTER TABLE bets ADD COLUMN IF NOT EXISTS cashout DOUBLE PRECISION",
    # v20: which team's points, when a total is one team's rather than the game's.
    #
    # A team total is stored as market 'total' with a team, not as a market of its own.
    # That is not a dodge around the CHECK constraint -- though it does avoid needing to
    # alter one, which neither engine here does portably. It is what a team total IS: a
    # line on points scored, asked of one side instead of both. Grading reads the same
    # score; only which numbers get added changes.
    #
    # NULL means the game's total, which is what every row written before this meant and
    # the only thing they could have meant, so nothing needs backfilling.
    #
    # This exists for same-game parlays. A team total and its own side's spread are the
    # most correlated pair a book offers -- 0.70 in the NFL, measured -- and pricing that
    # pair is the whole reason joint-score.ts exists. Leaving team totals unloggable
    # would have meant a builder that prices the best ticket on the board and a ledger
    # that cannot record it.
    "ALTER TABLE bets ADD COLUMN IF NOT EXISTS team VARCHAR",
    # v17: whether a shop pick was seen live or reconstructed from stored history.
    #
    # The replay runs the real rule over real book_lines at their real timestamps, so
    # the rows are honest observations -- but they carry one contamination a live pick
    # cannot. The margin model supplying the points-to-probability density is the one
    # fitted today, and if `historical_lines` holds any of the games being replayed then
    # that density partly saw its own answers. A live pick is made before the game and
    # cannot have that problem.
    #
    # The effect is second-order -- the edge comes from the cross-book line difference,
    # and the model only prices what a point of it is worth -- but "second-order" is a
    # judgement, not a measurement, and a flag costs nothing. If replayed picks ever
    # read better than live ones, this column is the first thing to look at.
    "ALTER TABLE shop_picks ADD COLUMN IF NOT EXISTS replayed BOOLEAN NOT NULL DEFAULT FALSE",
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
