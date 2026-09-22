"""Power ratings and, mostly, the grader.

A power rating always produces confident numbers, so the tests that matter are the ones
that would catch it producing confident numbers about nothing: a fit that recovers
ratings it was given, a walk-forward that cannot see the game it is predicting, and a
grader that does not quietly turn a push or a best-of-six into a result.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from ratings import (
    BREAK_EVEN,
    Game,
    Prediction,
    binomial_tail,
    family_p,
    fit_ratings,
    grade,
    walk_forward,
    week_of,
)

UTC = timezone.utc
START = datetime(2024, 9, 5, tzinfo=UTC)


def game(home: str, away: str, margin: float, day: int = 0) -> Game:
    return Game(
        event_id=f"{home}-{away}-{day}",
        league="nfl",
        kickoff=START + timedelta(days=day),
        home=home,
        away=away,
        margin=margin,
    )


def round_robin(strengths: dict[str, float], hfa: float, rounds: int = 4) -> list[Game]:
    """Every team plays every other, home and away, at exactly its true strength."""
    teams = sorted(strengths)
    games: list[Game] = []
    day = 0
    for _ in range(rounds):
        for home in teams:
            for away in teams:
                if home == away:
                    continue
                games.append(game(home, away, strengths[home] - strengths[away] + hfa, day))
                day += 1
    return games


# --- the fit --------------------------------------------------------------------

def test_it_recovers_the_strengths_it_was_given():
    strengths = {"A": 7.0, "B": 0.0, "C": -7.0, "D": 3.0}
    model = fit_ratings(round_robin(strengths, hfa=2.5), ridge=0.0, cap=None, half_life=None)
    # Ratings are identified only up to a constant, so DIFFERENCES are what must match.
    assert model.ratings["A"] - model.ratings["C"] == pytest.approx(14.0, abs=1e-6)
    assert model.ratings["D"] - model.ratings["B"] == pytest.approx(3.0, abs=1e-6)


def test_home_field_comes_out_as_its_own_number():
    model = fit_ratings(
        round_robin({"A": 4.0, "B": -4.0, "C": 0.0}, hfa=3.0),
        ridge=0.0, cap=None, half_life=None,
    )
    assert model.hfa == pytest.approx(3.0, abs=1e-6)


def test_strength_of_schedule_is_what_solving_together_means():
    """A team that only beat weak opponents must not outrank one that beat strong ones.

    No schedule adjustment is applied anywhere; this is purely what the simultaneous
    solve does, and it is the reason the rating is solved rather than averaged.
    """
    games = [
        # A beats a terrible team by 30. B beats a strong team by 3.
        game("A", "Terrible", 30, 0),
        game("B", "Strong", 3, 1),
        # Enough context for the solve to know which opponent is which.
        game("Strong", "Terrible", 40, 2),
        game("Strong", "Terrible", 38, 3),
        game("Terrible", "Strong", -35, 4),
    ]
    model = fit_ratings(games, ridge=1.0, cap=None, half_life=None)
    assert model.ratings["B"] > model.ratings["A"]


def test_the_cap_stops_a_blowout_counting_twice_over():
    blowout = [game("A", "B", 56, 0), game("B", "A", -56, 1)]
    capped = fit_ratings(blowout, ridge=0.0, cap=28.0, half_life=None)
    uncapped = fit_ratings(blowout, ridge=0.0, cap=None, half_life=None)
    assert capped.ratings["A"] - capped.ratings["B"] < uncapped.ratings["A"] - uncapped.ratings["B"]


def test_recency_weighting_prefers_what_happened_lately():
    games = [
        game("A", "B", 20, 0),    # long ago: A was much better
        game("A", "B", -20, 700),  # recently: B was much better
    ]
    asof = START + timedelta(days=701)
    recent = fit_ratings(games, asof=asof, ridge=0.0, cap=None, half_life=200.0)
    flat = fit_ratings(games, asof=asof, ridge=0.0, cap=None, half_life=None)
    assert recent.ratings["A"] < flat.ratings["A"]


def test_an_unrated_team_gets_no_opinion_rather_than_an_average_one():
    model = fit_ratings(round_robin({"A": 3.0, "B": -3.0}, hfa=1.0))
    assert model.predicted_spread("A", "Nobody") is None
    assert model.predicted_spread("A", "B") is not None


def test_the_predicted_spread_is_in_the_market_s_convention():
    # A is 10 better and at home, so the market would post A as a double-digit favourite:
    # a NEGATIVE home spread. A sign slip here would bet every game backwards.
    model = fit_ratings(
        round_robin({"A": 5.0, "B": -5.0}, hfa=2.0), ridge=0.0, cap=None, half_life=None,
    )
    assert model.predicted_spread("A", "B") == pytest.approx(-12.0, abs=1e-6)


def test_nothing_to_fit_is_refused():
    assert fit_ratings([]) is None


# --- walking forward -------------------------------------------------------------

def test_a_game_is_never_predicted_from_itself():
    """The failure that would make every number below spectacular and meaningless.

    Proved by changing the answer: rerun with one predicted game's margin replaced by an
    absurd one. If its own prediction moves, the fit that produced it had seen its
    result. Asserting merely that the games are ordered would prove nothing.
    """
    strengths = {"A": 6.0, "B": 2.0, "C": -8.0}
    games = round_robin(strengths, hfa=1.0, rounds=6)
    lines = {g.event_id: 0.0 for g in games}
    options = dict(min_games=10, ridge=1.0, cap=None, half_life=None)

    before = walk_forward(games, lines, **options)
    assert before, "something should be predictable"

    target = before[len(before) // 2].event_id
    tampered = [
        Game(**{**vars(g), "margin": 500.0}) if g.event_id == target else g
        for g in games
    ]
    after = {p.event_id: p for p in walk_forward(tampered, lines, **options)}

    assert after[target].predicted_spread == pytest.approx(
        next(p for p in before if p.event_id == target).predicted_spread
    ), "the prediction moved when its own result changed -- the fit saw the future"
    # And the control: games played AFTER it do move, or the tampering did nothing and
    # the test above would pass for the wrong reason.
    later = [p for p in before if p.kickoff > after[target].kickoff]
    assert any(
        after[p.event_id].predicted_spread != pytest.approx(p.predicted_spread)
        for p in later
    ), "nothing downstream moved; the tampering never took effect"


def test_nothing_is_predicted_before_there_is_enough_history():
    games = round_robin({"A": 3.0, "B": -3.0}, hfa=0.0, rounds=1)
    lines = {g.event_id: 0.0 for g in games}
    assert walk_forward(games, lines, min_games=10_000) == []


def test_a_game_with_no_closing_line_is_skipped_not_guessed():
    games = round_robin({"A": 3.0, "B": -3.0, "C": 0.0}, hfa=0.0, rounds=4)
    predictions = walk_forward(games, {}, min_games=5, ridge=1.0, cap=None, half_life=None)
    assert predictions == []


# --- the grader ------------------------------------------------------------------

def prediction(closing: float, predicted: float, margin: float) -> Prediction:
    return Prediction(
        event_id="e", league="nfl", kickoff=START,
        closing_spread=closing, predicted_spread=predicted, margin=margin,
    )


def test_the_side_is_the_one_the_rating_likes_more_than_the_market():
    # Market has home -3; the rating says home -7. The rating likes home.
    assert prediction(-3.0, -7.0, 0).side == "home"
    # Market has home -7; the rating says home -3. The rating likes away.
    assert prediction(-7.0, -3.0, 0).side == "away"


def test_covering_is_judged_against_the_closing_line():
    # Home -3 on the market, rating likes home, home wins by 7: covered.
    assert prediction(-3.0, -7.0, 7).covered is True
    # Same bet, home wins by 1: did not cover.
    assert prediction(-3.0, -7.0, 1).covered is False
    # Rating likes away at home -3, home wins by 1: away covered.
    assert prediction(-3.0, 1.0, 1).covered is True


def test_a_push_is_neither_a_win_nor_a_loss():
    pushed = prediction(-3.0, -7.0, 3)
    assert pushed.covered is None
    cells = grade([pushed, prediction(-3.0, -7.0, 7)], [0.0])
    # One push, one winner: the push leaves the denominator rather than counting as half.
    assert cells[0].n == 1
    assert cells[0].pushes == 1
    assert cells[0].cover_rate == 1.0


def test_the_threshold_keeps_only_the_real_disagreements():
    rows = [
        prediction(-3.0, -3.5, 7),   # half a point apart
        prediction(-3.0, -9.0, 7),   # six points apart
    ]
    assert grade(rows, [0.0])[0].n == 2
    assert grade(rows, [2.0])[0].n == 1


def test_the_two_bars_ask_different_questions():
    """52.38% is the bar that decides a bet; 50% only says the rating knows something."""
    rows = [prediction(-3.0, -9.0, 7) for _ in range(52)]
    rows += [prediction(-3.0, -9.0, 1) for _ in range(48)]
    cell = grade(rows, [0.0])[0]
    assert cell.cover_rate == pytest.approx(0.52)
    # 52% beats a coin flip more convincingly than it beats the vig, and at this sample
    # it clears neither. Reporting only the first would call this a working system.
    assert cell.p_knows < cell.p_beats_vig
    assert cell.p_beats_vig > 0.05
    assert cell.roi < 0, "52% loses money at -110"


def test_break_even_is_the_vig_not_a_coin_flip():
    assert BREAK_EVEN == pytest.approx(0.5238, abs=1e-4)
    # Exactly break-even returns nothing, which is what makes it the bar.
    rows = [prediction(-3.0, -9.0, 7) for _ in range(5238)]
    rows += [prediction(-3.0, -9.0, 1) for _ in range(4762)]
    assert grade(rows, [0.0])[0].roi == pytest.approx(0.0, abs=1e-3)


def test_the_binomial_tail_is_exact():
    # Ten coin flips, at least eight heads: 56/1024.
    assert binomial_tail(8, 10, 0.5) == pytest.approx(56 / 1024, abs=1e-12)
    assert binomial_tail(0, 10, 0.5) == 1.0
    assert binomial_tail(11, 10, 0.5) == 0.0


def test_the_best_of_several_thresholds_is_corrected_for_having_looked():
    rows = [prediction(-3.0, -9.0, 7) for _ in range(30)]
    rows += [prediction(-3.0, -9.0, 1) for _ in range(20)]
    cells = grade(rows, [0.0, 1.0, 2.0, 3.0])
    best = min(c.p_beats_vig for c in cells)
    # Six looks at the data make a 1-in-20 result roughly a 1-in-3 one.
    assert family_p(cells) > best
    assert family_p(cells) == pytest.approx(min(1.0, best * len(cells)))


def test_no_cells_means_no_claim():
    assert family_p([]) == 1.0


# --- who is rateable -------------------------------------------------------------

def test_teams_the_rating_has_barely_seen_are_dropped_from_the_fit():
    """Not cosmetic: a barely-seen team pushes its error into home-field advantage.

    The first run measured college HFA at 6.54 points against the NFL's 1.67. The ridge
    pulls a team with three games toward the league average, and the margin it really
    lost by has to land somewhere -- the only term left is HFA, which then biases every
    prediction in the league.
    """
    from ratings import eligible

    history = [game("A", "B", 3, d) for d in range(12)]
    history += [game("A", "Cupcake", 49, 20)]
    kept = eligible(history, min_team_games=10)
    assert all("Cupcake" not in (g.home, g.away) for g in kept)
    assert len(kept) == 12


def test_no_minimum_means_no_filter():
    history = [game("A", "Cupcake", 49, 0)]
    from ratings import eligible
    assert eligible(history, min_team_games=0) == history


# --- home field, per team --------------------------------------------------------

def test_a_team_with_a_real_home_edge_keeps_some_of_it():
    """Fortress plays every home game 8 points better than its road form.

    Eight teams, not three: with a small field one team's big home edge drags the LEAGUE
    figure up with it, leaving nothing to measure the deviation against. That is a real
    property of the model rather than a flaw -- the deviation is defined relative to the
    league -- but it makes a three-team test measure the wrong thing.

    Expected size, worked out in advance rather than read off the answer: true deviations
    are +8 for Fortress and 0 for seven others, so the league figure absorbs the mean of
    +1 and the centred deviations are +7 and -1. At 105 home games each the shrinkage
    keeps 105/(105+100) = 51%, so Fortress should sit about 4 points above the rest.
    """
    from ratings import HFA_RIDGE

    teams = ["Fortress"] + [f"T{i}" for i in range(7)]
    games: list[Game] = []
    day = 0
    for _ in range(15):
        for home in teams:
            for away in teams:
                if home == away:
                    continue
                margin = 2.0 + (8.0 if home == "Fortress" else 0.0)
                games.append(game(home, away, margin, day))
                day += 1

    model = fit_ratings(games, ridge=1.0, cap=None, half_life=None, hfa_ridge=HFA_RIDGE)
    others = [model.home_edge(t) for t in teams if t != "Fortress"]
    assert model.home_edge("Fortress") > max(others) + 2.5, (
        f"Fortress {model.home_edge('Fortress'):.2f} vs best other {max(others):.2f}"
    )
    # And the effect belongs to home field, not to the team being good: on neutral ground
    # Fortress is nobody special, so its RATING must stay near the others'.
    spread = max(model.ratings.values()) - min(model.ratings.values())
    assert spread < 2.0, f"the home edge leaked into the ratings: spread {spread:.2f}"


def test_a_thin_record_is_pulled_back_to_the_league_figure():
    """The whole reason for the shrinkage.

    Two home games at +20 is not a fortress, it is two games. Without the penalty the fit
    would report it as the best home field in the league and mean nothing by it.
    """
    from ratings import HFA_RIDGE

    games: list[Game] = []
    day = 0
    for _ in range(40):
        games.append(game("A", "B", 3.0, day)); day += 1
        games.append(game("B", "A", 3.0, day)); day += 1
    # Newcomer wins its two home games by 20, and is otherwise unknown.
    games.append(game("Newcomer", "A", 20.0, day)); day += 1
    games.append(game("Newcomer", "B", 20.0, day)); day += 1

    model = fit_ratings(games, ridge=1.0, cap=None, half_life=None, hfa_ridge=HFA_RIDGE)
    # It must not come out anywhere near +20 above the league figure.
    assert model.hfa_deviation["Newcomer"] < 3.0, model.hfa_deviation["Newcomer"]


def test_shrinkage_strength_does_what_it_says():
    from ratings import HFA_RIDGE

    games: list[Game] = []
    day = 0
    for _ in range(30):
        games.append(game("Loud", "Quiet", 10.0, day)); day += 1
        games.append(game("Quiet", "Loud", 0.0, day)); day += 1
    gentle = fit_ratings(games, ridge=1.0, cap=None, half_life=None, hfa_ridge=1.0)
    heavy = fit_ratings(games, ridge=1.0, cap=None, half_life=None, hfa_ridge=HFA_RIDGE * 10)
    assert abs(heavy.hfa_deviation["Loud"]) < abs(gentle.hfa_deviation["Loud"])


def test_one_home_field_for_everybody_unless_asked_otherwise():
    # The default must stay the league-wide fit, so nothing silently gains parameters.
    model = fit_ratings(round_robin({"A": 3.0, "B": -3.0}, hfa=2.0), ridge=0.0,
                        cap=None, half_life=None)
    assert model.hfa_deviation == {}
    assert model.home_edge("A") == model.hfa


def test_a_per_team_fit_still_recovers_the_league_figure():
    # With no team differing from any other, the deviations should be ~0 and the league
    # number should be what it always was.
    from ratings import HFA_RIDGE

    model = fit_ratings(
        round_robin({"A": 4.0, "B": -4.0, "C": 0.0}, hfa=3.0, rounds=8),
        ridge=0.0, cap=None, half_life=None, hfa_ridge=HFA_RIDGE,
    )
    assert model.hfa == pytest.approx(3.0, abs=0.3)
    for team in ("A", "B", "C"):
        assert abs(model.hfa_deviation[team]) < 0.3
