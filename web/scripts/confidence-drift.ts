/**
 * How much do confidence picks move between Tuesday and kickoff?
 *
 * For each finished NFL week this season, rebuilds the confidence card (`rankConfidence`)
 * and the weekly-pot underdog (`weeklyPick`) from the DraftKings moneylines as they
 * stood at three moments -- Tuesday evening, an hour before the week's first kickoff
 * (when a pool's picks are due), and each game's own last pregame line (the close) --
 * and reports how far the card moved and what deciding early cost, scored at the close.
 *
 * Read-only. Prints counts and averages only: no teams, no prices (public Actions logs).
 * Env: DATABASE_URL.
 */
import { rankConfidence, weeklyPick, weekWindow, type ConfidenceGame, type ConfidencePick } from "../lib/confidence";
import { deVig } from "../lib/probability";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const SNAPSHOTS = `
SELECT event_id, commence_time, home_team, away_team, side, price, observed_at
  FROM odds_snapshots
 WHERE league = 'nfl' AND market = 'moneyline' AND observation_kind = 'pregame_observation'
   AND commence_time >= NOW() - INTERVAL '70 days' AND commence_time < NOW() - INTERVAL '4 hours'
 ORDER BY observed_at`;

type Obs = { t: number; side: string; price: number };
type Event = { id: string; kickoff: number; home: string; away: string; obs: Obs[] };
type Entry = Array<{ eventId: string; team: string; points: number }>;

/** Home chance from the latest home and away prices observed at or before `at`. */
function chanceAt(e: Event, at: number): number | null {
  let home: number | null = null;
  let away: number | null = null;
  for (const o of e.obs) {
    if (o.t > at) break;
    if (o.side === "home") home = o.price;
    if (o.side === "away") away = o.price;
  }
  const fair = deVig(home, away);
  return fair ? fair.a : null;
}

function card(events: Event[], at: (e: Event) => number): ConfidenceGame[] {
  const games: ConfidenceGame[] = [];
  for (const e of events) {
    const p = chanceAt(e, at(e));
    if (p === null) continue;
    games.push({
      eventId: e.id,
      commenceTime: new Date(e.kickoff).toISOString(),
      home: e.home,
      away: e.away,
      homeChance: p,
      source: "market",
      books: 1,
    });
  }
  return games;
}

/** Expected points of a card, scored with the closing chances. */
function scoreAtClose(entry: Entry, close: Map<string, ConfidenceGame>): number {
  return entry.reduce((sum, e) => {
    const g = close.get(e.eventId);
    if (!g) return sum;
    return sum + e.points * (e.team === g.home ? g.homeChance : 1 - g.homeChance);
  }, 0);
}

const asEntry = (picks: ConfidencePick[]): Entry =>
  picks.map((p) => ({ eventId: p.game.eventId, team: p.team, points: p.points }));

function weeklyEntry(picks: ConfidencePick[]): Entry {
  const w = weeklyPick(picks, 0);
  return w ? w.entry.map((e) => ({ eventId: e.pick.game.eventId, team: e.team, points: e.points })) : asEntry(picks);
}

async function main() {
  const { Pool } = await import("pg");
  const db = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  const rows = (await db.query(SNAPSHOTS)).rows as Array<Record<string, unknown>>;
  await db.end();

  const events = new Map<string, Event>();
  for (const r of rows) {
    const id = String(r.event_id);
    const e = events.get(id) ?? {
      id,
      kickoff: new Date(r.commence_time as string).getTime(),
      home: String(r.home_team),
      away: String(r.away_team),
      obs: [],
    };
    if (r.price !== null) e.obs.push({ t: new Date(r.observed_at as string).getTime(), side: String(r.side), price: Number(r.price) });
    events.set(id, e);
  }
  const weeks = new Map<number, Event[]>();
  for (const e of events.values()) {
    const { start } = weekWindow(new Date(e.kickoff));
    weeks.set(start, [...(weeks.get(start) ?? []), e]);
  }

  const t = { weeks: 0, games: 0, dogTue: 0, dogDeadline: 0, top3: 0, flips: 0, moved1: 0, moved3: 0, shift: 0, lossRanked: 0, lossWeekly: 0, dogGap: 0 };
  console.log("week   games  tue-priced  dog same tue/deadline  top3 same  fav flips  moved 1+/3+  avg shift  pts lost ranked/weekly  deadline dog at close");
  for (const [start, list] of [...weeks.entries()].sort((a, b) => a[0] - b[0])) {
    if (list.length < 10) continue; // a partial week at the edge of the window
    const firstKick = Math.min(...list.map((e) => e.kickoff));
    const tue = start + 6 * 3_600_000;
    const deadline = firstKick - 3_600_000;
    const closeGames = card(list, (e) => e.kickoff);
    const close = new Map(closeGames.map((g) => [g.eventId, g]));
    const atClose = rankConfidence(closeGames).picks;
    const atDeadline = rankConfidence(card(list, (e) => Math.min(deadline, e.kickoff))).picks;
    const atTue = rankConfidence(card(list, () => tue)).picks;
    if (atDeadline.length < closeGames.length - 1) continue;

    const dog = (picks: ConfidencePick[]) => weeklyPick(picks, 0)?.dog;
    const same = (a?: { pick: ConfidencePick; team: string }, b?: { pick: ConfidencePick; team: string }) =>
      !!a && !!b && a.pick.game.eventId === b.pick.game.eventId && a.team === b.team;
    const dClose = dog(atClose);
    const dDead = dog(atDeadline);
    const sameDead = same(dClose, dDead);
    const sameTue = same(dClose, dog(atTue));
    const top3 = (p: ConfidencePick[]) => p.slice(0, 3).map((x) => x.game.eventId + x.team).sort().join();
    const top3Same = top3(atDeadline) === top3(atClose);

    const slotClose = new Map(atClose.map((p, i) => [p.game.eventId, { i, team: p.team }]));
    let flips = 0;
    let moved1 = 0;
    let moved3 = 0;
    let shift = 0;
    atDeadline.forEach((p, i) => {
      const c = slotClose.get(p.game.eventId);
      if (!c) return;
      if (c.team !== p.team) flips += 1;
      const d = Math.abs(c.i - i);
      shift += d;
      if (d >= 1) moved1 += 1;
      if (d >= 3) moved3 += 1;
    });
    const lossRanked = scoreAtClose(asEntry(atClose), close) - scoreAtClose(asEntry(atDeadline), close);
    const lossWeekly = scoreAtClose(weeklyEntry(atClose), close) - scoreAtClose(weeklyEntry(atDeadline), close);
    const dg = dDead ? close.get(dDead.pick.game.eventId) : undefined;
    const dogAtClose = dg && dDead ? (dDead.team === dg.home ? dg.homeChance : 1 - dg.homeChance) : null;

    const n = atDeadline.length;
    console.log(
      [
        new Date(start).toISOString().slice(5, 10),
        String(n).padStart(6),
        String(atTue.length).padStart(11),
        `${sameTue ? "yes" : "no"}/${sameDead ? "yes" : "no"}`.padStart(22),
        (top3Same ? "yes" : "no").padStart(10),
        String(flips).padStart(10),
        `${moved1}/${moved3}`.padStart(12),
        (shift / n).toFixed(2).padStart(10),
        `${lossRanked.toFixed(2)}/${lossWeekly.toFixed(2)}`.padStart(23),
        dogAtClose === null ? "" : `${(dogAtClose * 100).toFixed(0)}%`.padStart(22),
      ].join(" "),
    );
    t.weeks += 1;
    t.games += n;
    t.dogTue += sameTue ? 1 : 0;
    t.dogDeadline += sameDead ? 1 : 0;
    t.top3 += top3Same ? 1 : 0;
    t.flips += flips;
    t.moved1 += moved1;
    t.moved3 += moved3;
    t.shift += shift;
    t.lossRanked += lossRanked;
    t.lossWeekly += lossWeekly;
    t.dogGap += dogAtClose === null ? 0 : Math.abs(dogAtClose - 0.35);
  }
  if (t.weeks === 0) {
    console.log("No complete weeks with stored moneylines.");
    return;
  }
  console.log(`\n${t.weeks} weeks, ${t.games} games.`);
  console.log(`Underdog for 16 unchanged Tuesday -> close: ${t.dogTue}/${t.weeks}; deadline -> close: ${t.dogDeadline}/${t.weeks}.`);
  console.log(`Top three unchanged deadline -> close: ${t.top3}/${t.weeks}. Favourite flipped after the deadline: ${t.flips} games.`);
  console.log(`Games that changed slot after the deadline: ${t.moved1} (${((100 * t.moved1) / t.games).toFixed(0)}%), 3+ slots: ${t.moved3}; average shift ${(t.shift / t.games).toFixed(2)} slots.`);
  console.log(`Expected points lost by locking at the deadline instead of the close: ${(t.lossRanked / t.weeks).toFixed(2)}/week ranked, ${(t.lossWeekly / t.weeks).toFixed(2)}/week weekly plan.`);
  console.log(`The deadline's underdog closed on average ${((100 * t.dogGap) / t.weeks).toFixed(1)} points from 35%.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
