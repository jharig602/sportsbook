"""Record where a survivor pool's field stands, from the command line.

The survivor page has an editor for this, but it sits behind the owner passcode, and
the collector's environment is the other place with write access to `app_settings`.
This exists so a weekly update can be applied without a browser -- and so the rules
for what counts as a consistent field live in one tested function rather than being
re-typed into a SQL console.

The field is stored as STATE, never as a weekly change: "90 unbeaten, 51 on one loss",
not "51 lost this week". A delta has to be applied exactly once; a state can be
re-applied any number of times and still mean the same thing, which is the only safe
property for something run by hand from a workflow.

Two things are deliberately never printed, because Actions logs on this repository are
public: the teams an entry has used, and anything else about its picks. Survivor picks
are strategy -- showing a rival which team you hold turns a separated entry into a
shared one -- so the report is sizes and loss counts only.

Usage (DATABASE_URL from the environment, never argv):

    python collector/set_pool_field.py --set 137:90,51:0 --set 13:9,2:0:11/22 [--dry-run]

Each --set is MATCH:FIELD:MYLOSSES[:TOP/PICKS]. MATCH is the pool's current size, which
is how the two pools are told apart; FIELD is entrants alive by losses taken, you
included. The optional TOP/PICKS is how much the pool herds, from its own completed weeks:
the most-picked team's count summed across weeks, over all picks made. Counts only -- no
teams -- so it is safe in these public logs.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
from dataclasses import dataclass

SETTINGS_KEY = "survivor_pools"


@dataclass(frozen=True)
class FieldUpdate:
    match_size: int
    field: tuple[int, ...]
    my_losses: int
    #: (top, picks) -- the pool's own herding. None leaves whatever is stored alone.
    crowd: tuple[int, int] | None = None


def parse_update(text: str) -> FieldUpdate:
    """`137:90,51:0` or `137:90,51:0:105/282` -> FieldUpdate. Rejects any other shape."""
    parts = text.strip().split(":")
    if len(parts) not in (3, 4):
        raise ValueError(f"expected MATCH:FIELD:MYLOSSES[:TOP/PICKS], got {text!r}")
    crowd = None
    if len(parts) == 4:
        try:
            top_text, picks_text = parts[3].split("/")
            crowd = (int(top_text), int(picks_text))
        except ValueError as error:
            raise ValueError(f"crowd must be TOP/PICKS in {text!r}") from error
        if crowd[1] < 1 or crowd[0] < 0 or crowd[0] > crowd[1]:
            raise ValueError(f"crowd out of range in {text!r}: top must be 0..picks")
        parts = parts[:3]
    try:
        match = int(parts[0])
        field = tuple(int(n) for n in parts[1].split(",") if n.strip() != "")
        mine = int(parts[2])
    except ValueError as error:
        raise ValueError(f"not all numbers in {text!r}") from error
    if match < 1 or mine < 0 or not field or any(n < 0 for n in field) or sum(field) < 1:
        raise ValueError(f"out of range in {text!r}")
    return FieldUpdate(match, field, mine, crowd)


def apply_updates(pools: list[dict], updates: list[FieldUpdate]) -> tuple[list[dict], list[str]]:
    """Apply field updates to stored pools, refusing anything ambiguous or inconsistent.

    Refuses rather than guesses at every fork, because the failure of a guess here is a
    plan built against the wrong pool's field, which looks exactly like a plan built
    against the right one:

    * a MATCH that fits no pool, or more than one, is an error naming the sizes present;
    * a field with more loss buckets than the pool allows is an error, not a truncation;
    * an entry alive on N losses whose bucket holds nobody is an error -- you are in it.

    Re-applying a field that is already stored is reported and skipped, so running the
    same workflow twice changes nothing.
    """
    out = [dict(p) for p in pools]
    report: list[str] = []
    # Sizes as STORED, captured before anything is applied. Reporting them from the
    # working copy instead named a pool "141" that was stored at 137, because an earlier
    # update in the same run had already been applied in memory -- and the next attempt,
    # built on that, was refused for a size that did not exist. A refusal that misreports
    # the state it refused is worse than one that says nothing.
    stored_sizes = ", ".join(str(int(p.get("size") or 0)) for p in pools) or "none"
    for update in updates:
        target_total = sum(update.field)
        already = [
            i for i, p in enumerate(out)
            if list(p.get("field") or []) == list(update.field)
            and int(p.get("myLosses") or 0) == update.my_losses
            # A new crowd measurement on an unchanged field is still a change. Without this
            # the update would report "already recorded" and silently skip it.
            and (update.crowd is None
                 or (p.get("crowd") or {}) == {"top": update.crowd[0], "picks": update.crowd[1]})
        ]
        if already:
            report.append(f"pool of {target_total}: already recorded, unchanged")
            continue

        matches = [i for i, p in enumerate(out) if int(p.get("size") or 0) == update.match_size]
        if len(matches) != 1:
            raise ValueError(
                f"{len(matches)} pools have size {update.match_size}; "
                f"sizes as stored: {stored_sizes}"
            )
        index = matches[0]
        pool = out[index]
        allowed = int(pool.get("lossesAllowed") or 0)

        if len(update.field) > allowed + 1:
            raise ValueError(
                f"pool of {update.match_size} allows {allowed} loss(es), so the field has at "
                f"most {allowed + 1} buckets; got {len(update.field)}"
            )
        if update.my_losses <= allowed and (
            update.my_losses >= len(update.field) or update.field[update.my_losses] < 1
        ):
            raise ValueError(
                f"pool of {update.match_size}: your entry is alive on {update.my_losses} "
                f"loss(es) but that bucket is empty -- you are in it"
            )

        before = int(pool.get("size") or 0)
        pool["field"] = list(update.field)
        # The size IS the field's total once a field is recorded; see parsePools.
        pool["size"] = target_total
        if update.my_losses > 0:
            pool["myLosses"] = update.my_losses
        else:
            pool.pop("myLosses", None)
        if update.crowd is not None:
            pool["crowd"] = {"top": update.crowd[0], "picks": update.crowd[1]}
        rivals = target_total - (1 if update.my_losses <= allowed else 0)
        herding = (
            f", herding {update.crowd[0]}/{update.crowd[1]} "
            f"({update.crowd[0] / update.crowd[1]:.0%})"
            if update.crowd else ""
        )
        report.append(
            f"pool of {before} -> {target_total}: field {list(update.field)}, "
            f"your losses {update.my_losses}, {rivals} rivals{herding}"
        )
    return out, report


def apply_rivals(
    pools: list[dict], rivals: dict, stored_sizes: list[int]
) -> tuple[list[dict], list[str]]:
    """Record every live rival's history, per pool.

    `rivals` maps a pool's size AS STORED BEFORE THIS RUN to {"week": n, "groups":
    [{"used": [team, ...], "pick": team, "n": count}, ...]}, or to null to clear it. A
    group is the rivals sharing one exact history: the teams they have spent before
    `week`, and their pick for `week` when the sheet shows it. Matched on the stored size
    for the same reason the field is: a size changed earlier in the same run must not
    make this land on a different pool, or on none.

    Refuses rather than guesses: an unknown or ambiguous size, a week outside 1-30, a
    group without a positive whole count, a team that is not a short non-empty name, or
    more rivals than the pool has -- that last one is a sheet read wrongly.

    Reports counts only. The histories are in the workflow input, not in anything this
    prints, and never include the owner's own row.
    """
    out = [dict(p) for p in pools]
    report: list[str] = []
    for key, value in rivals.items():
        try:
            size = int(key)
        except (TypeError, ValueError) as error:
            raise ValueError(f"rivals keyed by {key!r}, which is not a pool size") from error
        matches = [i for i, stored in enumerate(stored_sizes) if stored == size]
        if len(matches) != 1:
            raise ValueError(
                f"{len(matches)} pools have size {size}; sizes as stored: "
                f"{', '.join(str(n) for n in stored_sizes) or 'none'}"
            )
        pool = out[matches[0]]
        # The per-team counts this replaces would otherwise sit beside it, stale.
        pool.pop("thisWeek", None)
        if value is None:
            pool.pop("rivals", None)
            report.append(f"pool of {size}: rivals' histories cleared")
            continue
        try:
            week = int(value["week"])
            raw = list(value["groups"])
        except (KeyError, TypeError, ValueError) as error:
            raise ValueError(f"pool of {size}: rivals must be {{week, groups}}") from error
        if not 1 <= week <= 30:
            raise ValueError(f"pool of {size}: week {week} is not a week of the season")
        if not raw or len(raw) > 500:
            raise ValueError(f"pool of {size}: between 1 and 500 groups, not {len(raw)}")

        def team(name: object) -> str:
            if not isinstance(name, str) or not name.strip() or len(name) > 60:
                raise ValueError(f"pool of {size}: every team must be a short name")
            return name.strip()

        groups = []
        for g in raw:
            try:
                n = int(g["n"])
                used = [team(t) for t in list(g.get("used") or [])]
                pick = g.get("pick")
            except (KeyError, TypeError, AttributeError) as error:
                raise ValueError(f"pool of {size}: each group needs used, n and maybe pick") from error
            if n < 1:
                raise ValueError(f"pool of {size}: every group needs a count of 1 or more")
            if len(used) > 20:
                raise ValueError(f"pool of {size}: more than 20 spent teams in one history")
            group = {"used": used, "n": n}
            if pick is not None:
                group["pick"] = team(pick)
            groups.append(group)
        count = int(pool.get("size") or 0) - 1
        total = sum(g["n"] for g in groups)
        if total > count:
            raise ValueError(
                f"pool of {size}: {total} rivals on the sheet but only {count} in the pool -- "
                "the sheet was read wrongly"
            )
        pool["rivals"] = {"week": week, "groups": groups}
        picked = sum(g["n"] for g in groups if "pick" in g)
        report.append(
            f"pool of {size}: {total} rivals' histories recorded (week {week}, "
            f"{len(groups)} groups, {picked} picks known this week)"
        )
    return out, report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--set", dest="sets", action="append", default=[],
                        help="MATCH:FIELD:MYLOSSES, repeatable")
    parser.add_argument("--rivals", default="",
                        help='JSON: {"POOLSIZE": {"week": N, "groups": [{"used": [...], "pick": "Team", "n": count}]}}')
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args(argv)

    # Also accepted from the environment, which is how the workflow passes its input:
    # interpolating a dispatch input straight into a shell line is a script injection.
    env_sets = os.environ.get("POOL_SETS", "").split()
    try:
        updates = [parse_update(text) for text in [*args.sets, *env_sets]]
        rivals_text = (args.rivals or os.environ.get("POOL_RIVALS", "")).strip()
        rivals = json.loads(rivals_text) if rivals_text else {}
        if not isinstance(rivals, dict):
            raise ValueError("rivals must be a JSON object keyed by pool size")
    except (ValueError, json.JSONDecodeError) as error:
        print(f"refused: {error}", file=sys.stderr)
        return 2
    if not updates and not rivals:
        print("refused: nothing to set", file=sys.stderr)
        return 2

    url = os.environ.get("DATABASE_URL")
    if not url:
        print("DATABASE_URL is not set", file=sys.stderr)
        return 2

    import psycopg

    with psycopg.connect(url) as connection:
        row = connection.execute(
            "SELECT value FROM app_settings WHERE key = %s", [SETTINGS_KEY]
        ).fetchone()
        if row is None:
            print("refused: no survivor pools are stored yet", file=sys.stderr)
            return 2
        pools = json.loads(row[0])
        stored_sizes = [int(p.get("size") or 0) for p in pools]
        try:
            updated, report = apply_updates(pools, updates)
            if rivals:
                updated, rivals_report = apply_rivals(updated, rivals, stored_sizes)
                report.extend(rivals_report)
        except ValueError as error:
            print(f"refused: {error}", file=sys.stderr)
            return 2
        for line in report:
            print(line)
        if args.dry_run:
            print("dry run: nothing written")
            return 0
        connection.execute(
            "UPDATE app_settings SET value = %s, updated_at = NOW() WHERE key = %s",
            [json.dumps(updated), SETTINGS_KEY],
        )
    print("written")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
