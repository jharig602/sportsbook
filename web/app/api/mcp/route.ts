import type { AuthInfo } from "@modelcontextprotocol/server";
import { createMcpHandler, withMcpAuth } from "mcp-handler";
import { z } from "zod";

import { SCOPE } from "@/lib/oauth";
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

type Ctx = { http?: { authInfo?: AuthInfo } };

function text(summary: string, data?: unknown, isError = false) {
  const content = [{ type: "text" as const, text: summary }];
  if (data !== undefined) content.push({ type: "text" as const, text: JSON.stringify(data) });
  return isError ? { content, isError: true } : { content };
}

async function run(tool: string, args: unknown, ctx: unknown, answer: () => Promise<ToolAnswer>) {
  const tokenHash = (ctx as Ctx).http?.authInfo?.extra?.tokenHash;
  if (typeof tokenHash !== "string") return text("Not signed in to Dissent.", undefined, true);
  const [minute, day] = await Promise.all([callsSince(tokenHash, 60), callsSince(tokenHash, 86_400)]);
  if (minute >= PER_MINUTE || day >= PER_DAY) {
    return text("Dissent's rate limit is reached; try again in a minute.", undefined, true);
  }
  await logCall(tokenHash, tool, args);
  try {
    const result = await answer();
    return text(result.summary, result.data);
  } catch (error) {
    if (error instanceof ToolInputError) return text(error.message, undefined, true);
    // The detail goes to the server log, never to the chat: an error message is not the
    // place to learn how the database is laid out.
    console.error(`mcp ${tool} failed`, error);
    return text("Dissent could not answer that right now. Try again shortly.", undefined, true);
  }
}

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

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
      "Dissent is the user's personal NFL and college football betting app. All tools are read-only. " +
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
    scopes: [SCOPE],
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
