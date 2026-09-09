"""Matching one source's games to another's.

Everything in this repo joins on ESPN's numeric ``event_id``. An odds feed has its own
ids and only team *names*, so something has to bridge them, and that something is the
weakest link in the whole pipeline: a game that fails to match records no second book,
and the app then says "only one book has priced this game" -- which reads exactly like
"the books agree". An error that presents as a finding is the failure mode this project
keeps running into, so the rules here are deliberately conservative:

* both teams must match, not just one;
* the match must be *unambiguous* -- if a second candidate scores nearly as well, the
  pair is rejected rather than resolved by tie-break;
* kickoff must agree to within a few hours;
* and everything rejected is returned, named, so the caller can report it rather than
  quietly show a thinner board.

Refusing to guess is the point. A missed match costs one game's comparison; a wrong one
prices a team against a different team's line and calls the difference an edge.

Pure functions only -- no network, no database -- because this is the part worth testing
hardest.
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from datetime import datetime, timedelta
from difflib import SequenceMatcher
from typing import Iterable, Sequence

#: Names a feed spells differently from ESPN, mapped onto ESPN's spelling.
#:
#: Deliberately EMPTY at the start. Every entry here should come from a name observed to
#: fail in a real run and then checked by hand -- guessing at a hundred and thirty
#: college programmes in advance would bake in mistakes that no test could catch, and
#: `match_events` already reports what it could not place so this list can grow from
#: evidence. Keys and values are compared after `normalize`.
ALIASES: dict[str, str] = {
    # The feed calls them UMass, ESPN calls them Massachusetts. Similarity 0.7368
    # against a 0.75 threshold -- it failed by one hundredth, on a real Saturday
    # slate, and the game showed as "only one book has priced this" rather than as a
    # matching error.
    #
    # Fixed with an entry rather than by lowering the threshold. 0.74 is genuinely
    # close to the level where different schools start colliding, and buying this one
    # match by loosening everything is how "Miami Hurricanes" eventually matches
    # "Miami RedHawks".
    "umass minutemen": "massachusetts minutemen",
}

#: Token substitutions that are safe because they never change which school is meant.
#: Note what is *not* here: no dropping of mascots (Miami Hurricanes and Miami RedHawks
#: are different schools), and no stripping of directions (North/South Carolina).
_TOKEN_EQUIVALENTS = {
    "st": "state",
    "st.": "state",
    "univ": "university",
    "u": "university",
    "intl": "international",
    "&": "and",
    "a&m": "aandm",
}

_DROP_TOKENS = {"university", "the", "of", "at"}

#: Apostrophes are deleted rather than turned into a space, because they sit *inside*
#: words: Hawai'i and Ragin' Cajuns must stay one token each. Everything else -- hyphens,
#: parentheses, periods -- separates words and becomes a space.
_APOSTROPHES = re.compile(r"['‘’ʻʼ]")
_PUNCTUATION = re.compile(r"[^\w\s&]+", re.UNICODE)
_WHITESPACE = re.compile(r"\s+")


def normalize(name: str | None) -> str:
    """Casefold a team name down to comparable tokens.

    Strips accents and punctuation, applies the safe token substitutions above, and
    drops filler words. ``Hawai'i Rainbow Warriors`` and ``Hawaii Rainbow Warriors``
    land on the same string; ``Miami Hurricanes`` and ``Miami RedHawks`` do not.
    """
    if not name:
        return ""
    # Decompose accents and drop the combining marks: Hawai'i, Jose, Munoz.
    folded = unicodedata.normalize("NFKD", str(name))
    folded = "".join(ch for ch in folded if not unicodedata.combining(ch))
    folded = folded.replace("&", " and ").casefold()
    folded = _APOSTROPHES.sub("", folded)
    folded = _PUNCTUATION.sub(" ", folded)

    tokens: list[str] = []
    for token in _WHITESPACE.sub(" ", folded).strip().split(" "):
        token = _TOKEN_EQUIVALENTS.get(token, token)
        if token and token not in _DROP_TOKENS:
            tokens.append(token)

    normalized = " ".join(tokens)
    return ALIASES.get(normalized, normalized)


def similarity(left: str | None, right: str | None) -> float:
    """How alike two team names are, 0-1.

    Two measures, taking the larger. Token overlap catches word-order and extra-word
    differences (``Miami Ohio RedHawks`` against ``Miami OH RedHawks``); character ratio
    catches spelling drift within a word (``Massachusetts`` against ``UMass``). Either
    alone has a blind spot the other covers.
    """
    a, b = normalize(left), normalize(right)
    if not a or not b:
        return 0.0
    if a == b:
        return 1.0

    left_tokens, right_tokens = set(a.split()), set(b.split())
    shared = left_tokens & right_tokens
    # Divided by the SMALLER set, so a name that is a strict subset of the other scores
    # 1.0 on this measure -- "Miami RedHawks" inside "Miami Ohio RedHawks". The
    # both-teams-must-match rule is what keeps that from being reckless.
    overlap = len(shared) / min(len(left_tokens), len(right_tokens))
    return max(overlap, SequenceMatcher(None, a, b).ratio())


@dataclass(frozen=True)
class Candidate:
    """One game from either source, reduced to what matching needs."""
    key: str
    home: str | None
    away: str | None
    commence_time: datetime


@dataclass(frozen=True)
class Match:
    feed_key: str
    espn_key: str
    score: float


@dataclass(frozen=True)
class Unmatched:
    feed_key: str
    home: str | None
    away: str | None
    commence_time: datetime
    reason: str
    #: The best score seen, so a near-miss can be told apart from nothing close.
    best_score: float = 0.0
    best_home: str | None = None
    best_away: str | None = None

    def describe(self) -> str:
        near = ""
        if self.best_home or self.best_away:
            near = f" Closest was {self.best_away} @ {self.best_home} at {self.best_score:.2f}."
        return f"{self.away} @ {self.home} ({self.reason}).{near}"


def pair_score(feed: Candidate, espn: Candidate) -> float:
    """Score a candidate pairing on its *weaker* side.

    The minimum, not the mean: a pairing that nails the home team and is vague about the
    away team is not a good match, and averaging would let a 1.0 carry a 0.5.
    """
    return min(similarity(feed.home, espn.home), similarity(feed.away, espn.away))


def match_events(
    feed: Sequence[Candidate],
    espn: Sequence[Candidate],
    *,
    window_hours: float = 6.0,
    threshold: float = 0.75,
    margin: float = 0.08,
) -> tuple[list[Match], list[Unmatched]]:
    """Pair feed games to ESPN games, refusing anything doubtful.

    ``threshold`` is the score both teams must clear. ``margin`` is how far ahead the
    best candidate must be before it counts as unambiguous -- two games scoring 0.80 and
    0.79 mean the names cannot tell them apart, and picking the larger would be a coin
    flip dressed as a decision. ``window_hours`` bounds kickoff disagreement; sources
    schedule the same game to the minute, so this is generous.

    An ESPN game is claimed at most once. Pairs are settled best-score-first, so a
    strong match takes its game before a weaker one can.
    """
    window = timedelta(hours=window_hours)

    scored: list[tuple[float, Candidate, Candidate]] = []
    diagnostics: dict[str, tuple[float, Candidate | None]] = {}

    for game in feed:
        best_overall = (0.0, None)
        for other in espn:
            if abs(game.commence_time - other.commence_time) > window:
                continue
            score = pair_score(game, other)
            if score > best_overall[0]:
                best_overall = (score, other)
            if score >= threshold:
                scored.append((score, game, other))
        diagnostics[game.key] = best_overall

    # Strongest pairings first, so the confident ones claim their games.
    scored.sort(key=lambda row: row[0], reverse=True)

    best_for_feed: dict[str, list[tuple[float, Candidate]]] = {}
    for score, game, other in scored:
        best_for_feed.setdefault(game.key, []).append((score, other))

    matches: list[Match] = []
    unmatched: list[Unmatched] = []
    claimed: set[str] = set()
    matched_feed: set[str] = set()

    for score, game, other in scored:
        if game.key in matched_feed or other.key in claimed:
            continue
        # Ambiguity check: a runner-up within `margin` means the names do not identify
        # the game, whatever the leader's absolute score.
        rivals = [s for s, cand in best_for_feed.get(game.key, [])
                  if cand.key != other.key and cand.key not in claimed]
        if rivals and score - max(rivals) < margin:
            continue
        matches.append(Match(game.key, other.key, score))
        matched_feed.add(game.key)
        claimed.add(other.key)

    for game in feed:
        if game.key in matched_feed:
            continue
        best_score, best = diagnostics.get(game.key, (0.0, None))
        if best is None:
            reason = "no ESPN game within the kickoff window"
        elif best_score < threshold:
            reason = "no name match above threshold"
        else:
            reason = "ambiguous: two ESPN games score alike"
        unmatched.append(Unmatched(
            game.key, game.home, game.away, game.commence_time, reason,
            best_score, best.home if best else None, best.away if best else None,
        ))

    return matches, unmatched


def summarize_unmatched(rows: Iterable[Unmatched], limit: int = 10) -> str:
    """A one-line report naming what failed, for the log and the run summary.

    Names, not counts: the whole reason to surface these is so the strings that need an
    `ALIASES` entry can be read straight out of the run.
    """
    rows = list(rows)
    if not rows:
        return "all feed games matched"
    shown = "; ".join(row.describe() for row in rows[:limit])
    more = f" (+{len(rows) - limit} more)" if len(rows) > limit else ""
    return f"{len(rows)} unmatched: {shown}{more}"
