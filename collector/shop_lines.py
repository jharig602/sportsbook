"""A second book, automatically.

ESPN returns exactly one book, so nothing it provides can disagree with anything, and
the Edges page correctly reports zero. This module fetches the same games from The Odds
API, which returns ten to twenty US books, and writes them into ``book_lines`` where the
existing comparison already knows what to do with them.

Why it is worth the trouble: a point of line is worth 3.24 points of win probability in
the NFL and 2.64 in college, against the 2.4 that -110 charges. A one-point disagreement
between two books therefore clears the vig outright, where a book disagreeing with
itself never can.

Three things this module is careful about.

**The key never reaches storage.** The Odds API takes its key as a query parameter, and
``HttpClient.fetch`` writes the request URL onto every raw row. ``redact_url`` in
odds_poller handles that; this module's tests assert it.

**It rations its own credits.** The free tier is 500 a month and the collector ticks
every thirty minutes in game weeks. Rather than a separate schedule to keep in sync,
this runs on every tick and decides for itself whether a poll is worth a credit --
frequently near kickoff, barely at all midweek -- and backs off further as the budget
runs down. Running out silently in November is the failure to design against.

**It reports coverage in the direction that matters.** Games are joined to ESPN by team
name, and a board game that fails to match records no second book -- which the app then
shows as "only one book has priced this game", indistinguishable from "the books agree".
So the warning is about board games left uncovered, NOT about feed games we have no
board entry for: the feed returns a whole NFL season and college fixtures DraftKings
never prices, and warning on those would bury the one real failure under hundreds of
meaningless ones.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable

from odds_poller import (Context, DuckStore, HttpClient, MemoryStore, ODDS_API_HOST,
                         american_price, http_request, mapping, new_id, number, utcnow)
from db import Database, clean_database_url, insert_sql
from schema import ensure_analytics_schema
from team_match import Candidate, match_events

LOG = logging.getLogger("shop_lines")
UTC = timezone.utc
SOURCE = "oddsapi"

#: League key -> The Odds API sport key.
SPORT_KEYS = {"ncaaf": "americanfootball_ncaaf", "nfl": "americanfootball_nfl"}

#: Their market names -> ours. Their "h2h" is a moneyline.
MARKETS = {"h2h": "moneyline", "spreads": "spread", "totals": "total"}

#: Requested together in one call. Quota is charged per market per region, so this is
#: three credits per league per poll: about 200-260 a month on the schedule below.
REQUESTED_MARKETS = "h2h,spreads,totals"
REGIONS = "us"

COLUMNS = ["quote_id", "observed_at", "league", "event_id", "book", "market", "side",
           "line", "price", "source", "note"]

#: How long a stored quote stays fresh enough to be worth replacing. Poll often when a
#: game is close, hardly at all when none is.
NEAR_KICKOFF_HOURS = 12.0
INTERVAL_NEAR_HOURS = 3.0
INTERVAL_FAR_HOURS = 24.0

#: Credit floors. Below the first, only games about to start are worth a credit; below
#: the second, stop entirely and leave the remainder for a week that matters more.
LOW_CREDITS = 100
EXHAUSTED_CREDITS = 30
LOW_CREDIT_KICKOFF_HOURS = 6.0


def _remaining_credits(headers: dict[str, str]) -> int | None:
    """The provider's own count of what is left this month, if it said."""
    raw = headers.get("x-requests-remaining")
    try:
        return int(float(raw)) if raw is not None else None
    except (TypeError, ValueError):
        return None


def upcoming_games(database: Database | None, league: str, now: datetime,
                   horizon_days: int = 8) -> list[Candidate]:
    """ESPN games this poll could be about, newest snapshot per event.

    Read from ``odds_snapshots`` rather than a schedule endpoint because that is what
    the rest of the app treats as the board, and a book line attached to a game the
    board does not show would never be read.
    """
    if database is None:
        return []
    rows = database.fetchall(
        """
        SELECT event_id, MAX(home_team), MAX(away_team), MAX(commence_time)
          FROM odds_snapshots
         WHERE league = ? AND commence_time >= ? AND commence_time <= ?
         GROUP BY event_id
        """,
        [league, now - timedelta(hours=6), now + timedelta(days=horizon_days)],
    )
    games = []
    for event_id, home, away, commence in rows:
        if isinstance(commence, str):
            commence = datetime.fromisoformat(commence.replace("Z", "+00:00"))
        if commence.tzinfo is None:
            commence = commence.replace(tzinfo=UTC)
        games.append(Candidate(str(event_id), home, away, commence))
    return games


def last_polled(database: Database | None, league: str) -> datetime | None:
    """When this league was last fetched from the feed."""
    if database is None:
        return None
    row = database.fetchone(
        "SELECT MAX(observed_at) FROM book_lines WHERE league = ? AND source = ?",
        [league, SOURCE],
    )
    value = row[0] if row else None
    if value is None:
        return None
    if isinstance(value, str):
        value = datetime.fromisoformat(value.replace("Z", "+00:00"))
    return value.replace(tzinfo=UTC) if value.tzinfo is None else value


def should_poll(games: list[Candidate], last: datetime | None, now: datetime,
                credits_left: int | None) -> tuple[bool, str]:
    """Whether this tick is worth a credit, and why.

    Returns the reason either way so the run summary explains itself -- a module that
    silently declines to do anything is indistinguishable from one that is broken.
    """
    if credits_left is not None and credits_left < EXHAUSTED_CREDITS:
        return False, f"only {credits_left} credits left this month; holding the remainder"

    if not games:
        return False, "no upcoming games on the board for this league"

    # Only games that have not started. `upcoming_games` deliberately reaches six hours
    # back so a just-kicked-off game still resolves on the board, but a game already
    # under way is not something to shop -- and taken as "the next kickoff" it reports a
    # NEGATIVE number of hours, which is trivially "within 12h" and pins the league to
    # the three-hour interval for six hours after the last game of the night starts.
    # Observed live: "next game -0.6h out" on a Monday with nothing else until Friday.
    ahead = [game for game in games if game.commence_time > now]
    if not ahead:
        return False, "every game on the board has already started"

    soonest = min(game.commence_time for game in ahead)
    hours_to_kickoff = (soonest - now).total_seconds() / 3600.0

    if credits_left is not None and credits_left < LOW_CREDITS:
        if hours_to_kickoff > LOW_CREDIT_KICKOFF_HOURS:
            return False, (f"{credits_left} credits left; saving them for games inside "
                           f"{LOW_CREDIT_KICKOFF_HOURS:.0f}h (next is {hours_to_kickoff:.1f}h out)")
        interval = INTERVAL_NEAR_HOURS
    else:
        interval = INTERVAL_NEAR_HOURS if hours_to_kickoff <= NEAR_KICKOFF_HOURS else INTERVAL_FAR_HOURS

    if last is None:
        return True, "never polled this league"

    age_hours = (now - last).total_seconds() / 3600.0
    if age_hours < interval:
        return False, (f"last polled {age_hours:.1f}h ago; next game is "
                       f"{hours_to_kickoff:.1f}h out so the interval is {interval:.0f}h")
    return True, (f"last polled {age_hours:.1f}h ago, next game {hours_to_kickoff:.1f}h out")


def feed_candidates(payload: Any) -> list[Candidate]:
    """The feed's games, as matchable candidates."""
    games = []
    for item in payload if isinstance(payload, list) else []:
        event = mapping(item)
        key = event.get("id")
        commence = event.get("commence_time")
        if not key or not commence:
            continue
        try:
            parsed = datetime.fromisoformat(str(commence).replace("Z", "+00:00"))
        except ValueError:
            continue
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=UTC)
        games.append(Candidate(str(key), event.get("home_team"), event.get("away_team"), parsed))
    return games


def quotes_from_event(event: dict, event_id: str, league: str, observed_at: datetime,
                      ctx: Context) -> list[list]:
    """Flatten one feed game into ``book_lines`` rows.

    The feed names its outcomes by team, not by home/away, so the mapping is explicit
    rather than positional. Getting this backwards would record every away line under
    the home side and invert the sign of every comparison built on it.
    """
    home, away = event.get("home_team"), event.get("away_team")
    rows: list[list] = []

    for bookmaker in event.get("bookmakers") or []:
        book = mapping(bookmaker)
        title = book.get("title") or book.get("key")
        if not title:
            continue
        for market_payload in book.get("markets") or []:
            market_row = mapping(market_payload)
            market = MARKETS.get(str(market_row.get("key")))
            if market is None:
                continue
            for outcome_payload in market_row.get("outcomes") or []:
                outcome = mapping(outcome_payload)
                name = outcome.get("name")
                if market == "total":
                    side = str(name).lower() if name else ""
                    if side not in {"over", "under"}:
                        continue
                elif name == home:
                    side = "home"
                elif name == away:
                    side = "away"
                else:
                    # An outcome naming neither team is something we do not understand;
                    # guessing a side here would attach a price to the wrong team.
                    ctx.count(SOURCE, "unknown_outcome")
                    continue

                price = american_price(outcome.get("price"))
                line = None if market == "moneyline" else number(outcome.get("point"))
                if price is None and line is None:
                    continue
                if market != "moneyline" and line is None:
                    continue

                rows.append([new_id(), observed_at, league, event_id, str(title), market,
                             side, line, price, SOURCE, None])
    return rows


def main(argv: list[str] | None = None, *, request_fn: Callable = http_request,
         sleep_fn: Callable | None = None, clock: Callable = utcnow) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", required=True, choices=sorted(SPORT_KEYS))
    parser.add_argument("--db", type=Path, default=Path("data/warehouse-v4.duckdb"))
    parser.add_argument("--postgres", action="store_true",
                        help="Write to DATABASE_URL instead of --db. The URL is read "
                             "from the environment so credentials stay out of shell "
                             "history and process lists.")
    parser.add_argument("--dry-run", action="store_true",
                        help="Fetch and match, but write nothing.")
    parser.add_argument("--force", action="store_true",
                        help="Poll even if the throttle would skip. Spends a credit.")
    parser.add_argument("--delay", type=float, default=0.6)
    args = parser.parse_args(argv)

    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s")
    logging.Formatter.converter = time.gmtime

    # Never from argv: an API key in a command argument is visible in process lists and
    # in the shell history of anyone who runs this by hand.
    api_key = os.environ.get("ODDS_API_KEY", "").strip()

    now = clock()
    league = args.league
    summary: dict[str, Any] = {
        "type": "shop_summary", "league": league, "polled": False, "reason": "",
        "written": 0, "matched": 0, "unmatched": 0, "books": 0,
        "credits_remaining": None, "errors": 0, "warnings": 0,
    }
    store: Any = None

    try:
        if not api_key:
            # Not an error. The workflow runs this on every tick and the key is
            # optional; a missing one means the feature is simply not configured.
            summary["reason"] = "ODDS_API_KEY is not set; skipping"
            summary["exit_code"] = 3
            print(json.dumps(summary, default=str))
            return 3

        # `--dry-run` means "write no book_lines", not "open nothing". The board this
        # matches against lives in the database, so a dry run without one can only
        # report that it matched nothing -- which would look like a broken feed.
        #
        # The raw response IS still recorded on a dry run, deliberately: the request
        # was really made and really cost a credit, and the remaining-budget header on
        # that row is how the next run knows what is left. Dropping it would make dry
        # runs spend money invisibly.
        if args.postgres:
            from pg_store import PostgresStore
            store = PostgresStore(clean_database_url(os.environ.get("DATABASE_URL")))
            database = Database.postgres(store.con)
        elif args.db.exists():
            store = DuckStore(args.db)
            database = Database.duckdb(store.con)
        else:
            # Nothing to read and nothing to write to; keep it entirely in memory
            # rather than creating a warehouse as a side effect of a dry run.
            store = MemoryStore()
            database = None

        if database is not None:
            ensure_analytics_schema(database)

        ctx = Context(store, league, "pregame", now, now + timedelta(days=8))

        games = upcoming_games(database, league, now)
        last = last_polled(database, league)

        # The provider reports the remaining budget on every response, so the only way
        # to know it before a call is to remember the last one.
        credits_left = None
        if database is not None:
            row = database.fetchone(
                "SELECT headers_json FROM raw_responses WHERE source = ? "
                "ORDER BY received_at DESC LIMIT 1", [SOURCE])
            if row and row[0]:
                try:
                    credits_left = _remaining_credits(json.loads(row[0]))
                except (ValueError, TypeError):
                    credits_left = None

        poll, reason = should_poll(games, last, now, credits_left)
        if args.force:
            poll, reason = True, "forced"
        summary["reason"] = reason
        summary["credits_remaining"] = credits_left

        if not poll:
            LOG.info("skipping %s: %s", league, reason)
            summary["exit_code"] = 3
            print(json.dumps(summary, default=str))
            return 3

        client = HttpClient(ctx, request_fn=request_fn, sleep_fn=sleep_fn or time.sleep,
                            delay=args.delay, request_budget=8)
        url = f"https://{ODDS_API_HOST}/v4/sports/{SPORT_KEYS[league]}/odds"
        result = client.fetch(url, SOURCE, params={
            "apiKey": api_key, "regions": REGIONS,
            "markets": REQUESTED_MARKETS, "oddsFormat": "american",
        })

        summary["polled"] = True
        if result is None:
            summary["errors"] = ctx.errors
            summary["warnings"] = ctx.warnings
            summary["exit_code"] = 2 if ctx.errors else 3
            print(json.dumps(summary, default=str))
            return summary["exit_code"]

        summary["credits_remaining"] = _remaining_credits(result.headers)

        feed = feed_candidates(result.data)
        matches, unmatched = match_events(feed, games)

        # Which direction of "unmatched" actually matters.
        #
        # The feed returns everything it has -- a whole NFL season, and college games
        # our board never carries because DraftKings does not price FBS-versus-FCS. So
        # feed games with no board entry are the normal case, not a fault: the first
        # live run had 256 of them in the NFL against 16 real games, and warning on
        # those would bury the one alias failure worth seeing under 255 that mean
        # nothing.
        #
        # What matters is the opposite direction: a game on OUR board that got no
        # second book. That one is invisible downstream -- the page just says "only one
        # book has priced this game", which reads exactly like "the books agree".
        matched_espn = {match.espn_key for match in matches}
        uncovered = [game for game in games if game.key not in matched_espn]
        coverage = len(matches) / len(games) if games else 0.0

        summary["matched"] = len(matches)
        summary["feed_games"] = len(feed)
        summary["board_games"] = len(games)
        summary["coverage"] = round(coverage, 3)
        # Informational only: kept so a sudden change is visible, but not warned on.
        summary["feed_only"] = len(unmatched)

        if uncovered:
            detail = "; ".join(f"{game.away} @ {game.home}" for game in uncovered[:10])
            more = f" (+{len(uncovered) - 10} more)" if len(uncovered) > 10 else ""
            message = (f"{len(uncovered)} of {len(games)} board games got no second "
                       f"book: {detail}{more}")
            ctx.issue(SOURCE, "uncovered_board_games", message, severity="warning")
            summary["uncovered_detail"] = message
            LOG.warning("board coverage %.0f%%", coverage * 100)
        else:
            LOG.info("board coverage 100%% (%d games, %d feed games ignored)",
                     len(games), len(unmatched))

        by_key = {}
        for item in result.data if isinstance(result.data, list) else []:
            event = mapping(item)
            if event.get("id"):
                by_key[str(event["id"])] = event

        rows: list[list] = []
        for match in matches:
            event = by_key.get(match.feed_key)
            if event:
                rows.extend(quotes_from_event(event, match.espn_key, league,
                                              result.received_at, ctx))

        summary["books"] = len({row[4] for row in rows})
        ctx.count(SOURCE, "quotes", len(rows))

        if rows and not args.dry_run and database is not None:
            database.executemany(insert_sql("book_lines", COLUMNS), rows)
            database.commit()
            summary["written"] = len(rows)

        summary["errors"] = ctx.errors
        summary["warnings"] = ctx.warnings
        summary["sources"] = ctx.stats
        summary["exit_code"] = 2 if ctx.errors else (0 if rows else 3)
        print(json.dumps(summary, default=str))
        return summary["exit_code"]

    except KeyboardInterrupt:
        return 130
    except Exception as error:
        # Type and message only. Never print request parameters -- the key is in them.
        LOG.error("shop_lines failed (%s): %s", type(error).__name__, error)
        return 2
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
