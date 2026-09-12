/**
 * Did the things it called 55% come in at 55%.
 *
 * This is the question worth asking of the line-shopping rule, and it is a different and
 * much better question than "what is its win rate". A win rate tests one claim — that
 * the rule beats break-even — and needs hundreds of settled games to separate a real
 * edge from noise; the cover record has been undecided for a season on exactly that
 * ground. Calibration tests a claim per pick, at whatever probability each one asserted,
 * so dozens of picks already say something.
 *
 * It is also the claim that actually matters. The rule's whole output is a probability:
 * expected return is that probability priced against what the book charges. If the
 * probabilities are honest the returns follow arithmetically, and if they are not, a win
 * rate that happens to look good is telling you about variance rather than about method.
 *
 * The failure it is built to catch is overconfidence, which is the natural failure of a
 * consensus model: shrinking too little, treating two books as a market, and calling
 * things 58% that are 52%. That shows as actual sitting below predicted in the upper
 * bands, and it would be entirely invisible in a cover rate.
 */
import { judge, type Judgement } from "./verdict";

export interface Calibrated {
  market: string;
  league: string;
  fair_probability: number;
  result_covered: boolean | null;
}

export interface Band {
  lo: number;
  hi: number;
  label: string;
  n: number;
  hits: number;
  /** Mean probability the rule asserted for the picks in this band. */
  predicted: number | null;
  /** Share that actually came in. */
  actual: number | null;
  /** actual - predicted. Negative means the rule was overconfident here. */
  gap: number | null;
  /** Interval on `actual`, judged against what was predicted rather than break-even. */
  verdict: Judgement | null;
}

export interface Calibration {
  bands: Band[];
  n: number;
  /** Mean predicted across every graded pick. */
  predicted: number | null;
  /** Mean actual across every graded pick. */
  actual: number | null;
  /**
   * Mean squared error of the probabilities — the Brier score.
   *
   * Kept because it is the one number that punishes both directions at once: a rule
   * that says 50% about everything is perfectly calibrated and completely useless, and
   * a Brier score notices while a calibration table does not. Lower is better; 0.25 is
   * what you get by saying "coin flip" every time, so anything at or above that is
   * worse than useless.
   */
  brier: number | null;
  /** Brier of the "always say 50%" rule, for comparison on this exact sample. */
  brierBaseline: number | null;
}

/**
 * Bands wide enough to hold something.
 *
 * Deliberately coarse. Ten narrow bins across a hundred picks gives ten bins of ten,
 * each of which swings twenty points on one game — a chart made entirely of noise that
 * looks like a diagnosis. Four bands is the most this sample can carry, and they can
 * split when it grows.
 */
const BANDS: Array<[number, number]> = [
  [0, 0.45],
  [0.45, 0.55],
  [0.55, 0.65],
  [0.65, 1],
];

export function calibrate(picks: Calibrated[]): Calibration {
  // A push is neither right nor wrong about a probability, so it leaves entirely.
  const decided = picks.filter((p) => p.result_covered !== null);

  const bands: Band[] = BANDS.map(([lo, hi]) => {
    const inBand = decided.filter(
      (p) => p.fair_probability >= lo && (hi === 1 ? p.fair_probability <= hi : p.fair_probability < hi),
    );
    const hits = inBand.filter((p) => p.result_covered).length;
    const n = inBand.length;
    const predicted =
      n > 0 ? inBand.reduce((sum, p) => sum + p.fair_probability, 0) / n : null;
    const actual = n > 0 ? hits / n : null;

    return {
      lo,
      hi,
      label: `${Math.round(lo * 100)}–${Math.round(hi * 100)}%`,
      n,
      hits,
      predicted,
      actual,
      gap: predicted === null || actual === null ? null : actual - predicted,
      // Judged against what the rule PREDICTED for this band, not against break-even.
      // The question here is honesty, not profitability -- a band that predicted 42%
      // and delivered 42% is perfectly calibrated and still loses money, and conflating
      // the two is how a working model gets thrown away.
      verdict: n > 0 && predicted !== null ? judge(hits, n, predicted) : null,
    };
  });

  const n = decided.length;
  if (n === 0) {
    return { bands, n: 0, predicted: null, actual: null, brier: null, brierBaseline: null };
  }

  const hits = decided.filter((p) => p.result_covered).length;
  const brier =
    decided.reduce((sum, p) => {
      const outcome = p.result_covered ? 1 : 0;
      return sum + (p.fair_probability - outcome) ** 2;
    }, 0) / n;
  const brierBaseline =
    decided.reduce((sum, p) => sum + (0.5 - (p.result_covered ? 1 : 0)) ** 2, 0) / n;

  return {
    bands,
    n,
    predicted: decided.reduce((sum, p) => sum + p.fair_probability, 0) / n,
    actual: hits / n,
    brier,
    brierBaseline,
  };
}
