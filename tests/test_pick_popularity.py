"""Survivor pick popularity.

Scraping HTML is brittle by nature, so the tests that matter are the ones that catch a
layout change rather than the ones that prove a good page parses.
"""
import contextlib
import io
import json

import pick_popularity as pp
from helpers import FakeHttp

PAGE = b"""
<table><tbody>
<tr id="t34" data-team-id="34"><td class="dist">1.08</td><td class="dist">80.0%</td>
<td class="dist">27.6%</td><td class="teamname">LAC</td></tr>
<tr id="t30" data-team-id="30"><td class="dist">1.05</td><td class="dist">77.2%</td>
<td class="dist">23.4%</td><td class="teamname">JAX</td></tr>
<tr id="t8" data-team-id="8"><td class="dist">1.04</td><td class="dist">72.7%</td>
<td class="dist">13.3%</td><td class="teamname">DET</td></tr>
</tbody></table>
"""


def test_a_row_yields_team_share_and_their_win_probability():
    rows = pp.parse(PAGE)
    assert rows[0] == ("Los Angeles Chargers", 0.276, 0.80)
    assert rows[1][0] == "Jacksonville Jaguars"
    assert len(rows) == 3


def test_abbreviations_become_the_names_the_schedule_uses():
    # A wrong join here would attribute one team's popularity to another, silently.
    rows = dict((t, s) for t, s, _ in pp.parse(PAGE))
    assert "Los Angeles Chargers" in rows
    assert "LAC" not in rows


def test_an_unknown_abbreviation_is_dropped_not_guessed():
    odd = PAGE.replace(b"LAC", b"ZZZ")
    rows = pp.parse(odd)
    assert all(t != "ZZZ" for t, _, _ in rows)
    assert len(rows) == 2, "the other rows still parse"


def test_a_page_with_no_matching_rows_parses_to_nothing():
    assert pp.parse(b"<html><body>nothing here</body></html>") == []


def test_a_layout_change_is_an_ERROR_not_an_empty_table(monkeypatch, tmp_path):
    """The failure that would matter.

    If their markup moves, the regex quietly matches fewer rows. Writing three teams as
    though they were the league would produce a confident, wrong popularity table and
    nothing downstream could tell. A short slate is treated as a broken parse.
    """
    http = FakeHttp({}, default=[])
    http.__call__ = lambda url, headers, timeout: (200, {}, PAGE)
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = pp.main(["--dry-run", "--db", str(tmp_path / "none.duckdb")],
                       request_fn=lambda u, h, t: (200, {}, PAGE),
                       sleep_fn=lambda _s: None)
    summary = json.loads(buffer.getvalue().strip().splitlines()[-1])
    assert code == 2, "three teams is not a slate"
    assert summary["teams"] == 3
    assert summary["errors"] >= 1


def test_a_full_slate_is_accepted(tmp_path):
    rows = b"".join(
        b'<tr id="t%d" data-team-id="%d"><td class="dist">1.0</td>'
        b'<td class="dist">60.0%%</td><td class="dist">3.0%%</td>'
        b'<td class="teamname">%s</td></tr>' % (i, i, abbr.encode())
        for i, abbr in enumerate(list(pp.TEAM_NAMES)[:24])
    )
    page = b"<table><tbody>" + rows + b"</tbody></table>"
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = pp.main(["--dry-run", "--db", str(tmp_path / "none.duckdb")],
                       request_fn=lambda u, h, t: (200, {}, page),
                       sleep_fn=lambda _s: None)
    summary = json.loads(buffer.getvalue().strip().splitlines()[-1])
    assert code == 0, summary
    assert summary["teams"] >= pp.MIN_TEAMS


def test_the_host_is_allowlisted():
    import odds_poller as op
    assert "survivorgrid" in op.SOURCE_HOSTS
    assert "www.survivorgrid.com" in op.SOURCE_HOSTS["survivorgrid"]


def test_an_http_failure_exits_two(tmp_path):
    buffer = io.StringIO()
    with contextlib.redirect_stdout(buffer):
        code = pp.main(["--dry-run", "--db", str(tmp_path / "none.duckdb")],
                       request_fn=lambda u, h, t: (503, {}, b""),
                       sleep_fn=lambda _s: None)
    assert code == 2
