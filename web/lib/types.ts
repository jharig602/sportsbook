export type League = "ncaaf" | "nfl";
export type Market = "spread" | "total" | "moneyline";
export type Side = "home" | "away" | "over" | "under";
export type AlertKind = "first_price" | "steam" | "key_number" | "drift";

export interface Quote {
  line: number | null;
  price: number | null;
}

export interface Game {
  eventId: string;
  league: League;
  commenceTime: string;
  homeTeam: string | null;
  awayTeam: string | null;
  lastObserved: string;
  spread: Partial<Record<Side, Quote>>;
  total: Partial<Record<Side, Quote>>;
  moneyline: Partial<Record<Side, Quote>>;
}

export interface Alert {
  alert_id: string;
  created_at: string;
  league: League;
  event_id: string;
  market: Market;
  side: Side;
  kind: AlertKind;
  prev_line: number | null;
  new_line: number | null;
  prev_price: number | null;
  new_price: number | null;
  /** The falsifiable part: which side this alert expects money to be on. */
  predicted_side: Side;
  line_at_alert: number | null;
  price_at_alert: number | null;
  magnitude: number;
  /**
   * 0-99 ordering device for how unusual the move is. NOT a win probability, and
   * must never be labelled as confidence anywhere in the UI. It becomes a probability
   * only via calibration, and only for buckets with enough settled games.
   */
  move_strength: number;
  message: string;
  rule_version_id: string;
  home_team: string | null;
  away_team: string | null;
  commence_time: string | null;
}

export interface Grade {
  grade_id: string;
  alert_id: string;
  graded_at: string;
  rule_version_id: string;
  market: Market;
  predicted_side: Side;
  move_strength: number;
  line_value_points: number | null;
  line_value_won: boolean | null;
  result_covered: boolean | null;
  result_push: boolean;
  kind: AlertKind;
  league: League;
}

export interface GameResult {
  event_id: string;
  league: League;
  home_team: string | null;
  away_team: string | null;
  home_score: number;
  away_score: number;
  went_overtime: boolean;
  commence_time: string;
}

export interface HistoryPoint {
  market: Market;
  side: Side;
  line: number | null;
  price: number | null;
  observedAt: string;
}

/** One row of the Track Record table: how a slice of alerts has actually done. */
export interface RecordRow {
  label: string;
  fired: number;
  /** Settled and not a push. Only these count toward a rate. */
  decided: number;
  pushes: number;
  lineValueWon: number;
  covered: number;
  /** null when the sample is too thin to publish a rate at all. */
  lineValueRate: number | null;
  coverRate: number | null;
  sufficient: boolean;
}

export interface TrackRecord {
  minSamples: number;
  totalAlerts: number;
  totalGraded: number;
  awaitingResults: number;
  byKind: RecordRow[];
  byStrength: RecordRow[];
  /** Null until something has actually been graded. */
  baseline: { coinFlip: number; alerts: number | null } | null;
}
