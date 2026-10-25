import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

import { LOG_SCOPE, SCOPE } from "@/lib/oauth";
import { logBet, recordCashOut, updateSurvivorSheet, WriteInputError } from "@/lib/mcp-write";
import { callsSince, logCall, verifyAccess } from "@/lib/oauth-db";
import {
  findBonusBetSpots,
  findBoostSpots,
  getGame,
  getOpenBets,
  getPromos,
  getRecord,
  getShop,
  getSurvivor,
  loadSheetDeps,
  loadWriteDeps,
  ToolInputError,
  type ToolAnswer,
} from "@/lib/mcp-tools";

export const dynamic = "force-dynamic";
// The survivor planner searches the season for every entry; give it room.
export const maxDuration = 60;

/**
 * The Claude connector: a read-only MCP server over Streamable HTTP.
 *
 * Behind OAuth (oauth.ts): no valid token, no answer -- a 401 pointing at the
 * protected-resource metadata, which is how Claude learns to sign in. There are no write
 * tools of any kind. Every call is logged (tool, inputs, time) and rate-limited per token.
 */

const PER_MINUTE = 30;
const PER_DAY = 1000;
/** Writes are rarer than reads by nature; a day of them past this is something wrong. */
const WRITES_PER_DAY = 100;
const WRITE_TOOLS = new Set(["log_bet", "record_cash_out", "update_survivor_sheet"]);

type Ctx = { http?: { authInfo?: AuthInfo } };

function text(summary: string, data?: unknown, isError = false) {
  const content = [{ type: "text" as const, text: summary }];
  if (data !== undefined) content.push({ type: "text" as const, text: JSON.stringify(data) });
  return isError ? { content, isError: true } : { content };
}

async function run(tool: string, args: unknown, ctx: unknown, answer: () => Promise<ToolAnswer>) {
  const auth = (ctx as Ctx).http?.authInfo;
  const tokenHash = auth?.extra?.tokenHash;
  if (typeof tokenHash !== "string") return text("Not signed in to Dissent.", undefined, true);
  if (WRITE_TOOLS.has(tool)) {
    // Logging was ticked (or not) on the consent page; a read-only approval stays one.
    if (!auth?.scopes.includes(LOG_SCOPE)) {
      return text(
        "This connection is read-only. To let Claude log bets, disconnect and reconnect Dissent in claude.ai and leave 'Also let Claude log bets' ticked.",
        undefined,
        true,
      );
    }
    const writes = await callsSince(tokenHash, 86_400, [...WRITE_TOOLS]);
    if (writes >= WRITES_PER_DAY) return text("Dissent's daily limit on logging is reached.", undefined, true);
  }
  const [minute, day] = await Promise.all([callsSince(tokenHash, 60), callsSince(tokenHash, 86_400)]);
  if (minute >= PER_MINUTE || day >= PER_DAY) {
    return text("Dissent's rate limit is reached; try again in a minute.", undefined, true);
  }
  await logCall(tokenHash, tool, args);
  try {
    const result = await answer();
    return text(result.summary, result.data);
  } catch (error) {
    if (error instanceof ToolInputError || error instanceof WriteInputError) return text(error.message, undefined, true);
    // The detail goes to the server log, never to the chat: an error message is not the
    // place to learn how the database is laid out.
    console.error(`mcp ${tool} failed`, error);
    return text("Dissent could not answer that right now. Try again shortly.", undefined, true);
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
// Writes add a row to the owner's own ledger; nothing is deleted or overwritten, and
// nothing outside Dissent is touched.
const WRITES = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };

const leg = z.object({
  game: z.string().describe('The game: a team in it ("Lions") or a game_id from another tool.'),
  market: z.enum(["moneyline", "spread", "total", "prop"]),
  pick: z
    .string()
    .optional()
    .describe('Moneyline/spread: the team taken. Total: "over", "under", "odd" or "even". Prop: "over" (default) or "under".'),
  line: z
    .number()
    .optional()
    .describe("Spread: the taken team's line (-2.5). Total: the number. Prop: the stat line, 274.5 for 275+ (a TD scorer is 0.5)."),
  team_total: z.string().optional().describe("For a team total: whose points."),
  player: z.string().optional().describe("Prop: the player's full name."),
  stat: z
    .enum(["anytime_td", "first_td", "pass_yds", "pass_tds", "rush_yds", "rec_yds", "rush_rec_yds", "receptions"])
    .optional(),
  price: z.number().optional().describe("Parlay leg's own price if the slip shows one."),
});

const sport = z.string().optional().describe('"NFL" or "NCAAF" (college). Omit for both.');
const date = z.string().optional().describe('Kickoff date in Eastern time: "today", "tomorrow" or YYYY-MM-DD.');
const limit = z.number().int().min(1).max(25).optional().describe("Rows to return (default 10).");
const minOdds = z
  .number()
  .optional()
  .describe("The token's minimum odds in American format, e.g. -200: only bets at those odds or longer.");

const handler = createMcpHandler(
  (server) => {
    server.registerTool(
      "get_shop",
      {
        title: "Line shop",
        description:
          "Find where one sportsbook's price disagrees with the rest of the market, ranked by expected return against the other books' de-vigged consensus. " +
          "Use when the user asks for outliers, value, the best price on something, or what is worth betting at a book. " +
          "Offshore books are excluded unless include_offshore is true. Every row has as_of and stale (over 10 minutes old).",
        inputSchema: z.object({
          book: z.string().optional().describe('Only this book, e.g. "FanDuel".'),
          sport,
          date,
          market: z.enum(["moneyline", "spread", "total"]).optional(),
          min_edge_pct: z.number().optional().describe("Only rows with at least this expected return, in percent."),
          min_books: z.number().int().min(1).optional().describe("Minimum other books compared against (default 6; fewer is mostly noise)."),
          include_offshore: z.boolean().optional(),
          limit,
        }),
        annotations: READ_ONLY,
      },
      async (args, ctx) => run("get_shop", args, ctx, () => getShop(args)),
    );

    server.registerTool(
      "find_boost_spots",
      {
        title: "Profit boost finder",
        description:
          "Rank bets for a sportsbook profit boost token by expected value after tax. Use when the user has a boost and asks what to bet on. " +
          "Requires the book and boost size; ask for the max wager and minimum odds from the token terms if not given. " +
          "Covers moneylines and game totals in the next 8 days, priced on the more cautious of the other books and the spread model. " +
          "Says plainly when nothing clears tax.",
        inputSchema: z.object({
          book: z.string().describe('The book the token is at, e.g. "FanDuel".'),
          boost_pct: z.number().describe("Boost size: 30 for a 30% profit boost (0.3 also works)."),
          max_wager: z.number().describe("The token's maximum stake in dollars."),
          min_odds: minOdds,
          sport,
          date,
          bet_types: z.array(z.enum(["moneyline", "total"])).optional(),
          tax_rate: z.number().optional().describe("Override the app's tax rate (percent or fraction). Defaults to the owner's setting."),
          limit,
        }),
        annotations: READ_ONLY,
      },
      async (args, ctx) => run("find_boost_spots", args, ctx, () => findBoostSpots(args)),
    );

    server.registerTool(
      "find_bonus_bet_spots",
      {
        title: "Bonus bet finder",
        description:
          "Rank where to use a bonus bet (site credit whose stake is not returned) by what it converts to in cash after tax. " +
          "Use when the user has a bonus bet or free bet and asks where to use it. Skips games the user already has open bets on unless told otherwise.",
        inputSchema: z.object({
          book: z.string().describe("The book holding the bonus bet."),
          amount: z.number().describe("The bonus bet's face value in dollars."),
          min_odds: minOdds,
          sport,
          date,
          exclude_games_with_open_bets: z.boolean().optional().describe("Default true."),
          limit,
        }),
        annotations: READ_ONLY,
      },
      async (args, ctx) => run("find_bonus_bet_spots", args, ctx, () => findBonusBetSpots(args)),
    );

    server.registerTool(
      "get_game",
      {
        title: "Game detail",
        description:
          "Full pricing for one game: every book's spread, total and moneyline with hold, market vs model probability and the gap, opening line, " +
          "the boost needed after tax and bonus bet value per side, the best price at each book, and which league the model was fitted on. " +
          "Use when the user names a game or team.",
        inputSchema: z.object({
          query: z.string().optional().describe('A team name, e.g. "Lions" or "Ohio State".'),
          game_id: z.string().optional().describe("A game_id from another tool's answer."),
          include_offshore: z.boolean().optional(),
        }),
        annotations: READ_ONLY,
      },
      async (args, ctx) => run("get_game", args, ctx, () => getGame(args)),
    );

    server.registerTool(
      "get_open_bets",
      {
        title: "Open bets",
        description:
          "The user's open bets: selection, book, stake, price, bonus or promo, parlay legs, fair win probability (live once a game is under way), " +
          "and hold value -- what holding is worth in cash, so a cash-out offer can be judged. Use for 'should I cash out?' or 'what do I have going?'. " +
          'status "settled" lists recent results instead.',
        inputSchema: z.object({
          status: z.enum(["open", "settled"]).optional(),
          limit,
        }),
        annotations: READ_ONLY,
      },
      async (args, ctx) => run("get_open_bets", args, ctx, () => getOpenBets(args)),
    );

    server.registerTool(
      "get_record",
      {
        title: "Betting record",
        description:
          "The user's settled record: tickets, wins and losses, profit, ROI, promo profit shown apart from pick profit, and expected value at placement vs realized. " +
          "Use when asked how they are doing, by book, sport, promo type or ticket type.",
        inputSchema: z.object({
          since: z.string().optional().describe("YYYY-MM-DD."),
          group_by: z.enum(["book", "sport", "promo_type", "ticket_type"]).optional(),
        }),
        annotations: READ_ONLY,
      },
      async (args, ctx) => run("get_record", args, ctx, () => getRecord(args)),
    );

    server.registerTool(
      "get_promos",
      {
        title: "Live promos",
        description:
          "The user's live promo tokens and bonus bets with book, type, terms, cap, minimum odds and expiry, soonest to expire first. " +
          "Use when asked what promos or boosts they have, or what is expiring.",
        inputSchema: z.object({}),
        annotations: READ_ONLY,
      },
      async (args, ctx) => run("get_promos", args, ctx, () => getPromos({})),
    );

    server.registerTool(
      "log_bet",
      {
        title: "Log a bet",
        description:
          "Record a bet the user has ALREADY PLACED in their Dissent ledger -- a single, parlay or same-game parlay, including player props, bonus bets and boosted bets. " +
          "Use when the user says they placed a bet or sends a bet slip. It never places a bet anywhere. " +
          "Always two calls: first with confirm false (the default), which saves nothing and returns a preview and preview_id; show the preview to the user word for word, " +
          "and only after they say yes call again with the same inputs plus confirm: true and the preview_id. Never confirm without the user's yes. " +
          "price is what the ticket pays at (for a profit boost, the boosted price; for a parlay, the combined price). " +
          "Pass promo_id (from get_promos) when a promo token was used on it, and it is marked used.",
        inputSchema: z.object({
          book: z.string().describe('Where it was placed, e.g. "FanDuel".'),
          stake: z.number().positive().describe("Dollars staked (a bonus bet's face value)."),
          price: z.number().describe("American odds the ticket pays at, e.g. -140 or +195."),
          legs: z.array(leg).min(1).max(12).describe("One leg for a single; two or more for a parlay."),
          bonus_bet: z.boolean().optional().describe("True when the stake was a bonus bet / site credit."),
          promo_id: z.string().optional().describe("The promo token used on this bet, from get_promos."),
          placed_at: z.string().optional().describe("When it was placed (ISO time), if not just now."),
          note: z.string().optional(),
          confirm: z.boolean().optional().describe("False (default) previews; true saves -- only after the user says yes."),
          preview_id: z.string().optional().describe("Required with confirm: the id from the preview."),
        }),
        annotations: WRITES,
      },
      async (args, ctx) =>
        run("log_bet", args, ctx, async () => logBet(args, new Date(), await loadWriteDeps())),
    );

    server.registerTool(
      "record_cash_out",
      {
        title: "Record a cash-out",
        description:
          "Record that the user cashed out an open ticket, and for how much (the cash received). Use after they say they cashed out. " +
          "Get ticket_id from get_open_bets. Two calls, like log_bet: preview first (shows the result and what holding was worth), " +
          "then confirm: true with the preview_id only after the user says yes.",
        inputSchema: z.object({
          ticket_id: z.string().describe("From get_open_bets."),
          amount: z.number().min(0).describe("Dollars received for the cash-out."),
          confirm: z.boolean().optional(),
          preview_id: z.string().optional(),
        }),
        annotations: WRITES,
      },
      async (args, ctx) =>
        run("record_cash_out", args, ctx, async () => recordCashOut(args, new Date(), await loadWriteDeps())),
    );

    server.registerTool(
      "update_survivor_sheet",
      {
        title: "Update the survivor pool from its sheet",
        description:
          "Record the user's weekly survivor pool spreadsheet (one row per entrant, one column per week of picks). Use when the user shares the pool's sheet. " +
          "Send EVERY row, with no names: each row's picks keyed by week number, the team exactly as written on the sheet (\"Minn\", \"Da Bears\", \"NYJets\" are fine). " +
          "Mark the user's own row who: \"me\" and his mom's row who: \"ma\"; if you don't know which rows those are, ask before calling. " +
          "Dissent works out losses from final scores (a tie is a loss), who is alive, used teams and how the pool herds; only pass losses for a row if the sheet itself states them. " +
          "Two calls like log_bet: preview first, then confirm: true with the preview_id only after the user says yes. The saved reply includes the new survivor odds.",
        inputSchema: z.object({
          rows: z
            .array(
              z.object({
                picks: z.record(z.string(), z.string()).describe('Week number -> team as written, e.g. {"7": "Houston", "8": "KC"}.'),
                who: z.string().optional().describe('"me" for the user\'s row, "ma" for his mom\'s row; omit for everyone else.'),
                losses: z.number().int().min(0).optional().describe("Only if the sheet states this row's losses."),
              }),
            )
            .min(2)
            .max(300),
          confirm: z.boolean().optional(),
          preview_id: z.string().optional(),
        }),
        annotations: WRITES,
      },
      async (args, ctx) =>
        run("update_survivor_sheet", args, ctx, async () => updateSurvivorSheet(args, await loadSheetDeps())),
    );

    server.registerTool(
      "get_survivor",
      {
        title: "Survivor picks",
        description:
          "This week's recommended NFL survivor pick for each tracked entry (the user's and his mom's, in one pool): win probability, share of the field, " +
          "teams used, lives left, survival odds this week, over four weeks and for the season, and the chance of taking the pool. Use for survivor questions.",
        inputSchema: z.object({
          pool: z.string().optional().describe('An entry name, e.g. "Me" or "Ma". Omit for all.'),
        }),
        annotations: READ_ONLY,
      },
      async (args, ctx) => run("get_survivor", args, ctx, () => getSurvivor(args)),
    );
  },
  {
    serverInfo: { name: "dissent", version: "1.0.0" },
    instructions:
      "Dissent is the user's personal NFL and college football betting app. Every tool reads, except log_bet, record_cash_out and " +
      "update_survivor_sheet, which record what the user already did, always previewing first and saving only after the user says yes. " +
      "Prices carry as_of and stale flags: when stale is true, say so and tell the user to confirm the line at the book before betting. " +
      "Expected values are estimates from other books' consensus and a fitted model, not guarantees.",
  },
);

async function verifyToken(_request: Request, bearer?: string): Promise<AuthInfo | undefined> {
  if (!bearer) return undefined;
  const found = await verifyAccess(bearer);
  if (!found) return undefined;
  return {
    token: bearer,
    clientId: found.clientId,
    scopes: found.scopes,
    expiresAt: found.expiresAt,
    extra: { tokenHash: found.tokenHash },
  };
}

const guarded = withMcpAuth(handler, verifyToken, {
  required: true,
  requiredScopes: [SCOPE],
  resourceMetadataPath: "/.well-known/oauth-protected-resource/api/mcp",
});

export { guarded as GET, guarded as POST, guarded as DELETE };
