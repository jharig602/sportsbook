/**
 * Live scores from ESPN's public scoreboard, for pricing bets mid-game.
 *
 * One request per league covers every game, and it is cached for 45 seconds across
 * every visitor, so however often the Bets page is refreshed ESPN sees at most a request
 * or two a minute -- against the ~195 the collector already makes each cycle. It is only
 * called when an open ticket has a game under way.
 *
 * The site API sits behind bot management that 403s bare clients; the headers are the
 * set the collector verified (`ESPN_BROWSER_HEADERS` in odds_poller.py) and the
 * `limit`/`groups` rules are the same ones it learned (a larger limit silently truncates
 * college to 25 games).
 *
 * The site API is also where ESPN's bot management lives, and it turned out to refuse
 * Vercel's servers outright on the first live Saturday (it answers the collector on
 * GitHub, and a home connection). So any game the scoreboard did not return is read from
 * the core API instead, which has no such gate (noted in odds_poller.py): the
 * competition, its status and the two scores -- four small requests per game, for the
 * games you hold money on only, cached the same 45 seconds.
 *
 * Fails soft, always: a timeout, a block or a changed schema returns an empty map, and
 * the page falls back to the pregame value with a note. Never a guessed score.
 */
import type { LiveGame } from "./live-value";

const SITE_API = "https://site.api.espn.com/apis/site/v2/sports/football";
const PATHS: Record<string, { path: string; group?: string }> = {
  nfl: { path: "nfl" },
  ncaaf: { path: "college-football", group: "80" },
};
const HEADERS = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "en-US,en;q=0.9",
  Referer: "https://www.espn.com/",
  Origin: "https://www.espn.com",
  "Sec-Fetch-Dest": "empty",
  "Sec-Fetch-Mode": "cors",
  "Sec-Fetch-Site": "same-site",
  "sec-ch-ua": '"Chromium";v="140", "Not=A?Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
};

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseScoreboard(data: any): LiveGame[] {
  const out: LiveGame[] = [];
  for (const ev of Array.isArray(data?.events) ? data.events : []) {
    const comp = ev?.competitions?.[0];
    const status = comp?.status ?? ev?.status;
    const state = status?.type?.state;
    if (state !== "pre" && state !== "in" && state !== "post") continue;
    const teams = Array.isArray(comp?.competitors) ? comp.competitors : [];
    const home = teams.find((c: any) => c?.homeAway === "home");
    const away = teams.find((c: any) => c?.homeAway === "away");
    const homeScore = Number(home?.score);
    const awayScore = Number(away?.score);
    if (!ev?.id || !Number.isFinite(homeScore) || !Number.isFinite(awayScore)) continue;
    out.push({
      eventId: String(ev.id),
      state,
      period: Number(status?.period) || 0,
      clockSeconds: Number(status?.clock) || 0,
      homeScore,
      awayScore,
      detail: String(status?.type?.shortDetail ?? status?.type?.detail ?? ""),
      homeAbbr: String(home?.team?.abbreviation ?? "HOME"),
      awayAbbr: String(away?.team?.abbreviation ?? "AWAY"),
    });
  }
  return out;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

const CORE_API = "https://sports.core.api.espn.com/v2/sports/football/leagues";

/* eslint-disable @typescript-eslint/no-explicit-any */
async function coreJson(url: string): Promise<any> {
  // The API hands back its own links as http://; ask for https.
  const response = await fetch(url.replace(/^http:/, "https:"), {
    next: { revalidate: 45 },
    signal: AbortSignal.timeout(4000),
  });
  if (!response.ok) throw new Error(`core ${response.status}`);
  return response.json();
}

/** One game from the core API, or null. No abbreviations: those would cost two more calls. */
export async function coreGame(league: string, eventId: string): Promise<LiveGame | null> {
  const target = PATHS[league];
  if (!target || !/^\d+$/.test(eventId)) return null;
  try {
    const comp = await coreJson(`${CORE_API}/${target.path}/events/${eventId}/competitions/${eventId}`);
    const teams = Array.isArray(comp?.competitors) ? comp.competitors : [];
    const home = teams.find((c: any) => c?.homeAway === "home");
    const away = teams.find((c: any) => c?.homeAway === "away");
    if (!comp?.status?.$ref || !home?.score?.$ref || !away?.score?.$ref) return null;
    const [status, homeScore, awayScore] = await Promise.all([
      coreJson(comp.status.$ref),
      coreJson(home.score.$ref),
      coreJson(away.score.$ref),
    ]);
    const state = status?.type?.state;
    if (state !== "pre" && state !== "in" && state !== "post") return null;
    const h = Number(homeScore?.value);
    const a = Number(awayScore?.value);
    if (!Number.isFinite(h) || !Number.isFinite(a)) return null;
    return {
      eventId,
      state,
      period: Number(status?.period) || 0,
      clockSeconds: Number(status?.clock) || 0,
      homeScore: h,
      awayScore: a,
      detail: String(status?.type?.shortDetail ?? ""),
      homeAbbr: "",
      awayAbbr: "",
    };
  } catch {
    return null;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Live state for these games: the league scoreboards first, then the core API for any
 * game they did not return. Missing games are simply absent.
 */
export async function liveGamesFor(
  wanted: Array<{ eventId: string; league: string }>,
): Promise<Map<string, LiveGame>> {
  const out = await liveGames(wanted.map((w) => w.league));
  const missing = wanted.filter((w, i) => !out.has(w.eventId) && wanted.findIndex((x) => x.eventId === w.eventId) === i);
  const found = await Promise.all(missing.map((w) => coreGame(w.league, w.eventId)));
  for (const game of found) if (game) out.set(game.eventId, game);
  return out;
}

/** Today's games for these leagues, by ESPN event id. Empty on any failure. */
export async function liveGames(leagues: Iterable<string>): Promise<Map<string, LiveGame>> {
  const out = new Map<string, LiveGame>();
  await Promise.all(
    [...new Set(leagues)].map(async (league) => {
      const target = PATHS[league];
      if (!target) return;
      const url = new URL(`${SITE_API}/${target.path}/scoreboard`);
      url.searchParams.set("limit", "300");
      if (target.group) url.searchParams.set("groups", target.group);
      try {
        const response = await fetch(url, {
          headers: HEADERS,
          next: { revalidate: 45 },
          signal: AbortSignal.timeout(4000),
        });
        if (!response.ok) return;
        for (const game of parseScoreboard(await response.json())) out.set(game.eventId, game);
      } catch {
        // Soft by design: the pregame value stands, and the page says so.
      }
    }),
  );
  return out;
}
