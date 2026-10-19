/**
 * Which measured correlation a player prop gets inside a same-game parlay -- or why it
 * gets none.
 *
 * The numbers are `config/prop-correlation.json` (collector/prop_correlation.py: nflverse
 * 2015-2025, fitted 2015-21 and held on 2022-25), pooled across both periods by sample
 * size. Positions come from `config/player-positions.json` (this season's nflverse stats).
 *
 * Only combinations that were measured are priced. A tight end's receptions, a back's
 * receiving yards, a quarterback's rushing yards, first-touchdown scorer, and 2+ passing
 * touchdowns were not, and a parlay with one of them is refused with the reason rather
 * than priced with a neighbour's number.
 */
import measured from "../config/prop-correlation.json";
import positions from "../config/player-positions.json";
import type { PropStat } from "./props";

type Cell = { n: number; rho_margin: number | null; rho_total: number | null };
type Entry = { label: string; train: Cell; test: Cell };
const TABLE = measured as unknown as Record<string, Entry>;
const POSITIONS = positions as Record<string, string>;

export function positionOf(player: string): string | null {
  return POSITIONS[player] ?? null;
}

/** The measured key for a prop, or the reason there is none. */
export function measuredKey(stat: PropStat, position: string | null, line: number | null): { key: string } | { refused: string } {
  if (!position) return { refused: "this player's position is not known yet (he has not played this season)" };
  const table: Partial<Record<PropStat, Record<string, string>>> = {
    anytime_td: { RB: "atd_rb", WR: "atd_wr", TE: "atd_te" },
    rush_yds: { RB: "rush_yds" },
    rush_rec_yds: { RB: "rush_rec_yds" },
    rec_yds: { WR: "rec_yds_wr", TE: "rec_yds_te" },
    receptions: { WR: "receptions_wr" },
    pass_yds: { QB: "pass_yds" },
  };
  if (stat === "pass_tds") {
    if (position !== "QB") return { refused: "passing touchdowns are measured for quarterbacks only" };
    if (line !== 0.5) return { refused: "only 1+ passing touchdowns is measured; 2+ is not" };
    return { key: "pass_tds_any" };
  }
  if (stat === "first_td") return { refused: "first touchdown scorer is a different question from anytime, and is not measured" };
  const key = table[stat]?.[position];
  return key ? { key } : { refused: `${position} ${stat.replace(/_/g, " ")} is not measured` };
}

/** The pooled correlations for a measured key. */
export function correlationsFor(key: string): { rhoMargin: number; rhoTotal: number } | null {
  const entry = TABLE[key];
  if (!entry) return null;
  const cells = [entry.train, entry.test].filter((c) => c && c.n > 0 && c.rho_margin !== null && c.rho_total !== null);
  const n = cells.reduce((sum, c) => sum + c.n, 0);
  if (n === 0) return null;
  return {
    rhoMargin: cells.reduce((sum, c) => sum + c.n * (c.rho_margin as number), 0) / n,
    rhoTotal: cells.reduce((sum, c) => sum + c.n * (c.rho_total as number), 0) / n,
  };
}
