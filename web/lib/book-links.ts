/**
 * Opening the book you are being told to bet at.
 *
 * These link to the SPORTSBOOK, not to the bet. That limitation is real and worth
 * stating rather than papering over: every id in this app comes from ESPN or the odds
 * feed, and no book exposes a way to turn one into a link to their own market. FanDuel
 * and BetMGM address events by their own internal ids, which are not in anything
 * collected here and are not derivable from a team name and a kickoff time.
 *
 * A `fanduel://event/<espn id>` would be easy to write and would go nowhere. A link
 * that silently fails is worse than no link at all, because you only discover it while
 * standing in front of the bet you meant to place.
 *
 * What these DO buy is the hop. They are ordinary https links to each book's mobile
 * site, which iOS Universal Links and Android App Links hand straight to the installed
 * app; without the app they open the site logged in. One tap instead of hunting for the
 * icon, and then you find the game yourself.
 *
 * Books are matched loosely because the feed's spelling is not guaranteed: "BetMGM",
 * "betmgm" and "BetMGM Sportsbook" have all appeared.
 */

interface BookSite {
  /** Matched against a lowercased, non-alphanumeric-stripped book name. */
  key: string;
  label: string;
  url: string;
}

const SITES: BookSite[] = [
  { key: "fanduel", label: "FanDuel", url: "https://sportsbook.fanduel.com/" },
  { key: "betmgm", label: "BetMGM", url: "https://sports.betmgm.com/en/sports" },
  { key: "betrivers", label: "BetRivers", url: "https://betrivers.com/" },
  { key: "draftkings", label: "DraftKings", url: "https://sportsbook.draftkings.com/" },
  { key: "caesars", label: "Caesars", url: "https://sportsbook.caesars.com/" },
  { key: "espnbet", label: "ESPN BET", url: "https://espnbet.com/" },
  { key: "pointsbet", label: "PointsBet", url: "https://pointsbet.com/" },
  { key: "bovada", label: "Bovada", url: "https://www.bovada.lv/sports" },
  { key: "betonlineag", label: "BetOnline", url: "https://www.betonline.ag/sportsbook" },
  { key: "lowvigag", label: "LowVig", url: "https://www.lowvig.ag/" },
  { key: "mybookieag", label: "MyBookie", url: "https://mybookie.ag/sportsbook/" },
  { key: "betus", label: "BetUS", url: "https://www.betus.com.pa/sportsbook/" },
];

function normalise(book: string): string {
  return book.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** The book's own site, or null when it is not one we know how to open. */
export function bookLink(book: string | null | undefined): string | null {
  if (!book) return null;
  const key = normalise(book);
  // Longest key first, so "betonlineag" is not swallowed by a shorter prefix match.
  const found = [...SITES]
    .sort((a, b) => b.key.length - a.key.length)
    .find((site) => key.includes(site.key) || site.key.includes(key));
  return found?.url ?? null;
}

/** Whether this book is one you hold an account at and can act on in one tap. */
export function knownBook(book: string | null | undefined): boolean {
  return bookLink(book) !== null;
}
