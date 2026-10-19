"""Player name -> position, for pricing a player prop inside a same-game parlay.

How a prop moves with the score depends on the position (a back's touchdown follows his
team's margin; a receiver's barely does -- prop_correlation.py), and Kalshi names the
player but not his position. nflverse's weekly stats for the current season give it.
A player who has not played a snap this season is simply absent, and the app refuses to
price his prop in a parlay rather than guess what he plays.

    python collector/player_positions.py --stats stats_player_week_2026.csv
"""
from __future__ import annotations

import argparse
import collections
import csv
import json
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "web" / "config" / "player-positions.json"


def positions(path: Path) -> dict[str, str]:
    seen: dict[str, collections.Counter] = {}
    for row in csv.DictReader(open(path, encoding="utf-8")):
        if row.get("season_type") != "REG":
            continue
        name = (row.get("player_display_name") or "").strip()
        pos = row.get("position")
        if name and pos in ("QB", "RB", "WR", "TE", "FB"):
            seen.setdefault(name, collections.Counter())[pos] += 1
    # Two players sharing a name with different positions would make the name ambiguous:
    # leave it out rather than pick one.
    return {name: c.most_common(1)[0][0] for name, c in sorted(seen.items()) if len(c) == 1}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stats", type=Path, required=True)
    args = parser.parse_args()
    table = positions(args.stats)
    OUT.write_text(json.dumps(table, indent=0, sort_keys=True) + "\n", encoding="utf-8")
    print(f"{len(table)} players -> {OUT}")


if __name__ == "__main__":
    main()
