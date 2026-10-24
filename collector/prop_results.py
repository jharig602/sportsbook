"""Settle player-prop legs from the game's box score.

A prop leg (`bets.market = 'prop'`, v26) is decided by a player's stat, which no final
score carries. Once a game is final this reads ESPN's box score for it and writes each
waiting leg's result to `leg_results` with source 'boxscore' -- the table the ledger joins
in, so `bets` itself is never edited.

Refuses rather than guesses, at every fork:

* A leg with ANY result already recorded is left alone. A tap on the Bets page is the
  owner's call and a box score never overrides it.
* Names must match exactly once normalised (case, punctuation and Jr/Sr/II/III dropped).
  Two players normalising alike in one game is ambiguous and skipped.
* A player not in the box score is left pending, not voided: "did not play" and "the
  name is spelled differently" look identical from here, and only one of them is a void.
* First-TD legs are left for a tap -- the box score does not say who scored first.

Public Actions logs: the summary is counts only.
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import time
import uuid
from datetime import datetime, timezone
from typing import Any, Callable

from db import Database, clean_database_url
from odds_poller import ESPN_BROWSER_HEADERS, SITE_API, http_request
from schema import ensure_analytics_schema

LOG = logging.getLogger("prop_results")
UTC = timezone.utc
LEAGUE_PATH = {"nfl": "football/nfl", "ncaaf": "football/college-football"}
SUFFIXES = {"jr", "sr", "ii", "iii", "iv", "v"}


def normalise(name: str | None) -> str:
    """Letters and digits only, suffixes dropped: "Amon-Ra St. Brown", "Amon Ra St Brown"
    and "AmonRa St.Brown" are one key, as are "Marvin Harrison Jr." and "Marvin Harrison"."""
    words = re.sub(r"[^a-z0-9 ]+", " ", (name or "").lower().replace("'", "").replace("’", "")).split()
    return "".join(w for w in words if w not in SUFFIXES)


def _number(text: Any) -> float:
    try:
        return float(str(text).replace(",", ""))
    except (TypeError, ValueError):
        return 0.0


def box_stats(summary: dict) -> dict[str, dict[str, float]]:
    """Normalised player name -> the stats props ask about. Names that collide are dropped."""
    out: dict[str, dict[str, float]] = {}
    seen_ids: dict[str, set[str]] = {}
    for team in (summary.get("boxscore") or {}).get("players") or []:
        for category in team.get("statistics") or []:
            labels = category.get("labels") or []
            name = category.get("name")
            for athlete in category.get("athletes") or []:
                who = athlete.get("athlete") or {}
                key = normalise(who.get("displayName"))
                if not key:
                    continue
                seen_ids.setdefault(key, set()).add(str(who.get("id") or who.get("displayName")))
                values = dict(zip(labels, athlete.get("stats") or []))
                s = out.setdefault(key, {})
                if name == "passing":
                    s["pass_yds"] = _number(values.get("YDS"))
                    s["pass_tds"] = _number(values.get("TD"))
                elif name == "rushing":
                    s["rush_yds"] = _number(values.get("YDS"))
                    s["rush_tds"] = _number(values.get("TD"))
                elif name == "receiving":
                    s["receptions"] = _number(values.get("REC"))
                    s["rec_yds"] = _number(values.get("YDS"))
                    s["rec_tds"] = _number(values.get("TD"))
                elif name in ("kickReturns", "puntReturns"):
                    s[f"{name}_tds"] = _number(values.get("TD"))
    # Two different players under one normalised name: neither can be trusted.
    for key, ids in seen_ids.items():
        if len(ids) > 1:
            out.pop(key, None)
    return out


def stat_value(stats: dict[str, float], stat: str) -> float | None:
    """The number a prop on `stat` is settled against, or None when the box cannot say."""
    if stat == "first_td":
        return None
    if stat == "anytime_td":
        # Scored himself: rushing, receiving or a return. A passing TD is the receiver's.
        return sum(stats.get(k, 0.0) for k in ("rush_tds", "rec_tds", "kickReturns_tds", "puntReturns_tds"))
    if stat == "rush_rec_yds":
        return stats.get("rush_yds", 0.0) + stats.get("rec_yds", 0.0)
    if stat in ("pass_yds", "pass_tds", "rush_yds", "rec_yds", "receptions"):
        return stats.get(stat, 0.0)
    return None


def decide(value: float, side: str, line: float) -> str:
    if value == line:
        return "push"
    if side == "over":
        return "won" if value > line else "lost"
    return "won" if value < line else "lost"


WAITING = """
SELECT b.bet_id, b.owner_id, b.league, b.event_id, b.side, b.line, b.prop_player, b.prop_stat
  FROM bets b
  JOIN game_results r ON r.event_id = b.event_id AND r.completed
 WHERE b.market = 'prop'
   AND NOT EXISTS (SELECT 1 FROM leg_results l WHERE l.bet_id = b.bet_id AND l.owner_id = b.owner_id)
"""


def main(argv: list[str] | None = None, *, request_fn: Callable = http_request,
         clock: Callable = lambda: datetime.now(UTC)) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--postgres", action="store_true")
    parser.add_argument("--db", default="data/warehouse-v4.duckdb")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(asctime)sZ %(levelname)s %(message)s")

    if args.postgres:
        from pg_store import PostgresStore
        store = PostgresStore(clean_database_url(os.environ.get("DATABASE_URL")))
        database = Database.postgres(store.con)
    else:
        import duckdb
        store = None
        database = Database.duckdb(duckdb.connect(args.db))
    ensure_analytics_schema(database)

    summary = {"type": "prop_results_summary", "waiting": 0, "games": 0, "settled": 0,
               "player_not_found": 0, "left_for_a_tap": 0, "fetch_errors": 0}
    legs = database.fetchall(WAITING)
    summary["waiting"] = len(legs)
    by_event: dict[tuple[str, str], list[tuple]] = {}
    for leg in legs:
        by_event.setdefault((str(leg[2]), str(leg[3])), []).append(leg)

    now = clock()
    rows: list[list] = []
    for (league, event_id), group in by_event.items():
        path = LEAGUE_PATH.get(league)
        if not path:
            continue
        status, _headers, body = request_fn(
            f"{SITE_API}/{path}/summary?event={event_id}",
            {"User-Agent": "Mozilla/5.0", **ESPN_BROWSER_HEADERS}, 20)
        if status != 200:
            summary["fetch_errors"] += 1
            continue
        summary["games"] += 1
        stats = box_stats(json.loads(body))
        for bet_id, owner_id, _l, _e, side, line, player, stat in group:
            player_stats = stats.get(normalise(player))
            if player_stats is None:
                summary["player_not_found"] += 1
                continue
            value = stat_value(player_stats, str(stat))
            if value is None or line is None:
                summary["left_for_a_tap"] += 1
                continue
            rows.append([uuid.uuid4().hex, owner_id, bet_id, decide(value, str(side), float(line)),
                         "boxscore", now])
        time.sleep(0.3)

    summary["settled"] = len(rows)
    if rows and not args.dry_run:
        database.executemany(
            "INSERT INTO leg_results (result_id, owner_id, bet_id, result, source, decided_at) "
            "VALUES (?, ?, ?, ?, ?, ?)", rows)
        database.commit()
    print(json.dumps(summary))
    if store is not None:
        store.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
