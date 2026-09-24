/**
 * Teams you bet on regardless of what the board says.
 *
 * Worth supporting honestly rather than pretending it is an edge. Betting your team
 * every week is a decision already made — the question is not *whether* but *which
 * market*, and that is a question with a real answer: the same game offers a spread, a
 * moneyline and a total at different prices, and they are not equally good.
 *
 * So this filters rather than recommends. It does not tell you the Lions are a good bet;
 * it tells you which way of backing them costs least, which is the only part of the
 * decision still open.
 */

/**
 * Primary and secondary colours, for the one-favourite theme.
 *
 * Only NFL, and only the primary pair. The full ESPN palette includes near-black and
 * near-white team colours that would make an unreadable interface, so each entry here
 * is a hue the app can actually build a dark theme around — checked against the
 * existing slate background rather than copied from a brand guide.
 */
export interface TeamTheme {
  /** Accent: links, active tab, the positive-number colour. */
  accent: string;
  /** A dimmer companion for rings and borders. */
  muted: string;
}

const NFL_THEMES: Record<string, TeamTheme> = {
  "Detroit Lions": { accent: "#4a9fe0", muted: "#2c5f85" },
  "Green Bay Packers": { accent: "#ffb612", muted: "#6b5410" },
  "Chicago Bears": { accent: "#e8762c", muted: "#8a4519" },
  "Minnesota Vikings": { accent: "#9b7fd4", muted: "#5a4a7a" },
  "Kansas City Chiefs": { accent: "#e8384f", muted: "#8a2130" },
  "Buffalo Bills": { accent: "#5a8ede", muted: "#345285" },
  "Philadelphia Eagles": { accent: "#3ba39c", muted: "#23615d" },
  "Dallas Cowboys": { accent: "#7f9bc1", muted: "#4b5c73" },
  "San Francisco 49ers": { accent: "#d4544f", muted: "#7d322f" },
  "Baltimore Ravens": { accent: "#9b7fd4", muted: "#5a4a7a" },
  "Cincinnati Bengals": { accent: "#f0742a", muted: "#8f4519" },
  "Cleveland Browns": { accent: "#e8813a", muted: "#8a4d22" },
  "Pittsburgh Steelers": { accent: "#ffd043", muted: "#6b5715" },
  "Los Angeles Rams": { accent: "#c9a94f", muted: "#77652f" },
  "Los Angeles Chargers": { accent: "#4fc3e8", muted: "#2f7489" },
  "Las Vegas Raiders": { accent: "#b4b9c2", muted: "#6b6f76" },
  "Denver Broncos": { accent: "#fb7a24", muted: "#954916" },
  "Seattle Seahawks": { accent: "#5fc96b", muted: "#39783f" },
  "Miami Dolphins": { accent: "#3fc6c6", muted: "#267676" },
  "New England Patriots": { accent: "#5b8ed0", muted: "#36547c" },
  "New York Jets": { accent: "#4fbd7e", muted: "#2f714b" },
  "New York Giants": { accent: "#5a8ede", muted: "#345285" },
  "Washington Commanders": { accent: "#f2c14e", muted: "#90732f" },
  "Tampa Bay Buccaneers": { accent: "#e04a3f", muted: "#852c26" },
  "Atlanta Falcons": { accent: "#e8474f", muted: "#8a2a2f" },
  "New Orleans Saints": { accent: "#d3bc8d", muted: "#7e7054" },
  "Carolina Panthers": { accent: "#3fb6e8", muted: "#266d8a" },
  "Houston Texans": { accent: "#5b8ed0", muted: "#36547c" },
  "Indianapolis Colts": { accent: "#5a9fe0", muted: "#355f85" },
  "Tennessee Titans": { accent: "#5aa9e6", muted: "#36658a" },
  "Jacksonville Jaguars": { accent: "#37b6b6", muted: "#216d6d" },
  "Arizona Cardinals": { accent: "#e05a6e", muted: "#853642" },
};

export function teamTheme(team: string | null | undefined): TeamTheme | null {
  if (!team) return null;
  return NFL_THEMES[team] ?? null;
}

export function themedTeams(): string[] {
  return Object.keys(NFL_THEMES).sort();
}

export function parseFavourites(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const value = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.map((t: unknown) => String(t).slice(0, 60)))]
      .filter(Boolean)
      .slice(0, 8);
  } catch {
    return [];
  }
}

export function serializeFavourites(teams: string[]): string {
  return JSON.stringify([...new Set(teams.map((t) => String(t).slice(0, 60)))].slice(0, 8));
}

/**
 * The theme applies only when exactly one team is chosen.
 *
 * Two favourites have no single colour, and picking the first would be arbitrary in a
 * way the interface could not explain. Better to stay neutral than to pick for you.
 */
export function themeFor(favourites: string[]): TeamTheme | null {
  return favourites.length === 1 ? teamTheme(favourites[0]) : null;
}

/** Just enough of a bet to tell which team it backs. */
export interface SidedBet {
  market: string;
  side: string;
  homeTeam: string | null;
  awayTeam: string | null;
}

function sameTeam(a: string | null | undefined, b: string): boolean {
  return !!a && a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * The team of yours this bet is against, or null.
 *
 * A bet is against your team when it backs their opponent: the other side's spread or
 * moneyline. The app then never suggests it. A fan who would rather not root against
 * their own team has made a decision before the app ever opens, and the app has nothing
 * to weigh against it. The cost is measured rather than assumed to be zero: passing on
 * the Jets at +265 against the Lions was worth about a dollar of boost value. That is
 * rarely more, because the edges here are small, and it is a price worth paying to
 * enjoy the game.
 *
 * Totals are never against anybody. An over or an under picks no side, and treating an
 * under as rooting against your offence would stretch "against" past what it means.
 *
 * With both teams in your list, every side bet on the game is against one of them, so
 * the whole game's sides are skipped. That follows from the rule rather than being a
 * special case.
 */
export function betsAgainst(bet: SidedBet, favourites: string[]): string | null {
  if (favourites.length === 0) return null;
  if (bet.market !== "spread" && bet.market !== "moneyline") return null;
  const opponent =
    bet.side === "home" ? bet.awayTeam : bet.side === "away" ? bet.homeTeam : null;
  if (!opponent) return null;
  return favourites.find((team) => sameTeam(opponent, team)) ?? null;
}
