"""How player stats move with the score: the measurement same-game parlays need.

A same-game parlay is one game asked several questions, and the app prices game legs
exactly (joint-score.ts) because every game market resolves off two numbers -- the margin
and the total. A player prop is a third number. Pricing "49ers -7.5 + Over + McCaffrey
anytime TD" needs to know how McCaffrey's touchdown moves with those two, and that is
measured here rather than assumed.

The question is about the GAME going differently from what the market expected, not about
how good the player is. So:

* The game side is the closing line's miss: the team's margin minus what the closing
  spread expected, and the total minus the closing total, each scaled to unit spread.
* The player side is the player's own game against his own season: each stat converted
  to a normal score by its rank among that player's games that season. That removes his
  level (a star and a backup both centre on zero) and his shape (yards are skewed; ranks
  are not), which is what a Gaussian copula -- the same join joint-score.ts uses for the
  margin and total -- needs.
* Touchdowns are yes/no, so their correlation is the LATENT one: for a threshold model,
  E[1{TD} * z] = rho * phi(c) with c the player's threshold, so rho is the covariance over
  phi(c), pooled over players. That is the number a copula takes.

Roles are fixed per player-season (by season averages), never by the game itself: a back
who got 25 carries got them BECAUSE his team was winning, and selecting on that would
build the correlation into the sample.

Fitted on 2015-2021 and checked on 2022-2025: a correlation that only holds on the years
it was fitted to is noise.

Data: nflverse (free, public) -- games.csv for closing lines and scores, and
stats_player_week_{season}.csv for player games. Run:

    python collector/prop_correlation.py --data <folder with games.csv and stats_*.csv>
"""
from __future__ import annotations

import argparse
import csv
import json
import math
from collections import defaultdict
from pathlib import Path
from statistics import NormalDist, mean

N = NormalDist()
TRAIN = range(2015, 2022)
TEST = range(2022, 2026)

#: Stat definitions: (label, value of a player-game, who qualifies by SEASON average).
#: Kept to the markets Kalshi lists and the props a boost usually lands on.
STATS = {
    "pass_yds": ("QB passing yards", lambda r: f(r, "passing_yards"), lambda s: s["pos"] == "QB" and s["att"] >= 20),
    "pass_tds_any": ("QB 1+ passing TD", None, lambda s: s["pos"] == "QB" and s["att"] >= 20),
    "rush_yds": ("RB rushing yards", lambda r: f(r, "rushing_yards"), lambda s: s["pos"] == "RB" and s["car"] >= 10),
    "rush_rec_yds": ("RB rush + rec yards", lambda r: f(r, "rushing_yards") + f(r, "receiving_yards"),
                     lambda s: s["pos"] == "RB" and s["car"] >= 10),
    "rec_yds_wr": ("WR receiving yards", lambda r: f(r, "receiving_yards"), lambda s: s["pos"] == "WR" and s["tgt"] >= 4),
    "rec_yds_te": ("TE receiving yards", lambda r: f(r, "receiving_yards"), lambda s: s["pos"] == "TE" and s["tgt"] >= 3),
    "receptions_wr": ("WR receptions", lambda r: f(r, "receptions"), lambda s: s["pos"] == "WR" and s["tgt"] >= 4),
    "atd_rb": ("RB anytime TD", None, lambda s: s["pos"] == "RB" and s["car"] >= 10),
    "atd_wr": ("WR anytime TD", None, lambda s: s["pos"] == "WR" and s["tgt"] >= 4),
    "atd_te": ("TE anytime TD", None, lambda s: s["pos"] == "TE" and s["tgt"] >= 3),
}
BINARY = {
    "pass_tds_any": lambda r: f(r, "passing_tds") >= 1,
    "atd_rb": lambda r: f(r, "rushing_tds") + f(r, "receiving_tds") >= 1,
    "atd_wr": lambda r: f(r, "rushing_tds") + f(r, "receiving_tds") >= 1,
    "atd_te": lambda r: f(r, "rushing_tds") + f(r, "receiving_tds") >= 1,
}


def f(row: dict, key: str) -> float:
    try:
        return float(row.get(key) or 0)
    except ValueError:
        return 0.0


def load_games(path: Path) -> dict[str, dict]:
    """game_id -> closing lines and the result, regular season only."""
    games = {}
    for r in csv.DictReader(open(path, encoding="utf-8")):
        if r["game_type"] != "REG" or not r["home_score"] or not r["spread_line"] or not r["total_line"]:
            continue
        if int(r["season"]) < TRAIN.start:  # the same seasons as the player data
            continue
        home, away = int(r["home_score"]), int(r["away_score"])
        games[r["game_id"]] = {
            "season": int(r["season"]),
            "home": r["home_team"], "away": r["away_team"],
            # nflverse: spread_line > 0 means the HOME team was favoured by that much.
            "home_miss": (home - away) - float(r["spread_line"]),
            "total_miss": (home + away) - float(r["total_line"]),
        }
    return games


def normal_scores(values: list[float]) -> list[float]:
    """Rank-based normal scores, ties sharing the average rank."""
    order = sorted(range(len(values)), key=lambda i: values[i])
    ranks = [0.0] * len(values)
    i = 0
    while i < len(order):
        j = i
        while j + 1 < len(order) and values[order[j + 1]] == values[order[i]]:
            j += 1
        avg = (i + j) / 2 + 1
        for k in range(i, j + 1):
            ranks[order[k]] = avg
        i = j + 1
    n = len(values)
    return [N.inv_cdf((r - 0.5) / n) for r in ranks]


def corr(xs: list[float], ys: list[float]) -> float:
    mx, my = mean(xs), mean(ys)
    sxy = sum((x - mx) * (y - my) for x, y in zip(xs, ys))
    sx = math.sqrt(sum((x - mx) ** 2 for x in xs))
    sy = math.sqrt(sum((y - my) ** 2 for y in ys))
    return sxy / (sx * sy) if sx and sy else float("nan")


def measure(data: Path) -> dict:
    games = load_games(data / "games.csv")
    # The game's misses, scaled: their spread across all games in the sample.
    d_sd = math.sqrt(mean(g["home_miss"] ** 2 for g in games.values()))
    s_sd = math.sqrt(mean(g["total_miss"] ** 2 for g in games.values()))

    # Player-games, regular season, joined to a game with closing lines.
    by_player_season: dict[tuple[str, int], list[dict]] = defaultdict(list)
    for path in sorted(data.glob("stats_*.csv")):
        for r in csv.DictReader(open(path, encoding="utf-8")):
            if r.get("season_type") != "REG" or r.get("game_id") not in games:
                continue
            by_player_season[(r["player_id"], int(r["season"]))].append(r)

    out: dict[str, dict] = {}
    for key, (label, value, qualifies) in STATS.items():
        cells = {"train": defaultdict(list), "test": defaultdict(list)}
        binary = BINARY.get(key)
        for (_, season), rows in by_player_season.items():
            if len(rows) < 6:
                continue
            season_avg = {
                "pos": rows[0].get("position", ""),
                "att": mean(f(r, "attempts") for r in rows),
                "car": mean(f(r, "carries") for r in rows),
                "tgt": mean(f(r, "targets") for r in rows),
            }
            if not qualifies(season_avg):
                continue
            split = "train" if season in TRAIN else "test" if season in TEST else None
            if split is None:
                continue
            zd, zs = [], []
            for r in rows:
                g = games[r["game_id"]]
                sign = 1 if r["team"] == g["home"] else -1 if r["team"] == g["away"] else 0
                if sign == 0:
                    break
                zd.append(sign * g["home_miss"] / d_sd)
                zs.append(g["total_miss"] / s_sd)
            else:
                c = cells[split]
                if binary is None:
                    zx = normal_scores([value(r) for r in rows])
                    c["x"].extend(zx)
                    c["d"].extend(zd)
                    c["s"].extend(zs)
                else:
                    hits = [1.0 if binary(r) else 0.0 for r in rows]
                    p = mean(hits)
                    if not 0 < p < 1:
                        continue
                    cut = N.inv_cdf(1 - p)
                    # Within-player covariance of the hit with each miss, and the density
                    # at his threshold: rho = cov / phi(c), pooled as sums.
                    c["cov_d"].append(mean((h - p) * (z - mean(zd)) for h, z in zip(hits, zd)) * len(hits))
                    c["cov_s"].append(mean((h - p) * (z - mean(zs)) for h, z in zip(hits, zs)) * len(hits))
                    c["phi"].append(N.pdf(cut) * len(hits))
                    c["n"].append(len(hits))
                    c["hits"].append(sum(hits))
                    # Lift: hit rate when the team beat the spread AND the game went over.
                    both = [h for h, a, b in zip(hits, zd, zs) if a > 0 and b > 0]
                    c["both_hits"].append(sum(both))
                    c["both_n"].append(len(both))
                    c["both_expected"].append(p * len(both))
        out[key] = {"label": label}
        for split, c in cells.items():
            if binary is None:
                n = len(c["x"])
                out[key][split] = {
                    "n": n,
                    "rho_margin": round(corr(c["x"], c["d"]), 3) if n else None,
                    "rho_total": round(corr(c["x"], c["s"]), 3) if n else None,
                    "se": round(1 / math.sqrt(n), 3) if n else None,
                }
            else:
                n = sum(c["n"])
                phi = sum(c["phi"])
                out[key][split] = {
                    "n": n,
                    "rate": round(sum(c["hits"]) / n, 3) if n else None,
                    "rho_margin": round(sum(c["cov_d"]) / phi, 3) if phi else None,
                    "rho_total": round(sum(c["cov_s"]) / phi, 3) if phi else None,
                    # How much more often he scored when his team covered AND it went over,
                    # against his own base rate in those games.
                    "lift_cover_and_over": round(sum(c["both_hits"]) / sum(c["both_expected"]), 3)
                    if sum(c["both_expected"]) else None,
                    "se": round(1 / math.sqrt(n), 3) if n else None,
                }
    out["_scale"] = {"margin_sd": round(d_sd, 2), "total_sd": round(s_sd, 2), "games": len(games)}
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--data", type=Path, required=True)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    result = measure(args.data)
    text = json.dumps(result, indent=2)
    if args.out:
        args.out.write_text(text, encoding="utf-8")
    print(text)


if __name__ == "__main__":
    main()
