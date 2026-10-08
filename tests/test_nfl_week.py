"""Week numbering for national pick shares: Tuesday to Monday, like the NFL's weeks."""
from __future__ import annotations

from datetime import UTC, datetime

from pick_popularity import nfl_week

OPENER = datetime(2026, 9, 11, 0, 20, tzinfo=UTC)  # Thu Sep 10, 8:20 PM Eastern


def at(month, day, hour=12):
    return datetime(2026, month, day, hour, tzinfo=UTC)


def test_the_opening_week_is_week_one_from_tuesday_to_monday():
    assert nfl_week(OPENER, at(9, 8, 13)) == 1   # Tue Sep 8, the week of the opener
    assert nfl_week(OPENER, at(9, 14, 23)) == 1  # Mon Sep 14, Monday night


def test_midweek_already_belongs_to_the_new_week():
    # The bug: Tuesday to Thursday night of week 5 were filed under week 4.
    assert nfl_week(OPENER, at(10, 6, 15)) == 5  # Tue Oct 6
    assert nfl_week(OPENER, at(10, 8, 18)) == 5  # Thu Oct 8, before kickoff
    assert nfl_week(OPENER, at(10, 12, 23)) == 5  # Mon Oct 12, MNF
    assert nfl_week(OPENER, at(10, 13, 13)) == 6  # Tue Oct 13, 9 AM Eastern
