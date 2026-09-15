"""Recording a survivor pool's field from a workflow.

Every refusal here guards against the same failure: a field written onto the wrong pool,
or one that cannot be true, produces a plan that looks exactly like a correct one.
"""
from __future__ import annotations

import pytest

from set_pool_field import FieldUpdate, apply_updates, parse_update


def pools():
    return [
        {"used": ["Team A"], "size": 13, "lossesAllowed": 1},
        {"used": ["Team B"], "size": 137, "lossesAllowed": 1},
    ]


def test_both_pools_after_week_one():
    updated, report = apply_updates(pools(), [parse_update("137:90,51:0"), parse_update("13:9,2:0")])
    big = next(p for p in updated if p["field"] == [90, 51])
    small = next(p for p in updated if p["field"] == [9, 2])
    assert big["size"] == 141
    assert small["size"] == 11
    assert "myLosses" not in big, "no losses is not stored as a zero"
    assert len(report) == 2


def test_used_teams_survive_the_update_untouched():
    updated, _ = apply_updates(pools(), [parse_update("137:90,51:0")])
    assert next(p for p in updated if p["size"] == 141)["used"] == ["Team B"]


def test_the_report_never_names_a_team():
    # Actions logs are public and survivor picks are strategy.
    _, report = apply_updates(pools(), [parse_update("137:90,51:0"), parse_update("13:9,2:0")])
    assert not any("Team" in line for line in report)


def test_running_it_twice_changes_nothing():
    once, _ = apply_updates(pools(), [parse_update("137:90,51:0")])
    twice, report = apply_updates(once, [parse_update("137:90,51:0")])
    assert twice == once
    assert "already recorded" in report[0]


def test_an_unknown_size_is_refused_with_the_sizes_present():
    with pytest.raises(ValueError, match="sizes as stored: 13, 137"):
        apply_updates(pools(), [parse_update("140:90,51:0")])


def test_an_ambiguous_size_is_refused_rather_than_guessed():
    twins = [{"used": [], "size": 20, "lossesAllowed": 1}, {"used": [], "size": 20, "lossesAllowed": 1}]
    with pytest.raises(ValueError, match="2 pools"):
        apply_updates(twins, [parse_update("20:15,5:0")])


def test_more_buckets_than_the_pool_allows_is_refused():
    with pytest.raises(ValueError, match="at most 2 buckets"):
        apply_updates(pools(), [parse_update("137:80,40,21:0")])


def test_you_cannot_be_alive_in_an_empty_bucket():
    with pytest.raises(ValueError, match="bucket is empty"):
        apply_updates(pools(), [parse_update("137:141,0:1")])


def test_a_loss_down_is_recorded():
    updated, report = apply_updates(pools(), [parse_update("137:90,51:1")])
    big = next(p for p in updated if p["size"] == 141)
    assert big["myLosses"] == 1
    assert "140 rivals" in report[0]


@pytest.mark.parametrize("bad", ["137:90,51", "x:90,51:0", "137::0", "137:90,-1:0", "0:5:0", "137:0,0:0"])
def test_malformed_updates_are_refused(bad):
    with pytest.raises(ValueError):
        parse_update(bad)


def test_a_well_formed_update_parses():
    assert parse_update(" 137:90,51:0 ") == FieldUpdate(137, (90, 51), 0)


def test_a_refusal_reports_sizes_as_stored_not_half_applied():
    # The first update applies in memory (137 -> 141) before the second is refused.
    # The message must still name 137: that is what is in the database, and reporting
    # the working copy sent the next attempt after a pool that did not exist.
    with pytest.raises(ValueError) as error:
        apply_updates(pools(), [parse_update("137:90,51:0"), parse_update("12:9,2:0")])
    assert "sizes as stored: 13, 137" in str(error.value)
    assert "141" not in str(error.value)
