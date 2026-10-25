/**
 * The Claude connector's write tools: log a bet (marking a promo token used when one is
 * named) and record a cash-out. The owner asked for these on 2026-10-25, after the
 * read-only first version.
 *
 * Every write is two calls. The first returns a PREVIEW -- exactly what would be saved,
 * read back in plain words -- and a `preview_id` fingerprinting it. Only a second call with
 * `confirm: true` and that same id saves anything, and a single changed input changes the
 * fingerprint, so what is saved is always what was shown. That is the guard against a
 * misread bet slip, and against anything in a chat talking Claude into logging something
 * the owner never saw.
 *
 * The rules are the Bets form's own (`bet-input.ts`), the ledger stays append-only (a
 * cash-out is a correction row, exactly as the app writes it), and nothing here can place
 * a bet anywhere: it records what was already placed.
 */
import { createHash, randomUUID } from "node:crypto";

import { parseParlay, parseSingle, PROP_STATS, readPlacedAt } from "./bet-input";
import type { BookLineRow } from "./book-lines";
import { american, money, round } from "./mcp-format";
import { fairChance } from "./open-summary";
import type { MarginModel } from "./probability";
import { activeBets, decimalOdds, type Bet } from "./settle";
import type { StoredPool } from "./pools";
import { entryUpdate, readSheet, type FinalGame, type SheetRowInput } from "./survivor-sheet";
import type { Game, Promo, PromoUse } from "./types";

export class WriteInputError extends Error {}

export interface WriteDeps {
  games: Game[];
  lines: Map<string, BookLineRow[]>;
  models: Record<string, MarginModel>;
  /** The owner's ledger as stored (corrections included). */
  bets: Bet[];
  promos: Promo[];
  /** Event ids whose games are final. */
  finals: Set<string>;
  saveBet: (bet: Bet) => Promise<void>;
  saveParlay: (rows: Bet[]) => Promise<void>;
  recordUse: (use: PromoUse) => Promise<void>;
  recordLegResult: (betId: string, result: NonNullable<Bet["prop_result"]>) => Promise<void>;
  /** Fair chance and cash value of holding an open ticket, when it can be priced. */
  holdValue?: (ticketId: string) => Promise<{ chance: number; value: number } | null>;
  newId?: () => string;
}

export interface WriteAnswer {
  summary: string;
  data: Record<string, unknown>;
}

const DUPLICATE_WINDOW_MS = 10 * 60_000;

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 16);
}

function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
}

/** Does a typed name mean this team: "Lions", "Detroit", "detroit lions", "DET"-free. */
function namesTeam(query: string, team: string | null): boolean {
  if (!team) return false;
  const q = words(query);
  const t = words(team);
  return q.length > 0 && q.every((w) => t.includes(w));
}

const when = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "2-digit" }) + " ET"
    : "time unknown";

/**
 * The game a leg means: an exact game_id, or a team named in a game from three days ago
 * to two weeks out (the board holds the whole season, and last month's Lions game is not
 * the one being logged). Refuses rather than guesses when two games fit.
 */
export function resolveGame(games: Game[], query: string, now: Date): Game {
  const exact = games.find((g) => g.eventId === query.trim());
  if (exact) return exact;
  const from = now.getTime() - 3 * 86_400_000;
  const to = now.getTime() + 14 * 86_400_000;
  const fits = games
    .filter((g) => {
      const at = Date.parse(g.commenceTime);
      return at >= from && at <= to && (namesTeam(query, g.homeTeam) || namesTeam(query, g.awayTeam));
    })
    .sort((a, b) => Date.parse(a.commenceTime) - Date.parse(b.commenceTime));
  if (fits.length === 0) throw new WriteInputError(`No game in the last 3 days or next 2 weeks matches "${query}".`);
  if (fits.length > 1) {
    const list = fits.slice(0, 5).map((g) => `${g.awayTeam} @ ${g.homeTeam} ${when(g.commenceTime)} (game_id ${g.eventId})`);
    throw new WriteInputError(`"${query}" fits ${fits.length} games: ${list.join("; ")}. Use the full team name or the game_id.`);
  }
  return fits[0];
}

export interface LegInput {
  game: string;
  market: "moneyline" | "spread" | "total" | "prop";
  pick?: string;
  line?: number;
  team_total?: string;
  player?: string;
  stat?: string;
  price?: number;
}

function sideFor(leg: LegInput, game: Game, at: string): { side: string; team: "home" | "away" | null } {
  const pick = (leg.pick ?? "").trim();
  const lower = pick.toLowerCase();
  if (leg.market === "moneyline" || leg.market === "spread") {
    if (lower === "home" || lower === "away") return { side: lower, team: null };
    const home = namesTeam(pick, game.homeTeam);
    const away = namesTeam(pick, game.awayTeam);
    if (home === away) {
      throw new WriteInputError(`${at}: say which team -- ${game.awayTeam} or ${game.homeTeam}.`);
    }
    return { side: home ? "home" : "away", team: null };
  }
  if (leg.market === "prop") {
    const side = lower || "over";
    if (side !== "over" && side !== "under") throw new WriteInputError(`${at}: a prop is over or under.`);
    return { side, team: null };
  }
  // A total: over/under/odd/even, optionally one team's points.
  let team: "home" | "away" | null = null;
  if (leg.team_total) {
    const home = namesTeam(leg.team_total, game.homeTeam);
    const away = namesTeam(leg.team_total, game.awayTeam);
    if (home === away) throw new WriteInputError(`${at}: whose team total -- ${game.awayTeam} or ${game.homeTeam}?`);
    team = home ? "home" : "away";
  }
  if (!["over", "under", "odd", "even"].includes(lower)) {
    throw new WriteInputError(`${at}: a total is over, under, odd or even.`);
  }
  return { side: lower, team };
}

function legName(row: Pick<Bet, "market" | "side" | "line" | "team" | "home_team" | "away_team" | "prop_player" | "prop_stat">): string {
  if (row.market === "prop") {
    const line = row.line ?? 0;
    if (row.prop_stat === "anytime_td") return `${row.prop_player} anytime TD`;
    if (row.prop_stat === "first_td") return `${row.prop_player} first TD`;
    const label = String(row.prop_stat).replace(/_/g, " ");
    return row.side === "over" ? `${row.prop_player} ${Math.floor(line) + 1}+ ${label}` : `${row.prop_player} under ${line} ${label}`;
  }
  const team = row.side === "home" ? row.home_team : row.side === "away" ? row.away_team : null;
  if (row.market === "moneyline") return `${team} ML`;
  if (row.market === "spread") return `${team} ${(row.line ?? 0) > 0 ? "+" : ""}${row.line}`;
  const whose = row.team === "home" ? `${row.home_team} ` : row.team === "away" ? `${row.away_team} ` : "";
  if (row.side === "odd" || row.side === "even") return `${whose}total ${row.side}`;
  return `${whose}${row.side === "over" ? "Over" : "Under"} ${row.line}`;
}

export interface LogBetInput {
  book: string;
  stake: number;
  price: number;
  legs: LegInput[];
  bonus_bet?: boolean;
  promo_id?: string;
  placed_at?: string;
  note?: string;
  confirm?: boolean;
  preview_id?: string;
}

export async function logBet(input: LogBetInput, now: Date, deps: WriteDeps): Promise<WriteAnswer> {
  const newId = deps.newId ?? randomUUID;
  if (!Array.isArray(input.legs) || input.legs.length === 0) throw new WriteInputError("A bet needs at least one leg.");
  if (input.legs.length > 12) throw new WriteInputError("Twelve legs is the most this logs.");
  const book = String(input.book ?? "").trim().slice(0, 40);
  if (!book) throw new WriteInputError("Name the book the bet was placed at.");

  // The promo, when one is named: it must be this owner's, live, and at this book.
  let promo: Promo | null = null;
  const warnings: string[] = [];
  if (input.promo_id) {
    promo = deps.promos.find((p) => p.promo_id === input.promo_id) ?? null;
    if (!promo) throw new WriteInputError("No promo with that promo_id; get it from get_promos.");
    if (promo.status !== "available") throw new WriteInputError(`"${promo.title}" is already marked used.`);
    if (Date.parse(promo.expires_at) <= now.getTime()) throw new WriteInputError(`"${promo.title}" has expired.`);
    if (words(promo.book).join("") !== words(book).join("")) {
      throw new WriteInputError(`"${promo.title}" is a ${promo.book} promo, not ${book}.`);
    }
    if (promo.max_stake !== null && input.stake > promo.max_stake) warnings.push(`The stake is over the token's $${promo.max_stake} maximum.`);
    if (promo.min_legs !== null && input.legs.length < promo.min_legs) warnings.push(`The token needs ${promo.min_legs}+ legs.`);
    if (promo.min_odds_american !== null) {
      warnings.push(`Check the token's ${american(promo.min_odds_american)} minimum against the unboosted price.`);
    }
  }
  // A bonus bet's stake is the book's: a bonus-bet token always logs as one.
  const bonus = input.bonus_bet === true || promo?.type === "bonus_bet";

  const resolved = input.legs.map((leg, i) => {
    const at = input.legs.length === 1 ? "The bet" : `Leg ${i + 1}`;
    if (!leg || !leg.game) throw new WriteInputError(`${at}: name the game (a team or a game_id).`);
    if (!["moneyline", "spread", "total", "prop"].includes(leg.market)) {
      throw new WriteInputError(`${at}: market is moneyline, spread, total or prop.`);
    }
    if (leg.market === "prop" && (!leg.stat || !PROP_STATS.has(leg.stat))) {
      throw new WriteInputError(`${at}: a prop's stat is one of ${[...PROP_STATS].join(", ")}.`);
    }
    const game = resolveGame(deps.games, leg.game, now);
    const { side, team } = sideFor(leg, game, at);
    const anytime = leg.market === "prop" && (leg.stat === "anytime_td" || leg.stat === "first_td");
    return {
      game,
      body: {
        event_id: game.eventId,
        league: game.league,
        home_team: game.homeTeam,
        away_team: game.awayTeam,
        commence_time: game.commenceTime,
        market: leg.market,
        side,
        team,
        // A TD scorer is "over 0.5" whatever was typed; a moneyline has no line.
        line: leg.market === "moneyline" ? null : anytime ? (leg.line ?? 0.5) : (leg.line ?? null),
        prop_player: leg.market === "prop" ? (leg.player ?? "").trim() : null,
        prop_stat: leg.market === "prop" ? leg.stat : null,
        price: leg.price ?? null,
      } as Record<string, unknown>,
    };
  });

  const common = { book, stake: input.stake, bonus, note: input.note ? String(input.note).slice(0, 200) : null, placed_at: input.placed_at };
  let rows: Bet[];
  if (resolved.length === 1) {
    const { problems, bet } = parseSingle({ ...resolved[0].body, ...common, price: input.price }, newId, now);
    if (problems.length || !bet) throw new WriteInputError(problems.join(" "));
    // The fair chance at placement, as the Shop would price it: what EV-at-placement and
    // the record's expected-vs-realized are built from.
    const p = fairChance(bet, resolved[0].game, deps.lines.get(bet.event_id) ?? [], deps.models[bet.league] ?? null, now);
    bet.market_probability = p === null ? null : round(p, 4);
    rows = [bet];
  } else {
    const { problems, rows: legs } = parseParlay(
      { legs: resolved.map((r) => r.body), ...common, parlay_price: input.price },
      newId,
      now,
    );
    if (problems.length) throw new WriteInputError(problems.join(" "));
    rows = legs;
  }

  // The same ticket twice inside ten minutes is a double call, not a second bet.
  const active = activeBets(deps.bets);
  const near = (a: string, b: string) => Math.abs(Date.parse(a) - Date.parse(b)) < DUPLICATE_WINDOW_MS;
  const key = (b: Bet) => [b.event_id, b.market, b.side, b.line ?? "", b.team ?? "", b.prop_player ?? "", b.prop_stat ?? ""].join("|");
  if (rows.length === 1) {
    const r = rows[0];
    const dup = active.find(
      (b) => !b.parlay_id && key(b) === key(r) && b.price === r.price && b.stake === r.stake &&
        b.book.toLowerCase() === r.book.toLowerCase() && near(b.placed_at, r.placed_at),
    );
    if (dup) throw new WriteInputError("That exact bet was logged in the last 10 minutes. If you really placed it twice, log the second one in the app.");
  } else {
    const mine = rows.map(key).sort().join(";");
    const tickets = new Map<string, Bet[]>();
    for (const b of active) if (b.parlay_id) tickets.set(b.parlay_id, [...(tickets.get(b.parlay_id) ?? []), b]);
    for (const legs of tickets.values()) {
      const first = legs[0];
      if (legs.map(key).sort().join(";") === mine && first.stake === rows[0].stake &&
        first.parlay_price === rows[0].parlay_price && first.book.toLowerCase() === book.toLowerCase() &&
        near(first.placed_at, rows[0].placed_at)) {
        throw new WriteInputError("That exact parlay was logged in the last 10 minutes.");
      }
    }
  }

  const id = fingerprint({
    kind: "log_bet",
    book,
    stake: input.stake,
    price: input.price,
    bonus,
    promo: promo?.promo_id ?? null,
    placed_at: input.placed_at ?? null,
    note: common.note,
    legs: rows.map((r) => [key(r), r.price]),
  });

  const d = decimalOdds(input.price);
  const toWin = d === null ? 0 : input.stake * (d - 1);
  const p = rows.length === 1 ? rows[0].market_probability : null;
  const ev = p !== null && p !== undefined && d !== null ? p * toWin - (1 - p) * (bonus ? 0 : input.stake) : null;
  const first = rows[0];
  const description =
    rows.length === 1
      ? `${legName(first)} ${american(input.price)} (${first.away_team} @ ${first.home_team}, ${when(first.commence_time)})`
      : `${rows.length}-leg parlay at ${american(input.price)}: ${rows.map((r) => `${legName(r)}${r.price !== null ? ` ${american(r.price)}` : ""} (${r.away_team} @ ${r.home_team})`).join("; ")}`;
  const lines = [
    `${book}: ${money(input.stake)}${bonus ? " bonus bet" : ""} on ${description}. To win ${money(toWin)}.`,
    p !== null && p !== undefined ? `Fair chance ${(p * 100).toFixed(1)}%, so it is worth ${ev !== null && ev >= 0 ? "+" : ""}${money(ev ?? 0)} on average before tax.` : "",
    promo ? `"${promo.title}" will be marked used.` : "",
    ...warnings,
  ].filter(Boolean);

  if (!input.confirm) {
    return {
      summary:
        `PREVIEW, nothing saved. ${lines.join(" ")} Show this to the user exactly. Only after they say yes, ` +
        "call log_bet again with the same inputs plus confirm: true and this preview_id.",
      data: { preview_id: id, would_save: rows.length === 1 ? "single" : `${rows.length}-leg parlay`, warnings },
    };
  }
  if (input.preview_id !== id) {
    throw new WriteInputError("This doesn't match a preview of these exact inputs. Preview it again (confirm: false) and show the user.");
  }

  if (rows.length === 1) await deps.saveBet(rows[0]);
  else await deps.saveParlay(rows);

  let promoNote = "";
  if (promo) {
    try {
      await deps.recordUse({
        use_id: newId(),
        promo_id: promo.promo_id,
        placed_at: first.placed_at,
        stake: input.stake,
        odds_american: Math.round(input.price),
        legs: rows.length,
        bet_id: first.bet_id,
        fair_prob: p ?? null,
        ev_at_placement: ev === null ? null : round(ev, 2),
        settled_at: null,
        result: null,
        returned_cash: null,
        returned_bonus: null,
      });
      promoNote = ` "${promo.title}" is marked used.`;
    } catch {
      promoNote = ` The bet is saved, but marking "${promo.title}" used failed; mark it on the Promos page.`;
    }
  }
  return {
    summary: `Logged. ${lines[0]}${promoNote}`,
    data: { ticket_id: first.bet_id, legs: rows.length },
  };
}

export interface CashOutInput {
  ticket_id: string;
  amount: number;
  confirm?: boolean;
  preview_id?: string;
}

/**
 * A cash-out is a correction, as the app writes it: the original rows stay and new rows
 * supersede them carrying the cash received. A parlay's legs are corrected together, in
 * one transaction, so the ticket is never half cashed.
 */
export async function recordCashOut(input: CashOutInput, now: Date, deps: WriteDeps): Promise<WriteAnswer> {
  const newId = deps.newId ?? randomUUID;
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount < 0) throw new WriteInputError("The cash-out is the dollars received, not negative.");
  const active = activeBets(deps.bets);
  const row = active.find((b) => b.bet_id === input.ticket_id);
  if (!row) throw new WriteInputError("No open ticket with that ticket_id; get it from get_open_bets.");
  const legs = row.parlay_id ? active.filter((b) => b.parlay_id === row.parlay_id) : [row];
  if (legs.some((l) => l.cashout !== null && l.cashout !== undefined)) throw new WriteInputError("That ticket is already cashed out.");
  if (legs.every((l) => deps.finals.has(l.event_id))) throw new WriteInputError("That ticket's games are over; it settled on the score.");

  const price = row.parlay_id ? (row.parlay_price ?? null) : row.price;
  const d = decimalOdds(price);
  const maxReturn = d === null ? null : row.bonus ? row.stake * (d - 1) : row.stake * d;
  if (maxReturn !== null && amount > maxReturn + 0.01) {
    throw new WriteInputError(`${money(amount)} is more than the ticket could ever pay (${money(maxReturn)}).`);
  }

  const label = legs.length > 1 ? `${legs.length}-leg parlay (${legs.map(legName).join(" + ")})` : legName(row);
  const profit = row.bonus ? amount : amount - row.stake;
  const hold = deps.holdValue ? await deps.holdValue(row.bet_id).catch(() => null) : null;
  const lines = [
    `Cash out ${row.book} ${label}, ${money(row.stake)}${row.bonus ? " bonus" : ""} at ${american(price)}, for ${money(amount)}: ${profit >= 0 ? "+" : ""}${money(profit)}.`,
    hold
      ? `Holding is worth about ${money(hold.value)} at its fair ${(hold.chance * 100).toFixed(0)}% chance, so this offer is ${money(Math.abs(hold.value - amount))} ${amount < hold.value ? "below" : "above"} that.`
      : "",
  ].filter(Boolean);

  const id = fingerprint({ kind: "cash_out", ticket: row.bet_id, amount: round(amount, 2) });
  if (!input.confirm) {
    return {
      summary: `PREVIEW, nothing saved. ${lines.join(" ")} Show this to the user; only after they say yes, call record_cash_out again with confirm: true and this preview_id.`,
      data: { preview_id: id },
    };
  }
  if (input.preview_id !== id) throw new WriteInputError("This doesn't match a preview of this cash-out. Preview it again and show the user.");

  const corrections: Bet[] = legs.map((leg) => {
    const copy: Bet = { ...leg };
    delete copy.prop_result;
    return {
      ...copy,
      bet_id: newId(),
      supersedes: leg.bet_id,
      voided: false,
      cashout: amount,
      note: leg.note ? `${leg.note} · cashed out` : "Cashed out",
    };
  });
  if (corrections.length === 1) await deps.saveBet(corrections[0]);
  else await deps.saveParlay(corrections);
  // A prop leg's recorded result belongs to its bet_id; carry it to the correction so the
  // "what holding would have paid" comparison can still be graded.
  for (const [i, leg] of legs.entries()) {
    if (leg.market === "prop" && leg.prop_result) {
      await deps.recordLegResult(corrections[i].bet_id, leg.prop_result).catch(() => undefined);
    }
  }
  return { summary: `Recorded. ${lines[0]}`, data: { ticket_id: corrections[0].bet_id } };
}

export interface SheetDeps {
  pools: StoredPool[];
  finals: FinalGame[];
  savePools: (pools: StoredPool[]) => Promise<void>;
  /** The planner's answer after saving, so the new odds come back in the same reply. */
  afterSave?: () => Promise<string>;
}

/**
 * The pool's weekly sheet, recorded as each stored entry's state (survivor-sheet.ts).
 * Every stored entry must be named by exactly one row -- the owner's and his Ma's -- so a
 * sheet is never half applied. Names never arrive here; only picks do.
 */
export async function updateSurvivorSheet(
  input: { rows: SheetRowInput[]; confirm?: boolean; preview_id?: string },
  deps: SheetDeps,
): Promise<WriteAnswer> {
  if (!Array.isArray(input.rows) || input.rows.length < 2 || input.rows.length > 300) {
    throw new WriteInputError("Send every row on the sheet (2 to 300 of them).");
  }
  const pools = deps.pools;
  const named = pools.filter((p) => p.name && p.name.trim());
  if (named.length === 0) throw new WriteInputError("No named survivor entries are stored to update.");
  const lossesAllowed = Math.max(...named.map((p) => p.lossesAllowed ?? 0));
  const sheet = readSheet(input.rows, deps.finals, lossesAllowed);
  if (sheet.unreadable.length) {
    throw new WriteInputError(`These could not be read as NFL teams: ${sheet.unreadable.slice(0, 8).join("; ")}. Send the full team name for each.`);
  }
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const marked = sheet.rows.filter((r) => r.who);
  for (const pool of named) {
    const n = marked.filter((r) => r.who === slug(pool.name!)).length;
    if (n !== 1) {
      throw new WriteInputError(
        n === 0
          ? `Mark which row is "${pool.name}" (who: "${slug(pool.name!)}"). Ask the user if you are not sure.`
          : `More than one row is marked "${pool.name}".`,
      );
    }
  }
  const unknown = marked.find((r) => !named.some((p) => slug(p.name!) === r.who));
  if (unknown) throw new WriteInputError(`No stored entry is called "${unknown.who}". Entries: ${named.map((p) => p.name).join(", ")}.`);

  const updates = new Map(named.map((p) => [p.name!, entryUpdate(sheet, p.name!)!]));
  const alive = sheet.field.reduce((a, b) => a + b, 0);
  const pending = sheet.rows.filter((r) => r.alive && r.picks.has(sheet.week) && r.pending > 0).length;
  const last = sheet.weeks[sheet.weeks.length - 1];
  const fieldText = sheet.field.map((n, k) => `${n} on ${k} loss${k === 1 ? "" : "es"}`).join(", ");
  const entryText = named
    .map((p) => {
      const row = sheet.rows.find((r) => r.who === slug(p.name!))!;
      const pick = row.picks.get(sheet.week);
      return `${p.name}: ${row.losses} loss${row.losses === 1 ? "" : "es"}${row.alive ? "" : " (OUT)"}, week ${sheet.week} ${pick ?? "no pick"}${row.pending ? " (not final)" : ""}`;
    })
    .join("; ");
  const lines = [
    `Sheet through week ${sheet.week}: ${sheet.rows.length} entrants, ${alive} alive (${fieldText}).`,
    pending ? `${pending} week-${sheet.week} picks are on games not final yet, so they count as no loss for now.` : "",
    `${entryText}.`,
    last ? `Week ${last.week}: ${last.count} of ${last.picks} on ${last.team}.` : "",
  ].filter(Boolean);

  const id = fingerprint({ kind: "survivor_sheet", updates: [...updates.entries()] });
  if (!input.confirm) {
    return {
      summary: `PREVIEW, nothing saved. ${lines.join(" ")} Show this to the user; only after they say yes, call update_survivor_sheet again with the same rows plus confirm: true and this preview_id.`,
      data: { preview_id: id },
    };
  }
  if (input.preview_id !== id) throw new WriteInputError("This doesn't match a preview of this sheet. Preview it again and show the user.");

  const next = pools.map((p) => {
    const u = p.name ? updates.get(p.name) : undefined;
    return u ? { ...p, ...u, size: Math.max(1, alive) } : p;
  });
  await deps.savePools(next);
  const odds = deps.afterSave ? await deps.afterSave().catch(() => "") : "";
  return { summary: `Saved. ${lines[0]} ${odds}`.trim(), data: { week: sheet.week, alive } };
}

export interface EditInput {
  ticket_id: string;
  book?: string;
  stake?: number;
  price?: number;
  bonus_bet?: boolean;
  placed_at?: string;
  note?: string;
  remove?: boolean;
  confirm?: boolean;
  preview_id?: string;
}

/**
 * Fix or remove a ticket already in the ledger: the wrong book, stake, price or bonus flag,
 * or a ticket that should not be there at all. Written exactly as the app writes a
 * correction -- new rows superseding the old ones, which stay -- and for a parlay every leg
 * at once, in one transaction. A leg that is wrong (team, line, player) is fixed by
 * removing the ticket and logging it again: re-describing a leg in place is how a ticket
 * ends up graded against a game it was never on.
 */
export async function editBet(input: EditInput, now: Date, deps: WriteDeps): Promise<WriteAnswer> {
  const newId = deps.newId ?? randomUUID;
  const active = activeBets(deps.bets);
  const row = active.find((b) => b.bet_id === input.ticket_id);
  if (!row) throw new WriteInputError("No ticket with that ticket_id; get it from get_open_bets (status settled for finished ones).");
  const legs = row.parlay_id ? active.filter((b) => b.parlay_id === row.parlay_id) : [row];
  const parlay = legs.length > 1;

  const changes: string[] = [];
  const book = input.book !== undefined ? String(input.book).trim().slice(0, 40) : undefined;
  if (book !== undefined) {
    if (!book) throw new WriteInputError("The book can't be blank.");
    if (book !== row.book) changes.push(`book ${row.book} → ${book}`);
  }
  if (input.stake !== undefined) {
    if (!(Number.isFinite(input.stake) && input.stake > 0)) throw new WriteInputError("Stake must be more than zero.");
    if (input.stake !== row.stake) changes.push(`stake ${money(row.stake)} → ${money(input.stake)}`);
  }
  const oldPrice = parlay ? (row.parlay_price ?? null) : row.price;
  if (input.price !== undefined) {
    if (!(Number.isFinite(input.price) && Math.abs(input.price) >= 100)) throw new WriteInputError("Price must be American odds of at least +100 or -100.");
    if (input.price !== oldPrice) changes.push(`${parlay ? "parlay price" : "price"} ${american(oldPrice)} → ${american(input.price)}`);
  }
  if (input.bonus_bet !== undefined && input.bonus_bet !== (row.bonus === true)) {
    changes.push(input.bonus_bet ? "now a bonus bet" : "no longer a bonus bet");
  }
  let placedAt: string | undefined;
  if (input.placed_at !== undefined) {
    const problems: string[] = [];
    placedAt = readPlacedAt(input.placed_at, now, problems);
    if (problems.length) throw new WriteInputError(problems.join(" "));
    changes.push(`placed ${placedAt}`);
  }
  if (!input.remove && changes.length === 0) throw new WriteInputError("Nothing to change: give a new book, stake, price, bonus_bet or placed_at, or remove: true.");

  const label = parlay ? `${legs.length}-leg parlay (${legs.map(legName).join(" + ")})` : legName(row);
  const what = `${row.book} ${label}, ${money(row.stake)} at ${american(oldPrice)}`;
  const line = input.remove
    ? `Remove ${what} from the record. It stays in the history as removed and stops counting.`
    : `Correct ${what}: ${changes.join(", ")}.`;
  const id = fingerprint({ kind: "edit", ticket: row.bet_id, remove: input.remove === true, book, stake: input.stake, price: input.price, bonus: input.bonus_bet, placedAt: input.placed_at ?? null });
  if (!input.confirm) {
    return {
      summary: `PREVIEW, nothing saved. ${line} Show this to the user; only after they say yes, call edit_bet again with the same inputs plus confirm: true and this preview_id.`,
      data: { preview_id: id },
    };
  }
  if (input.preview_id !== id) throw new WriteInputError("This doesn't match a preview of this change. Preview it again and show the user.");

  const note = input.note ? String(input.note).slice(0, 200) : input.remove ? "Removed" : "Corrected";
  const corrections: Bet[] = legs.map((leg) => {
    const copy: Bet = { ...leg };
    delete copy.prop_result;
    return {
      ...copy,
      bet_id: newId(),
      supersedes: leg.bet_id,
      voided: input.remove === true,
      note,
      ...(input.remove
        ? {}
        : {
            ...(book !== undefined ? { book } : {}),
            ...(input.stake !== undefined ? { stake: input.stake } : {}),
            ...(input.price !== undefined ? (parlay ? { parlay_price: input.price } : { price: input.price }) : {}),
            ...(input.bonus_bet !== undefined ? { bonus: input.bonus_bet } : {}),
            ...(placedAt !== undefined ? { placed_at: placedAt } : {}),
          }),
    };
  });
  if (corrections.length === 1) await deps.saveBet(corrections[0]);
  else await deps.saveParlay(corrections);
  if (!input.remove) {
    for (const [i, leg] of legs.entries()) {
      if (leg.market === "prop" && leg.prop_result) {
        await deps.recordLegResult(corrections[i].bet_id, leg.prop_result).catch(() => undefined);
      }
    }
  }
  return {
    summary: input.remove ? `Removed. ${what}.` : `Corrected. ${what}: ${changes.join(", ")}.`,
    data: { ticket_id: input.remove ? null : corrections[0].bet_id },
  };
}
