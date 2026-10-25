/**
 * What a logged bet must look like: the Bets form's rules, shared.
 *
 * Moved out of `/api/bets` so the Claude connector's `log_bet` (mcp-write.ts) runs exactly
 * the checks the form does -- a ticket the form would refuse cannot arrive another way.
 * Validation is strict and the errors say what is wrong, because a bet silently rejected
 * or silently mangled is worse than one refused: the whole point of the ledger is that
 * what it holds matches what was actually placed.
 */
import { sameGameProblem } from "./parlay";
import type { Bet } from "./settle";

export const MARKETS = new Set(["spread", "total", "moneyline", "prop"]);
/** Prop stats the ledger knows (props.ts keys). A prop is over/under a number of these. */
export const PROP_STATS = new Set([
  "anytime_td", "first_td", "pass_yds", "pass_tds", "rush_yds", "rec_yds", "rush_rec_yds", "receptions",
]);
export const SIDES = new Set(["home", "away", "over", "under", "odd", "even"]);
/** Total points odd/even: a total with no line. */
export const PARITY = new Set(["odd", "even"]);

/**
 * A prop leg's own problems, or none. Player and stat are required (they are the whole
 * question), the side is over or under, and the line is the stat's number: 274.5 for
 * "275+ passing yards", 0.5 for an anytime TD.
 */
export function propProblems(leg: Record<string, unknown>, at: string): string[] {
  const problems: string[] = [];
  const player = String(leg.prop_player ?? "").trim();
  if (!player || player.length > 60) problems.push(`${at}: name the player.`);
  if (!PROP_STATS.has(String(leg.prop_stat ?? ""))) problems.push(`${at}: pick the stat.`);
  if (leg.side !== "over" && leg.side !== "under") problems.push(`${at}: a prop is over or under.`);
  const line = Number(leg.line);
  if (leg.line === null || leg.line === "" || !Number.isFinite(line) || line < 0) {
    problems.push(`${at}: a prop needs its number (274.5 for 275+, 0.5 for a TD).`);
  }
  return problems;
}

/**
 * Whose points a total is about, or null for the game's.
 *
 * Returns `undefined` when the value makes no sense, which the caller reports -- a
 * silently dropped team would store a team total as a game total and grade it against
 * the wrong number entirely, with nothing on screen to show it had happened.
 */
export function readTeam(raw: unknown, market: string): "home" | "away" | null | undefined {
  if (raw === undefined || raw === null || raw === "") return null;
  if (market !== "total") return undefined;
  return raw === "home" || raw === "away" ? raw : undefined;
}

/** A parlay leg's own price: absent is fine (null), a bad one is `undefined`. */
export function legPrice(raw: unknown): number | null | undefined {
  if (raw === undefined || raw === null || raw === "") return null;
  const price = Number(raw);
  return Number.isFinite(price) && Math.abs(price) >= 100 ? price : undefined;
}

/**
 * When it was actually struck, defaulting to now.
 *
 * Worth accepting rather than always stamping the clock, because a bet logged the next
 * morning is still yesterday's bet -- and the promotion's day counter is built from these
 * dates. Bounded in both directions: the future is not a time a bet was struck, and
 * anything older than the season is a typo rather than a memory.
 */
export function readPlacedAt(raw: unknown, now: Date, problems: string[]): string {
  if (raw === undefined || raw === null || raw === "") return now.toISOString();
  const when = new Date(String(raw));
  const age = now.getTime() - when.getTime();
  if (Number.isNaN(when.getTime())) problems.push("placed_at is not a date.");
  else if (age < -60 * 60 * 1000) problems.push("placed_at is in the future.");
  else if (age > 180 * 24 * 60 * 60 * 1000) problems.push("placed_at is more than 180 days ago.");
  else return when.toISOString();
  return now.toISOString();
}

/**
 * A parlay: its legs plus one combined price, validated leg by leg with the same rules a
 * single bet gets, because each leg is graded on its own and a leg with a bad line
 * settles wrongly just as loudly.
 */
export function parseParlay(
  body: Record<string, unknown>,
  newId: () => string,
  now: Date = new Date(),
): { problems: string[]; rows: Bet[] } {
  const legs = body.legs as Array<Record<string, unknown>>;
  const stake = Number(body.stake);
  const parlayPrice = Number(body.parlay_price);
  const problems: string[] = [];
  if (legs.length < 2) problems.push("A parlay needs at least two legs.");
  if (!Number.isFinite(stake) || stake <= 0) problems.push("Stake must be more than zero.");
  if (!Number.isFinite(parlayPrice) || Math.abs(parlayPrice) < 100) {
    problems.push("The combined price must be American odds of at least +100 or -100.");
  }
  // Same-game legs are accepted. The ticket settles off the book's own combined price
  // and whether every leg won, so correlation never enters the grading -- only the
  // pricing, which is the builder's job. What is refused is a ticket that cannot win.
  const contradiction = sameGameProblem(
    legs.map((l) => ({
      event_id: String(l.event_id ?? ""),
      // A prop is keyed by its player and stat too: two players' TDs are two legs,
      // not the same leg twice.
      market: l.market === "prop" ? `prop:${String(l.prop_player ?? "").trim()}:${String(l.prop_stat ?? "")}` : String(l.market ?? ""),
      side: String(l.side ?? ""),
      // Absent, null and blank all mean "no line": Number(undefined) is NaN, and NaN never
      // equals itself, so two opposite moneylines without a line field slipped through.
      line: l.line === null || l.line === "" || l.line === undefined ? null : Number(l.line),
    })),
  );
  if (contradiction) problems.push(contradiction);
  for (const [i, leg] of legs.entries()) {
    const market = String(leg.market ?? "");
    const side = String(leg.side ?? "");
    const line = leg.line === null || leg.line === "" || leg.line === undefined ? null : Number(leg.line);
    if (!leg.event_id) problems.push(`Leg ${i + 1}: pick a game.`);
    if (!MARKETS.has(market)) problems.push(`Leg ${i + 1}: bad market.`);
    if (!SIDES.has(side)) problems.push(`Leg ${i + 1}: bad side.`);
    // A leg's own price is optional: a same-game slip usually shows only the combined
    // price, and the ticket settles off that. When given, it must be a real price.
    if (legPrice(leg.price) === undefined) problems.push(`Leg ${i + 1}: bad price.`);
    if (market === "prop") {
      problems.push(...propProblems(leg, `Leg ${i + 1}`));
      continue;
    }
    if (market !== "moneyline" && !PARITY.has(side) && (line === null || !Number.isFinite(line))) {
      problems.push(`Leg ${i + 1}: a spread or total needs a line.`);
    }
    if (PARITY.has(side) && market !== "total") problems.push(`Leg ${i + 1}: odd/even is a total.`);
    if (readTeam(leg.team, market) === undefined) {
      problems.push(`Leg ${i + 1}: a team total must name home or away.`);
    }
  }
  const placedAt = readPlacedAt(body.placed_at, now, problems);
  if (problems.length > 0) return { problems, rows: [] };

  const parlayId = newId();
  const rows: Bet[] = legs.map((leg) => ({
    bet_id: newId(),
    placed_at: placedAt,
    league: String(leg.league ?? "ncaaf"),
    event_id: String(leg.event_id),
    home_team: (leg.home_team as string) ?? null,
    away_team: (leg.away_team as string) ?? null,
    commence_time: (leg.commence_time as string) ?? null,
    market: String(leg.market) as Bet["market"],
    side: String(leg.side) as Bet["side"],
    team: leg.market === "prop" ? null : (readTeam(leg.team, String(leg.market)) ?? null),
    line: leg.market === "moneyline" || PARITY.has(String(leg.side)) ? null : Number(leg.line),
    price: legPrice(leg.price) ?? null,
    prop_player: leg.market === "prop" ? String(leg.prop_player).trim() : null,
    prop_stat: leg.market === "prop" ? String(leg.prop_stat) : null,
    // Repeated on every leg; the tally counts it once per ticket.
    stake,
    book: String(body.book ?? "BetMGM"),
    model_probability: null,
    market_probability: null,
    rule_version_id: null,
    note: (body.note as string) ?? null,
    bonus: body.bonus === true,
    supersedes: null,
    parlay_id: parlayId,
    parlay_price: parlayPrice,
  }));
  return { problems, rows };
}

/**
 * A probability field, or null. `Number(null)` is 0, so the plain finite check stored a
 * missing probability as 0% -- which reads as a certain loser in any EV-at-placement sum.
 */
function probability(raw: unknown): number | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const p = Number(raw);
  return Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

/**
 * A single bet, a correction, a void or a cash-out. Whether a correction names a bet that
 * exists in the caller's ledger needs the database, so it is the caller's check; this
 * returns the id it names as `corrects`.
 */
export function parseSingle(
  body: Record<string, unknown>,
  newId: () => string,
  now: Date = new Date(),
): { problems: string[]; bet: Bet | null; corrects: string | null } {
  const voiding = body.voided === true;

  // Cash-out: the ticket was sold back before the whistle. Arrives as a correction,
  // which is exactly what it is -- the original row records what was struck and stays;
  // this one records that it ended early and at what price. A cash-out below the stake
  // is legitimate (cutting a loss), so the only bar is a real, non-negative number.
  let cashout: number | null = null;
  const problems: string[] = [];
  if (body.cashout !== undefined && body.cashout !== null && body.cashout !== "") {
    const amount = Number(body.cashout);
    if (!Number.isFinite(amount) || amount < 0) {
      problems.push("A cash-out must be a number of dollars, and not negative.");
    } else {
      cashout = amount;
    }
  }

  const market = String(body.market ?? "");
  const side = String(body.side ?? "");
  const price = Number(body.price);
  const stake = Number(body.stake);
  const line = body.line === null || body.line === "" || body.line === undefined ? null : Number(body.line);

  // A void names the row it removes and copies the rest for the record. It is not a bet,
  // so it is not held to a bet's rules -- but it must still name something real.
  if (voiding && !body.supersedes) problems.push("A void must name the bet it removes.");
  if (!body.event_id) problems.push("Pick a game.");
  if (!MARKETS.has(market)) problems.push("Market must be spread, total, moneyline or a player prop.");
  if (!SIDES.has(side)) problems.push("Pick a side.");
  if (!Number.isFinite(price) || Math.abs(price) < 100) {
    problems.push("Price must be American odds of at least +100 or -100.");
  }
  if (!Number.isFinite(stake) || stake <= 0) problems.push("Stake must be more than zero.");
  if (market === "prop") {
    problems.push(...propProblems(body, "Prop"));
  } else {
    if (market !== "moneyline" && !PARITY.has(side) && (line === null || !Number.isFinite(line))) {
      problems.push("A spread or total needs a line.");
    }
    // A spread's side must be a team and a total's must be over/under; crossing them
    // would settle against the wrong question entirely.
    if (market === "total" && side !== "over" && side !== "under" && !PARITY.has(side)) {
      problems.push("A total is bet over, under, odd or even.");
    }
    if (market !== "total" && side !== "home" && side !== "away") {
      problems.push("A spread or moneyline is bet on home or away.");
    }
  }
  const team = market === "prop" ? null : readTeam(body.team, market);
  if (team === undefined) problems.push("A team total must name home or away.");

  const corrects =
    body.supersedes !== undefined && body.supersedes !== null && body.supersedes !== ""
      ? String(body.supersedes)
      : null;
  const placedAt = readPlacedAt(body.placed_at, now, problems);
  if (problems.length > 0) return { problems, bet: null, corrects };

  const bet: Bet = {
    bet_id: newId(),
    placed_at: placedAt,
    league: String(body.league ?? "ncaaf"),
    event_id: String(body.event_id),
    home_team: (body.home_team as string) ?? null,
    away_team: (body.away_team as string) ?? null,
    commence_time: (body.commence_time as string) ?? null,
    market: market as Bet["market"],
    side: side as Bet["side"],
    team: team ?? null,
    line: market === "moneyline" ? null : line,
    price,
    prop_player: market === "prop" ? String(body.prop_player).trim() : null,
    prop_stat: market === "prop" ? String(body.prop_stat) : null,
    stake,
    book: String(body.book ?? "BetMGM"),
    model_probability: probability(body.model_probability),
    market_probability: probability(body.market_probability),
    rule_version_id: (body.rule_version_id as string) ?? null,
    note: (body.note as string) ?? null,
    // A promotional bet: the stake is the book's, so losing it costs nothing.
    bonus: body.bonus === true,
    supersedes: corrects,
    voided: voiding,
    cashout,
  };
  return { problems, bet, corrects };
}
