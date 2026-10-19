"""Kalshi game prices, read-only, as one more fair-price reference.

Kalshi is an exchange, not a sportsbook: each NFL and college game is two yes/no
contracts (one per team) that pay $1, quoted as a bid and an ask. Its midpoint is a
price set by traders on both sides with no vig built in, which makes it a useful check on
whether a sportsbook's line has gone stale. Nothing here places an order, and nothing
needs an API key: market data is public.

**It cannot be bet from Michigan.** Kalshi sports contracts are under a preliminary
injunction there (Ingham County, 2026-09-01). So the three flags this computes split in
two:

* **stale_book** -- a sportsbook's no-vig chance sits well below Kalshi's midpoint. The
  bet is at the sportsbook, which is legal, so this one is shown to everyone.
* **kalshi_value** and **arb** -- the bet involves buying on Kalshi. Computed and stored
  for every state, but the web app shows them only where the viewer's state is not in
  ``blockedStates`` (``web/config/kalshi.json``). While a state is blocked they are a
  shadow log: when the ban lifts, the record already says whether they would have paid.

Four things this is careful about.

**Kalshi trades through the game.** A Cardinals-Rams market sat at 50/50 mid-game while
the pregame line had the Rams at 86%. Only snapshots taken before kickoff -- Dissent's
kickoff, from the board -- are written. A live price stored as a pregame reference would
read as the biggest edge on the board.

**Never guess a match.** NFL games match on Kalshi's team codes through the alias table
(data, not code) plus the game's US Eastern date, which is the date in every ticker
(Monday night's game is filed under Monday even though it starts after midnight UTC).
College games use the repo's name matcher, which refuses ambiguity. Anything else waits
in ``exchange_unmatched`` for a manual link in Settings, never for a fuzzy guess.

**Thin markets are not references.** A wide or shallow book says what one trader wants,
not what the market thinks. Below the depth and spread bars in the config a market is
stored and marked thin, and no flag uses it.

**Fees.** Buying at the ask costs a taker fee of ``coefficient x p x (1 - p)`` per
contract. The football series are ``quadratic_with_maker_fees``, so even resting orders
pay; this module only ever prices buying at the ask, which is the conservative case.

Public Actions logs: the summary is counts only.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from statistics import median
from typing import Any, Callable, Iterable
from urllib.parse import urlencode
from zoneinfo import ZoneInfo

from db import Database, clean_database_url, insert_sql
from odds_poller import http_request, utcnow
from schema import ensure_analytics_schema
from team_match import normalize, similarity

LOG = logging.getLogger("kalshi")
UTC = timezone.utc
EASTERN = ZoneInfo("America/New_York")
VENUE = "kalshi"

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "web" / "config" / "kalshi.json"
ALIAS_PATH = ROOT / "web" / "config" / "kalshi-aliases.json"

#: Name matching for college games: the same bars ``team_match.match_events`` uses.
NAME_THRESHOLD = 0.75
NAME_MARGIN = 0.08

#: How long a sportsbook quote stays usable as a comparison (mirrors FRESHNESS_HOURS).
BOOK_FRESH_HOURS = 30

MONTHS = {m: i for i, m in enumerate(
    ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"], 1)}
TICKER = re.compile(r"^(?P<series>[A-Z0-9]+)-(?P<yy>\d{2})(?P<mon>[A-Z]{3})(?P<dd>\d{2})(?P<codes>[A-Z0-9]+)$")


def load_config(path: Path = CONFIG_PATH) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def load_aliases(path: Path = ALIAS_PATH) -> dict[str, dict[str, str]]:
    raw = json.loads(path.read_text(encoding="utf-8"))
    return {league: dict(codes) for league, codes in raw.items() if not league.startswith("_")}


# --- parsing ---------------------------------------------------------------------------

@dataclass(frozen=True)
class KalshiMarket:
    ticker: str
    code: str
    name: str
    yes_bid: float | None
    yes_ask: float | None
    no_bid: float | None
    no_ask: float | None
    bid_size: float | None
    ask_size: float | None
    last_price: float | None
    volume: float | None


@dataclass(frozen=True)
class KalshiEvent:
    event_ticker: str
    league: str
    title: str
    game_date: date
    markets: tuple[KalshiMarket, ...]


def _dollars(value: Any) -> float | None:
    if value is None or value == "":
        return None
    try:
        result = float(value)
    except (TypeError, ValueError):
        return None
    return result


def parse_event(raw: dict, league: str) -> KalshiEvent | None:
    """One Kalshi event as a game, or None when it is not a two-team game market."""
    ticker = str(raw.get("event_ticker") or "")
    found = TICKER.match(ticker)
    if not found or found["mon"] not in MONTHS:
        return None
    try:
        game_date = date(2000 + int(found["yy"]), MONTHS[found["mon"]], int(found["dd"]))
    except ValueError:
        return None
    markets = []
    for m in raw.get("markets") or []:
        market_ticker = str(m.get("ticker") or "")
        if not market_ticker.startswith(ticker + "-"):
            continue
        code = market_ticker[len(ticker) + 1:]
        markets.append(KalshiMarket(
            ticker=market_ticker,
            code=code,
            name=str(m.get("yes_sub_title") or ""),
            yes_bid=_dollars(m.get("yes_bid_dollars")),
            yes_ask=_dollars(m.get("yes_ask_dollars")),
            no_bid=_dollars(m.get("no_bid_dollars")),
            no_ask=_dollars(m.get("no_ask_dollars")),
            bid_size=_dollars(m.get("yes_bid_size_fp")),
            ask_size=_dollars(m.get("yes_ask_size_fp")),
            last_price=_dollars(m.get("last_price_dollars")),
            volume=_dollars(m.get("volume_fp")),
        ))
    if len(markets) != 2:
        return None  # a tie market or anything else is not a moneyline pair
    return KalshiEvent(ticker, league, str(raw.get("title") or ""), game_date, tuple(markets))


# --- matching --------------------------------------------------------------------------

@dataclass(frozen=True)
class Game:
    event_id: str
    league: str
    home: str
    away: str
    commence_time: datetime

    @property
    def eastern_date(self) -> date:
        return self.commence_time.astimezone(EASTERN).date()


@dataclass(frozen=True)
class Matched:
    event: KalshiEvent
    game: Game
    #: Market code -> "home" | "away".
    sides: dict[str, str]
    how: str


@dataclass(frozen=True)
class Unmatched:
    event: KalshiEvent
    reason: str


def match_event(event: KalshiEvent, games: Iterable[Game], aliases: dict[str, dict[str, str]],
                links: dict[str, str]) -> Matched | Unmatched:
    """Link one Kalshi event to one Dissent game, or say why not. Never a best guess."""
    league_games = [g for g in games if g.league == event.league]
    codes = [m.code for m in event.markets]

    table = aliases.get(event.league, {})
    aliased = all(code in table for code in codes)
    names = {code: normalize(table[code]) for code in codes} if aliased else {}

    def by_alias(game: Game) -> dict[str, str] | None:
        if not aliased or {normalize(game.home), normalize(game.away)} != set(names.values()):
            return None
        return {code: ("home" if names[code] == normalize(game.home) else "away") for code in codes}

    # 1. A link made by hand wins outright -- it says WHICH game; the sides still come
    # from the alias table or the names, and a link neither can orient is refused.
    if event.event_ticker in links:
        game = next((g for g in league_games if g.event_id == links[event.event_ticker]), None)
        if game is None:
            return Unmatched(event, "linked game is not on the board")
        sides = by_alias(game)
        if sides is not None:
            return Matched(event, game, sides, "manual")
        return _assign_by_name(event, game, "manual", table) or Unmatched(
            event, "linked by hand, but the team names do not say which side is which")

    same_day = [g for g in league_games if g.eastern_date == event.game_date]
    if not same_day:
        return Unmatched(event, f"no {event.league.upper()} game on the board for {event.game_date}")

    # 2. Codes through the alias table: exact names, exact date.
    if aliased:
        hits = [(g, by_alias(g)) for g in same_day if by_alias(g) is not None]
        if len(hits) == 1:
            game, sides = hits[0]
            return Matched(event, game, sides, "alias")
        if len(hits) > 1:
            return Unmatched(event, "two board games share these teams on this date")
        return Unmatched(event, "teams known, but no board game pairs them on this date")

    if event.league == "nfl":
        missing = ", ".join(c for c in codes if c not in table)
        return Unmatched(event, f"team code not in the alias table: {missing}")

    # 3. College: names, both teams, unambiguous -- the team_match rules. A code that IS
    # in the alias table stands in for Kalshi's own short name ("UMass", "Appalachian
    # St."), so one confirmed alias fixes a game without needing its opponent's too.
    scored = []
    for game in same_day:
        assigned = _assign_by_name(event, game, "name", table)
        if assigned is not None:
            scored.append((_pair_score(event, game, assigned.sides, table), assigned))
    scored.sort(key=lambda row: row[0], reverse=True)
    if not scored or scored[0][0] < NAME_THRESHOLD:
        return Unmatched(event, "no board game matches both team names")
    if len(scored) > 1 and scored[0][0] - scored[1][0] < NAME_MARGIN:
        return Unmatched(event, "ambiguous: two board games match these names alike")
    return scored[0][1]


def _name(market: KalshiMarket, table: dict[str, str]) -> str:
    """The alias-table name for a code when there is one, else Kalshi's own."""
    return table.get(market.code, market.name)


def _pair_score(event: KalshiEvent, game: Game, sides: dict[str, str], table: dict[str, str]) -> float:
    by_code = {m.code: m for m in event.markets}
    scores = []
    for code, side in sides.items():
        scores.append(similarity(_name(by_code[code], table), game.home if side == "home" else game.away))
    return min(scores)


def _assign_by_name(event: KalshiEvent, game: Game, how: str, table: dict[str, str]) -> Matched | None:
    """Which market is the home team, by name, when one orientation clearly wins."""
    a, b = event.markets
    na, nb = _name(a, table), _name(b, table)
    straight = min(similarity(na, game.home), similarity(nb, game.away))
    swapped = min(similarity(na, game.away), similarity(nb, game.home))
    if max(straight, swapped) < NAME_THRESHOLD or abs(straight - swapped) < NAME_MARGIN:
        return None
    if straight > swapped:
        return Matched(event, game, {a.code: "home", b.code: "away"}, how)
    return Matched(event, game, {a.code: "away", b.code: "home"}, how)


# --- pricing ---------------------------------------------------------------------------

def taker_fee(price: float, coefficient: float) -> float:
    """Fee per contract for buying at `price` ($), before Kalshi rounds the order."""
    return coefficient * price * (1 - price)


def effective_ask(ask: float | None, coefficient: float) -> float | None:
    """What one contract really costs at the ask: the price plus its taker fee."""
    if ask is None or not 0 < ask < 1:
        return None
    return ask + taker_fee(ask, coefficient)


def is_thin(market: KalshiMarket, thin: dict) -> bool:
    if market.yes_bid is None or market.yes_ask is None:
        return True
    if market.yes_ask - market.yes_bid > thin["maxSpreadDollars"] + 1e-9:
        return True
    depth = min(market.bid_size or 0, market.ask_size or 0)
    return depth < thin["minDepthContracts"]


def kalshi_fair(home: KalshiMarket, away: KalshiMarket) -> float | None:
    """Home's fair chance: the two markets' midpoints, which mirror each other, averaged."""
    if None in (home.yes_bid, home.yes_ask, away.yes_bid, away.yes_ask):
        return None
    home_mid = (home.yes_bid + home.yes_ask) / 2
    away_mid = (away.yes_bid + away.yes_ask) / 2
    return (home_mid + (1 - away_mid)) / 2


def implied(price: int | None) -> float | None:
    if price is None or -100 < price < 100:
        return None
    return 100 / (price + 100) if price > 0 else -price / (-price + 100)


def no_vig(price: int | None, opposite: int | None) -> float | None:
    a, b = implied(price), implied(opposite)
    if a is None or b is None or a + b <= 0:
        return None
    return a / (a + b)


@dataclass(frozen=True)
class BookQuote:
    book: str
    side: str
    price: int
    opposite: int | None


@dataclass
class Flag:
    kind: str
    side: str
    book: str | None
    book_price: int | None
    book_fair: float | None
    kalshi_fair: float
    kalshi_cost: float | None
    consensus: float | None
    edge_points: float
    books: int


def compute_flags(fair_home: float, cost: dict[str, float | None], quotes: list[BookQuote],
                  thresholds: dict) -> list[Flag]:
    """All three flags for one game. `cost` is the fee-adjusted ask per side."""
    fair = {"home": fair_home, "away": 1 - fair_home}
    flags: list[Flag] = []

    no_vigs: dict[str, list[float]] = {"home": [], "away": []}
    for q in quotes:
        p = no_vig(q.price, q.opposite)
        if p is not None:
            no_vigs[q.side].append(p)
        # 1. stale book: this book thinks the side is less likely than Kalshi does.
        if p is not None and (fair[q.side] - p) * 100 >= thresholds["staleBookPoints"]:
            flags.append(Flag("stale_book", q.side, q.book, q.price, p, fair[q.side], None, None,
                              (fair[q.side] - p) * 100, 1))
        # 3. arb: this book's price on one side, Kalshi's cost on the other.
        other = "away" if q.side == "home" else "home"
        book_cost = implied(q.price)
        if book_cost is not None and cost.get(other) is not None:
            spare = (1 - book_cost - cost[other]) * 100
            if spare >= thresholds["arbMarginPoints"] and spare > 0:
                flags.append(Flag("arb", q.side, q.book, q.price, p, fair[q.side], cost[other], None,
                                  spare, 1))

    # 2. Kalshi value: the books' consensus says the side is worth more than Kalshi charges.
    for side in ("home", "away"):
        values = no_vigs[side]
        if len(values) < 2 or cost.get(side) is None:
            continue
        consensus = median(values)
        edge = (consensus - cost[side]) * 100
        if edge >= thresholds["kalshiValuePoints"]:
            flags.append(Flag("kalshi_value", side, None, None, None, fair[side], cost[side],
                              consensus, edge, len(values)))
    return flags


def flag_id(event_id: str, flag: Flag) -> str:
    """One row per OFFER, not per poll: the same prices seen twice are one observation."""
    key = "|".join(str(x) for x in (VENUE, event_id, flag.kind, flag.side, flag.book,
                                    flag.book_price, round(flag.kalshi_cost or 0, 2),
                                    round(flag.kalshi_fair, 2)))
    return hashlib.sha256(key.encode()).hexdigest()[:32]


# --- I/O -------------------------------------------------------------------------------

def fetch_events(base_url: str, series: str, request_fn: Callable = http_request,
                 sleep_fn: Callable = time.sleep, max_pages: int = 10) -> list[dict]:
    events: list[dict] = []
    cursor = ""
    for _ in range(max_pages):
        params = {"series_ticker": series, "status": "open", "with_nested_markets": "true", "limit": 200}
        if cursor:
            params["cursor"] = cursor
        status, _headers, body = request_fn(f"{base_url}/events?{urlencode(params)}",
                                            {"Accept": "application/json"}, 20)
        if status == 429:
            sleep_fn(2)
            continue
        if status != 200:
            raise RuntimeError(f"Kalshi events returned HTTP {status}")
        payload = json.loads(body)
        events.extend(payload.get("events") or [])
        cursor = payload.get("cursor") or ""
        if not cursor:
            break
        sleep_fn(0.3)
    return events


def board_games(database: Database, now: datetime, horizon_days: int = 8) -> list[Game]:
    rows = database.fetchall(
        """
        SELECT event_id, MAX(league), MAX(home_team), MAX(away_team), MAX(commence_time)
          FROM odds_snapshots
         WHERE commence_time >= ? AND commence_time <= ?
         GROUP BY event_id
        """,
        [now - timedelta(hours=6), now + timedelta(days=horizon_days)],
    )
    games = []
    for event_id, league, home, away, commence in rows:
        if not home or not away:
            continue
        if isinstance(commence, str):
            commence = datetime.fromisoformat(commence.replace("Z", "+00:00"))
        if commence.tzinfo is None:
            commence = commence.replace(tzinfo=UTC)
        games.append(Game(str(event_id), str(league), str(home), str(away), commence))
    return games


def manual_links(database: Database) -> dict[str, str]:
    return {str(t): str(e) for t, e in database.fetchall(
        "SELECT event_ticker, event_id FROM exchange_links WHERE venue = ?", [VENUE])}


def book_quotes(database: Database, event_id: str, now: datetime) -> list[BookQuote]:
    """Every sportsbook's latest moneyline on one game: the board's DraftKings and book_lines."""
    cutoff = now - timedelta(hours=BOOK_FRESH_HOURS)
    latest: dict[tuple[str, str], int] = {}
    for side, price in database.fetchall(
        """
        SELECT side, price FROM odds_snapshots
         WHERE event_id = ? AND market = 'moneyline' AND price IS NOT NULL
           AND observation_kind = 'pregame_observation' AND observed_at >= ?
         ORDER BY observed_at
        """, [event_id, cutoff]):
        latest[("DraftKings", str(side))] = int(price)
    for book, side, price in database.fetchall(
        """
        SELECT book, side, price FROM book_lines
         WHERE event_id = ? AND market = 'moneyline' AND price IS NOT NULL AND observed_at >= ?
         ORDER BY observed_at
        """, [event_id, cutoff]):
        if str(book) == "DraftKings":
            continue  # the board's own DraftKings is the authority on DraftKings
        latest[(str(book), str(side))] = int(price)
    quotes = []
    for (book, side), price in latest.items():
        if side not in ("home", "away"):
            continue
        other = latest.get((book, "away" if side == "home" else "home"))
        quotes.append(BookQuote(book, side, price, other))
    return quotes


QUOTE_COLUMNS = ["quote_id", "observed_at", "venue", "league", "event_id", "event_ticker",
                 "market_ticker", "side", "yes_bid", "yes_ask", "no_bid", "no_ask", "bid_size",
                 "ask_size", "last_price", "volume", "thin", "commence_time"]
FLAG_COLUMNS = ["flag_id", "observed_at", "venue", "league", "event_id", "commence_time", "kind",
                "side", "book", "book_price", "book_fair", "kalshi_fair", "kalshi_cost",
                "consensus", "edge_points", "books"]


def main(argv: list[str] | None = None, *, request_fn: Callable = http_request,
         sleep_fn: Callable = time.sleep, clock: Callable = utcnow) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", action="append", choices=["nfl", "ncaaf"],
                        help="League to poll; repeat for both. Default: both.")
    parser.add_argument("--postgres", action="store_true",
                        help="Write to DATABASE_URL (read from the environment).")
    parser.add_argument("--db", type=Path, default=Path("data/warehouse-v4.duckdb"))
    parser.add_argument("--dry-run", action="store_true", help="Fetch and match, write nothing.")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s")
    logging.Formatter.converter = time.gmtime

    config = load_config()
    aliases = load_aliases()
    now = clock()
    leagues = args.league or ["nfl", "ncaaf"]

    if args.postgres:
        from pg_store import PostgresStore
        store = PostgresStore(clean_database_url(os.environ.get("DATABASE_URL")))
        database = Database.postgres(store.con)
    else:
        import duckdb
        store = None
        database = Database.duckdb(duckdb.connect(str(args.db)))
    ensure_analytics_schema(database)

    games = board_games(database, now)
    links = manual_links(database)
    coefficient = float(config["fee"]["takerCoefficient"])
    summary: dict[str, Any] = {"type": "kalshi_summary", "events": 0, "matched": 0,
                               "unmatched": 0, "quotes": 0, "thin": 0, "after_kickoff": 0,
                               "flags": 0, "board_games_without_kalshi": 0}
    quote_rows: list[list] = []
    flag_rows: list[list] = []
    unmatched_rows: list[Unmatched] = []
    matched_ids: set[str] = set()
    matched_tickers: list[str] = []

    for league in leagues:
        raw_events = fetch_events(config["baseUrl"], config["series"][league], request_fn, sleep_fn)
        for raw in raw_events:
            event = parse_event(raw, league)
            if event is None:
                continue
            summary["events"] += 1
            result = match_event(event, games, aliases, links)
            if isinstance(result, Unmatched):
                # Only events on a date the board covers are worth a manual look; the
                # rest (FCS, games weeks out) would bury the ones that matter.
                if any(g.league == league and g.eastern_date == event.game_date for g in games):
                    unmatched_rows.append(result)
                continue
            summary["matched"] += 1
            matched_ids.add(result.game.event_id)
            matched_tickers.append(event.event_ticker)
            if now >= result.game.commence_time:
                summary["after_kickoff"] += 1
                continue  # live prices are not references
            by_side = {}
            for market in event.markets:
                side = result.sides[market.code]
                by_side[side] = market
                thin = is_thin(market, config["thin"])
                summary["thin"] += int(thin)
                quote_rows.append([
                    hashlib.sha256(f"{market.ticker}|{now.isoformat()}".encode()).hexdigest()[:32],
                    now, VENUE, league, result.game.event_id, event.event_ticker, market.ticker,
                    side, market.yes_bid, market.yes_ask, market.no_bid, market.no_ask,
                    market.bid_size, market.ask_size, market.last_price, market.volume, thin,
                    result.game.commence_time,
                ])
            if len(by_side) != 2 or any(is_thin(m, config["thin"]) for m in by_side.values()):
                continue
            fair = kalshi_fair(by_side["home"], by_side["away"])
            if fair is None:
                continue
            cost = {s: effective_ask(m.yes_ask, coefficient) for s, m in by_side.items()}
            for flag in compute_flags(fair, cost, book_quotes(database, result.game.event_id, now),
                                      config["flags"]):
                flag_rows.append([
                    flag_id(result.game.event_id, flag), now, VENUE, league, result.game.event_id,
                    result.game.commence_time, flag.kind, flag.side, flag.book, flag.book_price,
                    flag.book_fair, flag.kalshi_fair, flag.kalshi_cost, flag.consensus,
                    flag.edge_points, flag.books,
                ])

    summary["unmatched"] = len(unmatched_rows)
    summary["quotes"] = len(quote_rows)
    summary["flags"] = len(flag_rows)
    # By kind, so a flood of one kind (a bad threshold, a stale feed) is visible in the log.
    by_kind: dict[str, int] = {}
    for row in flag_rows:
        by_kind[row[6]] = by_kind.get(row[6], 0) + 1
    summary["flags_by_kind"] = by_kind
    summary["board_games_without_kalshi"] = sum(
        1 for g in games if g.league in leagues and g.event_id not in matched_ids)

    if not args.dry_run:
        if quote_rows:
            # Keyed by contract and poll time, so re-running the same poll adds nothing.
            database.executemany(
                insert_sql("exchange_quotes", QUOTE_COLUMNS) + " ON CONFLICT (quote_id) DO NOTHING",
                quote_rows)
        for row in flag_rows:
            database.execute(
                insert_sql("exchange_flags", FLAG_COLUMNS) + " ON CONFLICT (flag_id) DO NOTHING", row)
        # The unmatched list is state: what is unmatched NOW. Matched events leave it.
        for ticker in matched_tickers:
            database.execute("DELETE FROM exchange_unmatched WHERE event_ticker = ?", [ticker])
        for item in unmatched_rows:
            e = item.event
            database.execute(
                """
                INSERT INTO exchange_unmatched (event_ticker, venue, league, title, game_date,
                                                codes, reason, first_seen, last_seen)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT (event_ticker) DO UPDATE SET reason = excluded.reason,
                                                         last_seen = excluded.last_seen
                """,
                [e.event_ticker, VENUE, e.league, e.title, e.game_date,
                 ",".join(m.code for m in e.markets), item.reason, now, now])
        database.execute("DELETE FROM exchange_unmatched WHERE last_seen < ?",
                         [now - timedelta(days=2)])
        database.commit()

    print(json.dumps(summary))
    if store is not None:
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
