"""Fake HTTP layer for offline collector tests.

Mirrors the ``http_request(url, headers, timeout) -> (status, headers, body)``
contract that ``HttpClient`` depends on, and records every call so tests can
assert on the request side as well as the parse side.
"""
from __future__ import annotations

import json


def scoreboard(events):
    return {"events": events}


def event(event_id="401856782", date="2026-09-12T16:00Z", home=("197", "Oklahoma State Cowboys"),
          away=("2483", "Oregon Ducks"), state="pre", completed=False, name="STATUS_SCHEDULED"):
    return {
        "id": event_id, "date": date,
        "competitions": [{
            "id": event_id, "date": date,
            "competitors": [
                {"homeAway": "home", "team": {"id": home[0], "displayName": home[1]}},
                {"homeAway": "away", "team": {"id": away[0], "displayName": away[1]}},
            ],
            "status": {"type": {"state": state, "completed": completed, "name": name}},
        }],
    }


def american(value):
    return {"american": value}


def odds_item(spread=22.5, total=57.5, home_line="+22.5", away_line="-22.5",
              home_spread_price="-110", away_spread_price="-110",
              over="-115", under="-105", home_ml="+1100", away_ml="-2100",
              provider=("100", "DraftKings")):
    """A core-API odds item shaped like the real one verified on 2026-09-06."""
    return {
        "provider": {"id": provider[0], "name": provider[1]},
        "spread": spread, "overUnder": total,
        "current": {"over": american(over), "under": american(under), "total": american(str(total))},
        "homeTeamOdds": {
            # `open` deliberately differs from `current`; nothing may ever read it as a price.
            "open": {"pointSpread": american("+20.5"), "spread": american("-110"),
                     "moneyLine": american("+600")},
            "current": {"pointSpread": american(home_line), "spread": american(home_spread_price),
                        "moneyLine": american(home_ml)},
        },
        "awayTeamOdds": {
            "open": {"pointSpread": american("-20.5"), "spread": american("-110"),
                     "moneyLine": american("-900")},
            "current": {"pointSpread": american(away_line), "spread": american(away_spread_price),
                        "moneyLine": american(away_ml)},
        },
    }


def odds_page(items, page_index=1, page_count=1, count=None):
    return {"count": len(items) if count is None else count, "pageIndex": page_index,
            "pageSize": 25, "pageCount": page_count, "items": items}


EMPTY_ODDS = {"count": 0, "pageIndex": 0, "pageSize": 25, "pageCount": 0, "items": []}


class FakeHttp:
    """Routes by URL substring. Records (url, headers) for every request."""

    def __init__(self, routes, default=None):
        self.routes = routes
        self.default = default if default is not None else EMPTY_ODDS
        self.calls: list[tuple[str, dict]] = []

    def __call__(self, url, headers, timeout):
        self.calls.append((url, headers))
        for fragment, payload in self.routes.items():
            if fragment in url:
                if isinstance(payload, int):
                    return payload, {}, b""
                return 200, {"content-type": "application/json"}, json.dumps(payload).encode()
        return 200, {"content-type": "application/json"}, json.dumps(self.default).encode()

    def urls(self):
        return [url for url, _ in self.calls]

    def scoreboard_calls(self):
        return [url for url in self.urls() if "scoreboard" in url]
