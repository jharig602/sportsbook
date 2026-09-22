/**
 * Recording every priced line, including the ones the rule says not to bet.
 *
 * `shop-picks.ts` records what the rule said to BET. This records what it SAW. The
 * difference is the whole point, and it is a statistical one rather than a matter of
 * volume.
 *
 * A pick row is written the first moment an edge turns positive. That is the right
 * moment to act and the wrong sample to learn from, because "the first moment the
 * measured edge crossed zero" selects for the estimate being noisy-high. A sample chosen
 * that way underperforms its own estimate even when the underlying rule is perfectly
 * good, and from inside that sample there is no way to separate how much of the
 * shortfall is the selection and how much is the rule being wrong. Six months of picks
 * returning less than promised would look identical either way.
 *
 * With the negative lines recorded too, the question becomes answerable. Does a +3 point
 * edge beat a +1 point edge? Does a -2 point edge lose as badly as it should? That is a
 * calibration curve, and its slope is the thing worth knowing: if the realised edge is
 * consistently a fraction of the measured one, the app should be discounting its own
 * numbers by that fraction before deciding anything.
 *
 * What this does NOT do is find an edge. It measures how much to trust the edges already
 * being found, which can raise returns by betting less, and it reaches a verdict far
 * sooner because the sample is the whole board rather than the handful clearing the bar.
 * If there is nothing there, this is how that gets established rather than suspected.
 */
import { createHash } from "node:crypto";

import type { BoardEdge } from "./board-shop";
import type { CensusRow } from "./edge-calibration";
import { databaseUrl } from "./env";

/* eslint-disable @typescript-eslint/no-explicit-any */
let pool: any = null;

async function getPool() {
  const url = databaseUrl();
  if (!url) return null;
  if (!pool) {
    const { Pool } = await import("pg");
    pool = new Pool({ connectionString: url, ssl: { rejectUnauthorized: false }, max: 2 });
  }
  return pool;
}

/**
 * A stable id for one line under one rule.
 *
 * Deliberately the same shape as `pickId` but in its own table, so a line can be both
 * censused and, later, picked without either row standing in for the other. The rule
 * version is in the hash because a re-tuned rule looking at the same line is making a new
 * claim about it.
 */
export function censusId(
  eventId: string,
  market: string,
  side: string,
  book: string,
  ruleVersionId: string,
): string {
  return createHash("sha256")
    .update(["census", eventId, market, side, book, ruleVersionId].join(" "))
    .digest("hex")
    .slice(0, 32);
}

const COLUMNS = [
  "census_id", "observed_at", "league", "event_id", "commence_time",
  "home_team", "away_team", "book", "market", "side", "line", "price",
  "consensus_line", "consensus_probability", "fair_probability", "break_even",
  "expected_roi", "edge_points", "books_compared", "thin_consensus", "rule_version_id",
];

export interface CensusResult {
  considered: number;
  written: number;
  skipped: number;
}

/**
 * Write down every comparable line on the board.
 *
 * First sight wins, as it does for picks: the id is a hash of the line rather than of
 * its price, so the row that survives is the number available when the rule first had an
 * opinion. Re-recording on later cycles is a no-op, which keeps one line from becoming
 * forty observations of itself and shrinking a confidence interval around a sample that
 * never grew.
 *
 * A line with no fair probability is skipped rather than stored at a placeholder: the
 * probability IS the claim, and a row that makes none cannot be scored. That includes
 * the moneylines `shop.ts` refuses to de-vig, which must not become rows asserting 50%.
 */
export async function recordLineCensus(
  rows: BoardEdge[],
  ruleVersionId: string,
  observedAt: string = new Date().toISOString(),
): Promise<CensusResult> {
  const usable = rows.filter(
    (row) =>
      row.price !== null &&
      row.fairProbability !== null &&
      row.fairProbability > 0 &&
      row.fairProbability < 1,
  );
  const skipped = rows.length - usable.length;
  if (usable.length === 0) return { considered: rows.length, written: 0, skipped };

  const db = await getPool();
  if (!db) return { considered: rows.length, written: 0, skipped };

  const marks = COLUMNS.map((_, i) => `$${i + 1}`).join(", ");
  let written = 0;
  for (const row of usable) {
    const values = [
      censusId(row.eventId, row.market, row.side, row.book, ruleVersionId),
      observedAt,
      row.league,
      row.eventId,
      row.commenceTime,
      row.homeTeam,
      row.awayTeam,
      row.book,
      row.market,
      row.side,
      row.line,
      row.price,
      row.consensusLine,
      row.consensusProbability,
      row.fairProbability,
      row.breakEven,
      row.expectedRoi,
      row.edgePoints,
      row.booksCompared ?? 0,
      row.thinConsensus ?? false,
      ruleVersionId,
    ];
    const result = await db.query(
      `INSERT INTO line_census (${COLUMNS.join(", ")}) VALUES (${marks})
       ON CONFLICT (census_id) DO NOTHING`,
      values,
    );
    written += result.rowCount ?? 0;
  }
  return { considered: rows.length, written, skipped };
}

const CENSUS = `
SELECT census_id, league, event_id, book, market, side, line, price,
       consensus_line, consensus_probability, fair_probability, break_even,
       edge_points, books_compared, thin_consensus
  FROM line_census
`;

/**
 * Every censused line, for fitting the calibration.
 *
 * Returns nothing rather than throwing when the table is not there yet: a database one
 * migration behind is a normal state during a deploy, and a page that will not render
 * because a measurement is missing is worse than one that renders without it.
 */
export async function listCensus(): Promise<CensusRow[]> {
  const db = await getPool();
  if (!db) return [];
  try {
    const result = await db.query(CENSUS);
    return (result.rows as Record<string, unknown>[]).map((row) => ({
      census_id: String(row.census_id),
      league: String(row.league),
      event_id: String(row.event_id),
      book: String(row.book),
      market: row.market as CensusRow["market"],
      side: String(row.side),
      line: row.line === null ? null : Number(row.line),
      price: Number(row.price),
      fair_probability: Number(row.fair_probability),
      break_even: row.break_even === null ? null : Number(row.break_even),
      edge_points: row.edge_points === null ? null : Number(row.edge_points),
      books_compared: Number(row.books_compared ?? 0),
      thin_consensus: row.thin_consensus === true,
    }));
  } catch (error) {
    if ((error as { code?: string })?.code === "42P01") return [];
    throw error;
  }
}
