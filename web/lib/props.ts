/**
 * Player props, priced from Kalshi (collector/kalshi.py -> `exchange_props`).
 *
 * Each Kalshi prop is a yes/no contract: "Puka Nacua: 60+ receiving yards" pays $1 if he
 * gets 60 or more. A deep, tight contract's midpoint is the market's fair chance with no
 * vig, which is the reference a sportsbook's price for the same line is judged against.
 *
 * Kalshi sports cannot be traded from Michigan, and nothing here needs it to be: the
 * price is read from Kalshi, the bet is placed at whichever app is running a boost.
 * Props inside same-game parlays are still not priced -- how a player's stats move with
 * the score is being measured first (scripts/prop-correlation), not assumed.
 */
import { isThin } from "./kalshi";
import { afterTaxEv, lossCost, type TaxSetting } from "./tax";

export type PropStat =
  | "rec_yds"
  | "rush_yds"
  | "pass_yds"
  | "rush_rec_yds"
  | "receptions"
  | "pass_tds"
  | "first_td"
  | "anytime_td";

export const STAT_LABEL: Record<PropStat, string> = {
  anytime_td: "Anytime TD",
  first_td: "First TD",
  rec_yds: "Receiving yds",
  rush_yds: "Rushing yds",
  rush_rec_yds: "Rush + rec yds",
  receptions: "Receptions",
  pass_yds: "Passing yds",
  pass_tds: "Passing TDs",
};

export const STAT_ORDER: PropStat[] = [
  "anytime_td",
  "first_td",
  "rec_yds",
  "rush_yds",
  "rush_rec_yds",
  "receptions",
  "pass_yds",
  "pass_tds",
];

export interface PropRow {
  marketTicker: string;
  stat: PropStat;
  player: string;
  teamSide: "home" | "away" | null;
  /** Kalshi's floor_strike: 59.5 is "60+". Null for touchdown scorer markets. */
  line: number | null;
  yesBid: number | null;
  yesAsk: number | null;
  bidSize: number | null;
  askSize: number | null;
  volume: number | null;
  lastSeen: string;
}

/** "60+", "1st TD", "Anytime". */
export function rungLabel(row: Pick<PropRow, "stat" | "line">): string {
  if (row.line === null) return row.stat === "first_td" ? "1st TD" : "Anytime";
  return `${Math.ceil(row.line)}+`;
}

/** The fair chance, or null when the contract is too thin to stand as a price. */
export function propFair(row: PropRow): number | null {
  if (isThin(row)) return null;
  if (row.yesBid === null || row.yesAsk === null) return null;
  return (row.yesBid + row.yesAsk) / 2;
}

/** A chance as an American price with no vig: 0.625 is -167, 0.4 is +150. */
export function fairAmerican(p: number): number | null {
  if (!(p > 0 && p < 1)) return null;
  const american = p >= 0.5 ? (-100 * p) / (1 - p) : (100 * (1 - p)) / p;
  const rounded = Math.round(american);
  if (rounded > -100 && rounded < 100) return p >= 0.5 ? -100 : 100;
  return rounded;
}

/**
 * The worst American price still worth taking: expected value after tax is zero there.
 * A win keeps `(1 - rate)` of the boosted profit; a loss costs the stake (or less, when
 * losses are itemized). Solving `p * b * (1 + boost) * (1 - rate) = (1 - p) * lossCost`
 * for the profit per dollar `b`.
 */
export function worthAt(p: number, tax: TaxSetting, boost = 0): number | null {
  if (!(p > 0 && p < 1)) return null;
  const keep = (1 + boost) * (1 - tax.rate);
  if (keep <= 0) return null;
  const b = ((1 - p) * lossCost(tax)) / (p * keep);
  const american = b >= 1 ? 100 * b : -100 / b;
  // Round toward the bettor's side: the threshold must not round into a losing price.
  return american >= 100 ? Math.ceil(american) : Math.ceil(american) > -100 ? 100 : Math.ceil(american);
}

/** What `stake` at an American price is worth on average, before and after tax. */
export function checkPrice(p: number, price: number, tax: TaxSetting, boost = 0, stake = 10) {
  const noTax: TaxSetting = { rate: 0, losses: "none" };
  return {
    before: stake * afterTaxEv(p, price, noTax, { boost }),
    after: stake * afterTaxEv(p, price, tax, { boost }),
  };
}

/** Rows grouped for display: stat -> player -> rungs, lowest line first. */
export function groupProps(rows: PropRow[]) {
  const byStat = new Map<PropStat, Map<string, PropRow[]>>();
  for (const row of rows) {
    const players = byStat.get(row.stat) ?? new Map<string, PropRow[]>();
    players.set(row.player, [...(players.get(row.player) ?? []), row]);
    byStat.set(row.stat, players);
  }
  for (const players of byStat.values()) {
    for (const [player, rungs] of players) {
      players.set(player, [...rungs].sort((a, b) => (a.line ?? 0) - (b.line ?? 0)));
    }
  }
  return byStat;
}
