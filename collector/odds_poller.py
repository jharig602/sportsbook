#!/usr/bin/env python3
"""V4 research collector. Full raw responses first; no bet placement or CLV claims.

Python 3.10+. Install requirements.txt; see README.md before scheduling.
An observed feed quote is not proof of an executable sportsbook price.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import logging
import math
import os
import sys
import time
import uuid
from dataclasses import asdict, dataclass, field
from datetime import date, datetime, time as day_time, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

VERSION = "4.0.0"
SCHEMA_VERSION = 4
UTC = timezone.utc
LOG = logging.getLogger("odds_poller")
SITE_API = "https://site.api.espn.com/apis/site/v2/sports"
CORE_API = "https://sports.core.api.espn.com/v2/sports"
CFBD_API = "https://api.collegefootballdata.com/lines"
ESPN_HOSTS = {"site.api.espn.com", "sports.core.api.espn.com"}
# site.api.espn.com sits behind bot management that rejects bare HTTP clients with an
# empty-body 403 (sports.core.api.espn.com does not). Verified 2026-09-06: the honest
# User-Agent below is accepted; what the edge actually requires is this fetch-metadata /
# client-hint group. A Referer alone still 403s, and so does a spoofed Chrome UA alone.
ESPN_BROWSER_HEADERS = {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.espn.com/",
    "Origin": "https://www.espn.com",
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "cors",
    "Sec-Fetch-Site": "same-site",
    "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24"',
    "sec-ch-ua-mobile": "?0",
    "sec-ch-ua-platform": '"Windows"',
}
# ESPN silently degrades the scoreboard to a ~25-event default above a limit it does not
# document. Verified 2026-09-06: limit=1000 returned 25 college-football events for a date
# the uncurated core API reported 80 for; limit=300 and limit=500 both returned all 80.
SCOREBOARD_LIMIT = 300
# ESPN's degraded default slate size. Used only to detect the silent truncation above.
DEGRADED_SCOREBOARD_COUNT = 25
LEAGUES = {
    "nfl": ("football", "nfl", None),
    "ncaaf": ("football", "college-football", "80"),
    "nba": ("basketball", "nba", None),
    "ncaab": ("basketball", "mens-college-basketball", "50"),
    "nhl": ("hockey", "nhl", None),
    "mlb": ("baseball", "mlb", None),
}


def utcnow() -> datetime:
    return datetime.now(UTC)


def new_id() -> str:
    return uuid.uuid4().hex


def timestamp(value: Any) -> datetime | None:
    """Never interpret a naive provider timestamp as local time or UTC."""
    if not isinstance(value, str) or not value:
        return None
    try:
        result = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return result.astimezone(UTC) if result.tzinfo is not None else None
    except ValueError:
        return None


def number(value: Any) -> float | None:
    if value is None or isinstance(value, bool) or value == "":
        return None
    try:
        result = float(value)
        return result if math.isfinite(result) else None
    except (TypeError, ValueError, OverflowError):
        return None


def american_price(value: Any) -> int | None:
    """Accept conventional integer American prices; zero is a missing sentinel."""
    if isinstance(value, str) and value.strip().upper() in {"EVEN", "EV", "EVS"}:
        return 100
    result = number(value)
    if result is None or not result.is_integer() or abs(result) < 100:
        return None
    # The storage column is a signed BIGINT. Do not silently overflow it.
    if not -(2**63) <= result < 2**63:
        return None
    return int(result)


def mapping(value: Any) -> dict:
    return value if isinstance(value, dict) else {}


def nested_value(container: Any, field_name: str) -> Any:
    return mapping(mapping(container).get(field_name)).get("american")


def first_present(*values: Any) -> Any:
    return next((v for v in values if v is not None and v != ""), None)


@dataclass
class RawResponse:
    response_id: str
    run_id: str
    source: str
    url: str
    requested_at: datetime
    received_at: datetime
    attempt: int
    status_code: int | None
    headers_json: str
    body: bytes
    sha256: str
    error_kind: str | None


@dataclass
class Event:
    event_id: str
    competition_id: str
    commence_time: datetime | None
    state: str
    home_team_id: str | None
    away_team_id: str | None
    home_team: str | None
    away_team: str | None
    event_response_id: str


@dataclass
class OddsRow:
    snapshot_id: str
    run_id: str
    response_id: str
    event_response_id: str
    observed_at: datetime
    source_updated_at: datetime | None
    source: str
    league: str
    event_id: str
    competition_id: str
    commence_time: datetime
    event_state: str
    observation_kind: str
    home_team_id: str | None
    away_team_id: str | None
    home_team: str | None
    away_team: str | None
    book_id: str | None
    book: str
    market: str
    period: str
    settlement_rules: str
    side: str
    line: float | None
    price: int | None
    price_status: str
    quote_fields: str
    availability_verified: bool
    parser_version: str


@dataclass
class Issue:
    issue_id: str
    run_id: str
    recorded_at: datetime
    source: str
    severity: str
    code: str
    event_id: str | None
    response_id: str | None
    message: str


DDL = """
CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS raw_responses (
    response_id VARCHAR PRIMARY KEY, run_id VARCHAR NOT NULL,
    source VARCHAR NOT NULL, url VARCHAR NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL, received_at TIMESTAMPTZ NOT NULL,
    attempt INTEGER NOT NULL, status_code INTEGER, headers_json VARCHAR,
    body BLOB NOT NULL, sha256 VARCHAR NOT NULL, error_kind VARCHAR
);
CREATE TABLE IF NOT EXISTS odds_snapshots (
    snapshot_id VARCHAR PRIMARY KEY, run_id VARCHAR NOT NULL,
    response_id VARCHAR NOT NULL, event_response_id VARCHAR NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL, source_updated_at TIMESTAMPTZ,
    source VARCHAR NOT NULL, league VARCHAR NOT NULL,
    event_id VARCHAR NOT NULL, competition_id VARCHAR NOT NULL,
    commence_time TIMESTAMPTZ NOT NULL, event_state VARCHAR NOT NULL,
    observation_kind VARCHAR NOT NULL,
    home_team_id VARCHAR, away_team_id VARCHAR, home_team VARCHAR, away_team VARCHAR,
    book_id VARCHAR, book VARCHAR NOT NULL, market VARCHAR NOT NULL,
    period VARCHAR NOT NULL, settlement_rules VARCHAR NOT NULL, side VARCHAR NOT NULL,
    line DOUBLE, price BIGINT, price_status VARCHAR NOT NULL,
    quote_fields VARCHAR NOT NULL, availability_verified BOOLEAN NOT NULL,
    parser_version VARCHAR NOT NULL,
    CHECK (price IS NULL OR price <= -100 OR price >= 100),
    CHECK (price IS NULL OR price_status = 'present'),
    CHECK (observation_kind IN ('pregame_observation', 'historical_backfill'))
);
CREATE TABLE IF NOT EXISTS poll_issues (
    issue_id VARCHAR PRIMARY KEY, run_id VARCHAR NOT NULL,
    recorded_at TIMESTAMPTZ NOT NULL, source VARCHAR NOT NULL,
    severity VARCHAR NOT NULL, code VARCHAR NOT NULL,
    event_id VARCHAR, response_id VARCHAR, message VARCHAR NOT NULL
);
CREATE TABLE IF NOT EXISTS poll_runs (
    run_id VARCHAR PRIMARY KEY, started_at TIMESTAMPTZ NOT NULL,
    finished_at TIMESTAMPTZ NOT NULL, status VARCHAR NOT NULL,
    exit_code INTEGER NOT NULL, config_json VARCHAR NOT NULL, summary_json VARCHAR NOT NULL
);
CREATE VIEW IF NOT EXISTS odds_snapshots_with_raw AS
    SELECT s.*, r.body AS raw, r.url AS raw_url
    FROM odds_snapshots s JOIN raw_responses r USING(response_id);
"""


class MemoryStore:
    """Dry runs retain data in memory and create no directories or files."""
    def __init__(self) -> None:
        self.raw: list[RawResponse] = []
        self.issues: list[Issue] = []
        self.rows: list[OddsRow] = []
        self.summary: dict = {}

    def add_raw(self, response: RawResponse) -> None:
        self.raw.append(response)

    def add_issue(self, issue: Issue) -> None:
        self.issues.append(issue)

    def finish(self, rows: list[OddsRow], summary: dict, config: dict) -> None:
        self.rows.extend(rows)
        self.summary = summary

    def close(self) -> None:
        pass


class DuckStore:
    """One writer. Raw responses and issues commit before normalization."""
    def __init__(self, path: Path) -> None:
        import duckdb
        path.parent.mkdir(parents=True, exist_ok=True)
        self.con = duckdb.connect(str(path))
        try:
            tables = {r[0] for r in self.con.execute("SHOW TABLES").fetchall()}
            if tables and "schema_meta" not in tables:
                raise ValueError("Unversioned/legacy database: use a new v4 database; do not mix v3 rows.")
            if "schema_meta" in tables:
                versions = self.con.execute("SELECT version FROM schema_meta").fetchall()
                if versions != [(SCHEMA_VERSION,)]:
                    raise ValueError("Unsupported database schema version; use a separate v4 database.")
            self.con.execute("BEGIN TRANSACTION")
            self.con.execute(DDL)
            if "schema_meta" not in tables:
                self.con.execute("INSERT INTO schema_meta VALUES (?)", [SCHEMA_VERSION])
            self.con.execute("COMMIT")
        except Exception:
            self.con.close()
            raise

    def insert_dataclass(self, table: str, obj: Any) -> None:
        values = asdict(obj)
        columns = ",".join(values)
        marks = ",".join("?" for _ in values)
        self.con.execute(f"INSERT INTO {table} ({columns}) VALUES ({marks})", list(values.values()))

    def add_raw(self, response: RawResponse) -> None:
        self.insert_dataclass("raw_responses", response)

    def add_issue(self, issue: Issue) -> None:
        self.insert_dataclass("poll_issues", issue)

    def finish(self, rows: list[OddsRow], summary: dict, config: dict) -> None:
        self.con.execute("BEGIN TRANSACTION")
        try:
            if rows:
                columns = list(asdict(rows[0]))
                self.con.executemany(
                    f"INSERT INTO odds_snapshots ({','.join(columns)}) VALUES ({','.join('?' for _ in columns)})",
                    [list(asdict(row).values()) for row in rows],
                )
            self.con.execute(
                "INSERT INTO poll_runs VALUES (?,?,?,?,?,?,?)",
                [summary["run_id"], summary["started_at"], summary["finished_at"],
                 summary["status"], summary["exit_code"], json.dumps(config), json.dumps(summary)],
            )
            self.con.execute("COMMIT")
        except Exception:
            self.con.execute("ROLLBACK")
            raise

    def close(self) -> None:
        self.con.close()


@dataclass
class Context:
    store: Any
    league: str
    mode: str
    window_start: datetime
    window_end: datetime
    pregame_buffer: int = 60
    run_id: str = field(default_factory=new_id)
    started_at: datetime = field(default_factory=utcnow)
    rows: list[OddsRow] = field(default_factory=list)
    errors: int = 0
    warnings: int = 0
    stats: dict[str, dict[str, int]] = field(default_factory=dict)

    def count(self, source: str, name: str, amount: int = 1) -> None:
        stats = self.stats.setdefault(source, {})
        stats[name] = stats.get(name, 0) + amount

    def issue(self, source: str, code: str, message: str, *, event_id: str | None = None,
              response_id: str | None = None, severity: str = "error") -> None:
        if severity == "error":
            self.errors += 1
        else:
            self.warnings += 1
        self.store.add_issue(Issue(new_id(), self.run_id, utcnow(), source, severity,
                                   code, event_id, response_id, message))
        LOG.warning("%s %s event=%s: %s", source, code, event_id or "-", message)

    def eligible(self, event: Event, at: datetime) -> bool:
        if event.commence_time is None:
            return False
        if not self.window_start <= event.commence_time < self.window_end:
            return False
        if self.mode == "historical":
            return True
        return (event.state == "pre" and
                event.commence_time > at + timedelta(seconds=self.pregame_buffer))


@dataclass
class FetchResult:
    data: Any
    response_id: str
    received_at: datetime
    status_code: int


def http_request(url: str, headers: dict[str, str], timeout: float) -> tuple[int, dict, bytes]:
    request = Request(url, headers=headers)
    try:
        with urlopen(request, timeout=timeout) as response:
            return response.status, dict(response.headers.items()), response.read()
    except HTTPError as error:
        with error:
            return error.code, dict(error.headers.items()), error.read()


class HttpClient:
    def __init__(self, context: Context, *, cfbd_key: str | None = None,
                 delay: float = 0.6, retries: int = 3, timeout: float = 20,
                 request_fn: Callable = http_request, sleep_fn: Callable = time.sleep,
                 clock: Callable = utcnow, request_budget: int = 1000) -> None:
        self.ctx, self.cfbd_key = context, cfbd_key
        self.delay, self.retries, self.timeout = delay, retries, timeout
        self.request_fn, self.sleep, self.clock = request_fn, sleep_fn, clock
        self.request_budget, self.requests = request_budget, 0

    def fetch(self, url: str, source: str, params: dict | None = None,
              allow_404: bool = False) -> FetchResult | None:
        parts = urlsplit(url)
        allowed = ESPN_HOSTS if source == "espn" else {"api.collegefootballdata.com"}
        if parts.hostname not in allowed or parts.scheme not in {"http", "https"} or parts.username:
            self.ctx.issue(source, "invalid_reference", "Refused a reference outside the source hosts.")
            return None
        url = urlunsplit(("https", parts.netloc, parts.path, parts.query, ""))
        if params:
            url += ("&" if "?" in url else "?") + urlencode(params)
        headers = {"User-Agent": f"odds-poller/{VERSION} (personal research)", "Accept": "application/json"}
        if source == "espn":
            headers.update(ESPN_BROWSER_HEADERS)
        elif source == "cfbd" and self.cfbd_key:
            headers["Authorization"] = f"Bearer {self.cfbd_key}"

        for attempt in range(1, self.retries + 1):
            if self.requests >= self.request_budget:
                self.ctx.issue(source, "request_budget", "Request budget exhausted; collection is incomplete.")
                return None
            if self.requests:
                self.sleep(self.delay)
            self.requests += 1
            self.ctx.count(source, "requests")
            started = self.clock()
            error_kind = None
            try:
                status, response_headers, body = self.request_fn(url, headers, self.timeout)
            except (URLError, TimeoutError, OSError) as error:
                status, response_headers, body = None, {}, b""
                error_kind = type(error).__name__
            received = self.clock()
            safe_headers = {k.lower(): str(v) for k, v in response_headers.items()
                            if k.lower() in {"date", "age", "cache-control", "content-type", "etag",
                                             "last-modified", "retry-after"}}
            raw = RawResponse(new_id(), self.ctx.run_id, source, url, started, received,
                              attempt, status, json.dumps(safe_headers), body,
                              hashlib.sha256(body).hexdigest(), error_kind)
            # Autocommit the complete bytes BEFORE attempting JSON/schema parsing.
            self.ctx.store.add_raw(raw)
            if status is not None and 200 <= status < 300:
                try:
                    data = json.loads(body)
                except (ValueError, UnicodeError):
                    self.ctx.issue(source, "non_json", "Response is not valid JSON; full bytes retained.",
                                   response_id=raw.response_id)
                    return None
                return FetchResult(data, raw.response_id, received, status)
            if status == 404 and allow_404:
                self.ctx.count(source, "odds_not_found")
                return None
            retryable = status is None or status == 429 or (status is not None and status >= 500)
            if retryable and attempt < self.retries:
                wait = float(2 ** (attempt - 1))
                retry_after = safe_headers.get("retry-after")
                if retry_after:
                    try:
                        wait = max(wait, float(retry_after))
                    except ValueError:
                        try:
                            wait = max(wait, (parsedate_to_datetime(retry_after) - received).total_seconds())
                        except (TypeError, ValueError):
                            pass
                if not math.isfinite(wait) or wait > 30:
                    self.ctx.issue(source, "retry_deferred", "Server requested a long retry delay; retry on a later run.",
                                   response_id=raw.response_id)
                    return None
                self.sleep(max(0, wait))
                continue
            self.ctx.issue(source, "fetch_failed", f"HTTP status={status}; transport={error_kind or 'none'}.",
                           response_id=raw.response_id)
            return None
        return None


def parse_price(ctx: Context, source: str, value: Any, event: Event, response_id: str) -> int | None:
    if value is None or value == "" or number(value) == 0:
        return None
    result = american_price(value)
    if result is None:
        ctx.issue(source, "invalid_price", "Rejected a non-integer or non-American price; raw retained.",
                  event_id=event.event_id, response_id=response_id)
    return result


def row_base(ctx: Context, event: Event, result: FetchResult, source: str,
             book: str, book_id: str | None) -> dict:
    return dict(run_id=ctx.run_id, response_id=result.response_id,
                event_response_id=event.event_response_id, observed_at=result.received_at,
                source_updated_at=None, source=source, league=ctx.league,
                event_id=event.event_id, competition_id=event.competition_id,
                commence_time=event.commence_time, event_state=event.state,
                observation_kind="historical_backfill" if ctx.mode == "historical" else "pregame_observation",
                home_team_id=event.home_team_id, away_team_id=event.away_team_id,
                home_team=event.home_team, away_team=event.away_team,
                book_id=book_id, book=book, period="full_game",
                settlement_rules="provider_rules_unverified", availability_verified=False,
                parser_version=VERSION)


def make_row(base: dict, market: str, side: str, line: float | None,
             price: int | None, quote_fields: str) -> OddsRow:
    return OddsRow(snapshot_id=new_id(), **base, market=market, side=side, line=line,
                   price=price, price_status="present" if price is not None else "missing",
                   quote_fields=quote_fields)


def parse_espn_odds_item(item: dict, event: Event, result: FetchResult, ctx: Context) -> list[OddsRow]:
    """Use current fields or their top-level aliases. NEVER use open/close as current."""
    provider = mapping(item.get("provider"))
    book = provider.get("name") or provider.get("displayName")
    if not isinstance(book, str) or not book:
        ctx.issue("espn", "missing_provider", "Cannot identify the quote provider.",
                  event_id=event.event_id, response_id=result.response_id)
        return []
    if "live" in book.lower():
        ctx.count("espn", "live_providers_skipped")
        return []
    if not any(k in item for k in ("spread", "overUnder", "homeTeamOdds", "awayTeamOdds", "current")):
        ctx.issue("espn", "unsupported_odds", "Unrecognized provider odds schema; raw retained.",
                  event_id=event.event_id, response_id=result.response_id)
        return []
    base = row_base(ctx, event, result, "espn", book, str(provider["id"]) if provider.get("id") is not None else None)
    rows: list[OddsRow] = []
    home, away = mapping(item.get("homeTeamOdds")), mapping(item.get("awayTeamOdds"))
    hc, ac = mapping(home.get("current")), mapping(away.get("current"))
    raw_hline, raw_aline = nested_value(hc, "pointSpread"), nested_value(ac, "pointSpread")
    hline, aline = number(raw_hline), number(raw_aline)
    spread_fields = "current"
    invalid_spread = any(v is not None and v != "" and number(v) is None for v in (raw_hline, raw_aline))
    if invalid_spread:
        ctx.issue("espn", "invalid_handicap", "Malformed current handicap; spread rejected without fallback.",
                  event_id=event.event_id, response_id=result.response_id)
        hline = aline = None
    elif hline is None and aline is None:
        hline = number(item.get("spread"))
        # ESPN's top-level spread is home-oriented in the verified schema.
        aline = -hline if hline is not None else None
        spread_fields = "top_level"
    elif hline is None:
        hline = -aline
    elif aline is None:
        aline = -hline
    if hline is not None and aline is not None:
        if not math.isclose(hline, -aline, abs_tol=1e-8):
            ctx.issue("espn", "spread_pair_mismatch", "Home and away handicaps are not opposites; spread rejected.",
                      event_id=event.event_id, response_id=result.response_id)
        else:
            for side, team, current, handicap in (("home", home, hc, hline), ("away", away, ac, aline)):
                raw_price = first_present(nested_value(current, "spread"), team.get("spreadOdds"))
                price = parse_price(ctx, "espn", raw_price, event, result.response_id)
                rows.append(make_row(base, "spread", side, handicap, price, f"{spread_fields};current.spread|spreadOdds"))
    current = mapping(item.get("current"))
    total = number(first_present(nested_value(current, "total"), item.get("overUnder")))
    if total is not None:
        if total <= 0:
            ctx.issue("espn", "invalid_total", "Nonpositive total rejected.", event_id=event.event_id,
                      response_id=result.response_id)
        else:
            for side in ("over", "under"):
                value = first_present(nested_value(current, side), item.get(f"{side}Odds"))
                price = parse_price(ctx, "espn", value, event, result.response_id)
                rows.append(make_row(base, "total", side, total, price, "current|top_level"))
    for side, team, current in (("home", home, hc), ("away", away, ac)):
        value = first_present(nested_value(current, "moneyLine"), team.get("moneyLine"))
        price = parse_price(ctx, "espn", value, event, result.response_id)
        if price is not None:
            rows.append(make_row(base, "moneyline", side, None, price, "current.moneyLine|moneyLine"))
    return rows


def espn_event(ev: dict, competition: dict, response_id: str) -> Event | None:
    if not ev.get("id") or not competition.get("id"):
        return None
    teams = {c.get("homeAway"): mapping(c.get("team")) for c in competition.get("competitors", [])
             if isinstance(c, dict)}
    home, away = teams.get("home", {}), teams.get("away", {})
    status = mapping(competition.get("status")) or mapping(ev.get("status"))
    status_type = mapping(status.get("type"))
    state = status_type.get("state", "unknown")
    if status_type.get("completed"):
        state = "post"
    elif status_type.get("name") in {"STATUS_POSTPONED", "STATUS_CANCELED", "STATUS_CANCELLED",
                                     "STATUS_SUSPENDED", "STATUS_DELAYED", "STATUS_TBD"}:
        state = "unavailable"
    if not home or not away:
        return None
    return Event(str(ev["id"]), str(competition["id"]),
                 timestamp(competition.get("date") or ev.get("date")), str(state),
                 str(home["id"]) if home.get("id") is not None else None,
                 str(away["id"]) if away.get("id") is not None else None,
                 home.get("displayName"), away.get("displayName"), response_id)


def espn_items(client: HttpClient, event: Event) -> list[tuple[dict, FetchResult]]:
    ctx = client.ctx
    sport, league, _ = LEAGUES[ctx.league]
    url = f"{CORE_API}/{sport}/leagues/{league}/events/{event.event_id}/competitions/{event.competition_id}/odds"
    resolved: list[tuple[dict, FetchResult]] = []
    page = 1
    seen_refs: set[str] = set()
    while page <= 100:
        result = client.fetch(url, "espn", {"page": page, "limit": 100}, allow_404=True)
        if result is None:
            break
        data = result.data
        if not isinstance(data, dict) or not isinstance(data.get("items"), list):
            ctx.issue("espn", "odds_schema", "Odds response has no items list.",
                      event_id=event.event_id, response_id=result.response_id)
            break
        # An unpriced game is a valid empty collection, not a provider fault: ESPN answers
        # {"count":0,"pageIndex":0,"pageCount":0,"items":[]}. That pageIndex of 0 must be
        # recognised here, before the pagination check below reads it as a rejected page —
        # roughly 40% of an NCAAF slate is unpriced, so treating it as an error pins every
        # run at exit code 2 and destroys the signal that monitoring depends on.
        if (page == 1 and not data["items"] and data.get("count", 0) == 0
                and data.get("pageCount", 1) == 0):
            ctx.count("espn", "events_without_odds")
            break
        if data.get("pageIndex", page) != page:
            ctx.issue("espn", "pagination", "Provider ignored the requested odds page.",
                      event_id=event.event_id, response_id=result.response_id)
            break
        for item in data["items"]:
            try:
                if not isinstance(item, dict):
                    raise ValueError("Provider item is not an object.")
                original_result = result
                if "$ref" in item and not any(k in item for k in ("spread", "overUnder", "homeTeamOdds", "awayTeamOdds", "bettingOdds", "current")):
                    ref = item["$ref"]
                    if not isinstance(ref, str):
                        raise ValueError("Invalid odds reference.")
                    if ref in seen_refs:
                        continue
                    seen_refs.add(ref)
                    detail = client.fetch(ref, "espn")
                    if detail is None:
                        continue
                    item, original_result = detail.data, detail
                    if not isinstance(item, dict):
                        raise ValueError("Resolved odds item is not an object.")
                provider = mapping(item.get("provider"))
                if not (provider.get("name") or provider.get("displayName")) and isinstance(provider.get("$ref"), str):
                    detail = client.fetch(provider["$ref"], "espn")
                    if detail is None:
                        continue
                    item = {**item, "provider": detail.data}
                resolved.append((item, original_result))
            except (TypeError, ValueError, AttributeError) as error:
                ctx.issue("espn", "provider_schema", str(error), event_id=event.event_id,
                          response_id=result.response_id)
        page_count = data.get("pageCount", 1)
        if page == 1 and page_count == 0 and data.get("count", 0) == 0 and not data["items"]:
            # ESPN can represent a valid empty collection with zero pages.
            break
        if not isinstance(page_count, int) or page_count < 1:
            ctx.issue("espn", "pagination", "Invalid odds page count.", response_id=result.response_id)
            break
        if page >= page_count:
            break
        page += 1
    else:
        ctx.issue("espn", "pagination_limit", "Too many odds pages; collection incomplete.", event_id=event.event_id)
    return resolved


def poll_espn(client: HttpClient, start_date: date, days: int, max_events: int | None = None) -> None:
    ctx = client.ctx
    sport, league, group = LEAGUES[ctx.league]
    seen: set[tuple[str, str]] = set()
    selected = 0
    for offset in range(days):
        params: dict[str, Any] = {"dates": (start_date + timedelta(days=offset)).strftime("%Y%m%d"),
                                  "limit": SCOREBOARD_LIMIT}
        if group:
            params["groups"] = group
        result = client.fetch(f"{SITE_API}/{sport}/{league}/scoreboard", "espn", params)
        if result is None:
            continue
        if not isinstance(result.data, dict) or not isinstance(result.data.get("events"), list):
            ctx.issue("espn", "scoreboard_schema", "Scoreboard has no events list.", response_id=result.response_id)
            continue
        events = result.data["events"]
        if len(events) >= params["limit"]:
            ctx.issue("espn", "scoreboard_limit", "Scoreboard reached the request limit; coverage needs review.",
                      response_id=result.response_id)
        # The silent-degradation signature: ESPN answers an over-large limit with a small
        # curated default instead of an error, so a truncated slate looks like a quiet day.
        # Anything at or under this count on a football Saturday means coverage is suspect.
        if len(events) == DEGRADED_SCOREBOARD_COUNT:
            ctx.issue("espn", "scoreboard_degraded",
                      f"Scoreboard returned exactly {DEGRADED_SCOREBOARD_COUNT} events, the known "
                      "degraded-default size; treat this date's coverage as incomplete.",
                      response_id=result.response_id, severity="warning")
        for ev in events:
            ctx.count("espn", "events_discovered")
            try:
                if not isinstance(ev, dict) or not isinstance(ev.get("competitions"), list):
                    raise ValueError("Event has no competitions list.")
                for competition in ev["competitions"]:
                    event = espn_event(ev, competition, result.response_id)
                    if event is None or event.commence_time is None:
                        raise ValueError("Event lacks IDs, two teams, or a timezone-aware start time.")
                    key = (event.event_id, event.competition_id)
                    if key in seen:
                        continue
                    seen.add(key)
                    if not ctx.eligible(event, result.received_at):
                        ctx.count("espn", "events_out_of_scope")
                        continue
                    ctx.count("espn", "events_eligible")
                    if max_events is not None and selected >= max_events:
                        ctx.count("espn", "events_sampled_out")
                        continue
                    selected += 1
                    ctx.count("espn", "events_polled")
                    before = len(ctx.rows)
                    for item, quote_result in espn_items(client, event):
                        # A game may start during a long collection run.
                        if not ctx.eligible(event, quote_result.received_at):
                            ctx.count("espn", "quotes_after_cutoff")
                            continue
                        try:
                            ctx.rows.extend(parse_espn_odds_item(item, event, quote_result, ctx))
                        except (TypeError, ValueError, AttributeError, OverflowError) as error:
                            ctx.issue("espn", "parse_failed", str(error), event_id=event.event_id,
                                      response_id=quote_result.response_id)
                    ctx.count("espn", "events_with_rows", int(len(ctx.rows) > before))
            except (TypeError, ValueError, AttributeError) as error:
                ctx.issue("espn", "event_schema", str(error), response_id=result.response_id)


def poll_cfbd(client: HttpClient, year: int, week: int, season_type: str,
              max_events: int | None = None) -> None:
    ctx = client.ctx
    result = client.fetch(CFBD_API, "cfbd", {"year": year, "week": week, "seasonType": season_type})
    if result is None:
        return
    if not isinstance(result.data, list):
        ctx.issue("cfbd", "lines_schema", "CFBD response is not a game list.", response_id=result.response_id)
        return
    selected = 0
    seen: set[str] = set()
    for game in result.data:
        ctx.count("cfbd", "events_discovered")
        try:
            if not isinstance(game, dict) or game.get("id") is None:
                raise ValueError("CFBD game has no ID.")
            event_id = str(game["id"])
            if event_id in seen:
                continue
            seen.add(event_id)
            start = timestamp(game.get("startDate"))
            # CFBD /lines has no authoritative live status. Future schedule only.
            state = "pre" if start and start > result.received_at else "unknown"
            event = Event(event_id, event_id, start, state,
                          str(game["homeTeamId"]) if game.get("homeTeamId") is not None else None,
                          str(game["awayTeamId"]) if game.get("awayTeamId") is not None else None,
                          game.get("homeTeam"), game.get("awayTeam"), result.response_id)
            if start is None or not event.home_team or not event.away_team:
                raise ValueError("CFBD game lacks teams or a timezone-aware start time.")
            if not ctx.eligible(event, result.received_at):
                ctx.count("cfbd", "events_out_of_scope")
                continue
            ctx.count("cfbd", "events_eligible")
            if max_events is not None and selected >= max_events:
                ctx.count("cfbd", "events_sampled_out")
                continue
            selected += 1
            ctx.count("cfbd", "events_polled")
            lines = game.get("lines")
            if not isinstance(lines, list):
                raise ValueError("CFBD game has no lines list.")
            before = len(ctx.rows)
            for line in lines:
                try:
                    if not isinstance(line, dict) or not isinstance(line.get("provider"), str) or not line["provider"]:
                        raise ValueError("CFBD line lacks a provider name.")
                    base = row_base(ctx, event, result, "cfbd", line["provider"], None)
                    spread, total = number(line.get("spread")), number(line.get("overUnder"))
                    if spread is not None:
                        for side, handicap in (("home", spread), ("away", -spread)):
                            ctx.rows.append(make_row(base, "spread", side, handicap, None, "spread;price_unavailable"))
                    if total is not None and total > 0:
                        for side in ("over", "under"):
                            ctx.rows.append(make_row(base, "total", side, total, None, "overUnder;price_unavailable"))
                    elif total is not None:
                        raise ValueError("CFBD total is nonpositive.")
                    for side in ("home", "away"):
                        price = parse_price(ctx, "cfbd", line.get(f"{side}Moneyline"), event, result.response_id)
                        if price is not None:
                            ctx.rows.append(make_row(base, "moneyline", side, None, price, f"{side}Moneyline"))
                except (TypeError, ValueError, AttributeError) as error:
                    ctx.issue("cfbd", "provider_schema", str(error), event_id=event_id,
                              response_id=result.response_id)
            ctx.count("cfbd", "events_with_rows", int(len(ctx.rows) > before))
        except (TypeError, ValueError, AttributeError) as error:
            ctx.issue("cfbd", "event_schema", str(error), response_id=result.response_id)


def summarize(ctx: Context, sources: list[str], min_rows: int, sampled: bool) -> dict:
    for source in sources:
        rows = [row for row in ctx.rows if row.source == source]
        ctx.count(source, "rows", len(rows))
        ctx.count(source, "priced_rows", sum(row.price is not None for row in rows))
        ctx.count(source, "books", len({row.book for row in rows}))
    enough = all(ctx.stats[source].get("rows", 0) >= min_rows for source in sources)
    code = 2 if ctx.errors else (0 if enough else 3)
    return {"type": "summary", "version": VERSION, "run_id": ctx.run_id,
            "started_at": ctx.started_at.isoformat(), "finished_at": utcnow().isoformat(),
            "status": "incomplete" if ctx.errors else ("ok" if enough else "no_data"),
            "exit_code": code, "errors": ctx.errors, "warnings": ctx.warnings,
            "rows": len(ctx.rows), "sampled_run": sampled, "mode": ctx.mode,
            "sources": ctx.stats,
            "limitations": ["feed freshness and account availability unverified",
                            "settlement rules require market-specific verification",
                            "source_updated_at unknown; observed_at is receipt time"]}


def main(argv: list[str] | None = None, *, request_fn: Callable = http_request,
         sleep_fn: Callable = time.sleep) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--league", required=True, choices=sorted(LEAGUES))
    parser.add_argument("--source", choices=["espn", "cfbd", "both"], default="espn")
    parser.add_argument("--days", type=int, default=2)
    parser.add_argument("--start-date", type=date.fromisoformat, help="YYYY-MM-DD in --timezone")
    parser.add_argument("--timezone", default="America/Detroit")
    parser.add_argument("--mode", choices=["pregame", "historical"], default="pregame")
    parser.add_argument("--pregame-buffer-seconds", type=int, default=60)
    parser.add_argument("--db", type=Path, default=Path("data/warehouse-v4.duckdb"))
    parser.add_argument("--postgres", action="store_true",
                        help="Write to the Postgres URL in DATABASE_URL instead of --db. "
                             "The URL is read from the environment, never from argv, so "
                             "credentials stay out of shell history and process lists.")
    parser.add_argument("--cfbd-year", type=int)
    parser.add_argument("--cfbd-week", type=int)
    parser.add_argument("--cfbd-season-type", choices=["regular", "postseason"], default="regular")
    parser.add_argument("--max-events", type=int, help="Explicit sample limit per source, for smoke checks only")
    parser.add_argument("--max-requests", type=int, default=1000)
    parser.add_argument("--min-rows", type=int, default=1, help="Minimum normalized rows per selected source")
    parser.add_argument("--dry-run", action="store_true", help="No filesystem writes; print both sources' previews")
    parser.add_argument("--preview-rows", type=int, default=12)
    args = parser.parse_args(argv)
    if not 1 <= args.days <= 31:
        parser.error("--days must be between 1 and 31")
    if args.pregame_buffer_seconds < 0 or args.min_rows < 1 or args.preview_rows < 1 or args.max_requests < 1:
        parser.error("buffer must be nonnegative; min-rows, preview-rows and max-requests must be positive")
    if args.max_events is not None and args.max_events < 1:
        parser.error("--max-events must be positive")
    try:
        local_zone = ZoneInfo(args.timezone)
    except ZoneInfoNotFoundError:
        parser.error("Timezone unavailable. Install requirements.txt (includes tzdata) or choose --timezone UTC.")
    start_date = args.start_date or utcnow().astimezone(local_zone).date()
    if args.mode == "pregame" and start_date < utcnow().astimezone(local_zone).date():
        parser.error("Past --start-date requires --mode historical; backfills are not historical observations")
    sources = ["espn", "cfbd"] if args.source == "both" else [args.source]
    cfbd_key = os.environ.get("CFBD_KEY")
    if "cfbd" in sources:
        if args.league != "ncaaf":
            parser.error("CFBD supports --league ncaaf only")
        if not cfbd_key:
            parser.error("Set CFBD_KEY in the environment; do not put API keys in command arguments")
        if args.cfbd_year is None or args.cfbd_week is None:
            parser.error("CFBD requires an explicit --cfbd-year and --cfbd-week")
        if not 1900 <= args.cfbd_year <= 2100 or not 1 <= args.cfbd_week <= 30:
            parser.error("Invalid CFBD season year/week")
    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s")
    logging.Formatter.converter = time.gmtime
    store: Any = None
    try:
        if args.dry_run:
            store = MemoryStore()
        elif args.postgres:
            from pg_store import PostgresStore
            database_url = os.environ.get("DATABASE_URL")
            if not database_url:
                parser.error("--postgres requires DATABASE_URL in the environment")
            store = PostgresStore(database_url)
        else:
            store = DuckStore(args.db)
        ctx = Context(store, args.league, args.mode,
                      datetime.combine(start_date, day_time.min, local_zone).astimezone(UTC),
                      datetime.combine(start_date + timedelta(days=args.days), day_time.min, local_zone).astimezone(UTC),
                      args.pregame_buffer_seconds)
        client = HttpClient(ctx, cfbd_key=cfbd_key, request_fn=request_fn, sleep_fn=sleep_fn,
                            request_budget=args.max_requests)
        for source in sources:
            if source == "espn":
                poll_espn(client, start_date, args.days, args.max_events)
            else:
                poll_cfbd(client, args.cfbd_year, args.cfbd_week, args.cfbd_season_type, args.max_events)
        summary = summarize(ctx, sources, args.min_rows, args.max_events is not None)
        config = {**vars(args), "db": str(args.db), "start_date": start_date.isoformat()}
        if args.dry_run:
            for source in sources:
                for row in [r for r in ctx.rows if r.source == source][:args.preview_rows]:
                    print(json.dumps({"type": "preview", **asdict(row)}, default=str))
        store.finish(ctx.rows, summary, config)
        print(json.dumps(summary))
        return summary["exit_code"]
    except KeyboardInterrupt:
        LOG.error("Interrupted. Already committed raw responses are retained; run may have no final summary.")
        return 130
    except Exception as error:
        # Never print request headers or secrets. Full raw may exist even if finalization failed.
        LOG.error("Collector failed (%s). Check database access, dependencies and schema; no success reported.",
                  type(error).__name__)
        if isinstance(error, (ImportError, ValueError)):
            LOG.error("%s", error)
        return 2
    finally:
        if store is not None:
            store.close()


if __name__ == "__main__":
    raise SystemExit(main())
