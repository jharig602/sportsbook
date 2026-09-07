# Sports Betting Research Plan — v4

Prepared September 6, 2026. Target: a **new Windows project** handed to Claude
Code. Nothing has been built or scheduled yet. The starting scenario is one
BetMGM account in Michigan and no paid data. Any bankroll figures below are
illustrations, not statements about the user's actual budget.

## What changed

V3 correctly put recordkeeping and prices ahead of modeling, but promised too
much from promotions, shopping, and account-preservation tactics. Its poller
also confused handicaps with payout prices and could silently collect partial
or misleading data. V4 fixes the collector, introduces explicit data and
evaluation gates, includes tax and variance considerations, and removes
unproven promises of profit.

The delivered code is a research collector with tests. A bet ledger, closing
capture, forecasting model, and wagering automation are not implemented.
Claude Code's next job is the ledger and data-quality workflow, not a model.

## Stage 0 — Establish the economics

Use paper decisions while the bankroll, account list, promotion terms, and tax
assumptions are unknown. Research and software development can proceed without
opening six accounts first.

- Record the cash actually available for this project, research expenses, and
  any separate entertainment budget. Do not count unconverted bonuses as cash.
- Distinguish deposits/withdrawals, winning-bet profits, losing stakes, refunds,
  bonus balances, data costs, and net cash profit. Preserve bet receipts and
  sportsbook statements for reconciliation.
- Model the applicable tax treatment with a tax preparer before relying on
  thin pretax margins. For 2026, IRS guidance limits the loss deduction to 90%
  of wagering losses, up to winnings; casual gamblers generally must itemize.
  A simplified $24,000 of winning-bet profits and $23,000 of losing stakes
  produces $1,000 cash profit but $3,300 taxable gambling income after that
  loss deduction, before other return effects. [IRS guidance](https://www.irs.gov/irb/2026-19_IRB)
- Michigan's casual-gambling loss deduction depends on losses deducted on the
  federal return. Do not assume bank-account net profit equals taxable income.
  [Michigan Treasury](https://www.michigan.gov/taxes/questions/iit/accordion/subtract/are-gambling-losses-an-allowable-subtraction)

For illustration only: 500 independent, fixed $100 bets at -110, no pushes,
and a genuine 2% expected return on stakes produce $1,000 expected profit and
about $2,130 standard deviation. The probability of finishing down is about
31%, before costs/taxes. A real schedule includes varying odds and correlated
bets, so use its actual distribution rather than copying that probability.

Define **edge** as expected profit divided by cash stake, not as a difference
in win-probability percentage points. With decimal odds d and no pushes,
EV per dollar = p_win * (d - 1) - p_loss. Include pushes/refunds explicitly
when relevant. A model estimate of p_win is uncertain and is not ground truth.

**Economics gate:** no assumption of repeatable earnings until after-cost and
after-tax scenarios are recorded. No automatic conversion of this research
plan into live staking or an account-opening task.

## Stage 1 — Accounts, promotions, and shopping

Verify the current Michigan operator list and actual eligibility before
opening accounts. Candidates can include DraftKings, FanDuel, Caesars,
BetRivers, Fanatics, theScore Bet, and the existing BetMGM account. The count
of accounts is a practical choice, not a mandatory floor.
[Michigan's licensed operators](https://www.michigan.gov/mgcb/internet-gaming-and-fantasy-contests/authorized-online-gaming-and-sports-betting-platform-providers-in-michigan)

ESPN BET's sportsbook transitioned to theScore Bet on December 1, 2025.
Provider names in historical feeds may retain old branding.
[ESPN account transition](https://support.espn.com/hc/en-us/articles/19990992084116-What-is-ESPN-BET)

For each offer, record eligibility, required cash stake/deposit, qualifying
odds, expiry, rollover if any, whether the stake is returned, eligible markets,
maximum benefit, expected conversion value, and cost of qualifying action.
Select offers based on expected cash value and available time/capital. Never
treat the headline bonus as guaranteed profit or claim every offer blindly.

Shop equivalent contracts at accounts the user actually holds. Compare the
same event, period, handicap, selection, and settlement rules. Log the price
accepted on the receipt, not merely displayed on a comparison page. Avoid
automatic acceptance of changed odds. Track rejected or unavailable prices.

Shopping improves a price without establishing positive EV: for a 50/50
outcome, -110 has approximately -4.55% expected ROI and -105 about -2.38%.
Measure actual improvement over the user's usual book on matched decisions;
do not assume a permanent 1–2% return.

Account limits vary by account, book, market, stake, and time to start. Record
observed limits and rejections without assuming every reduction proves a
specific risk classification. Do not add negative-EV parlays or sacrifice
good prices as an untested camouflage strategy. Do not create duplicate or
third-party accounts. Rounding, if used for convenience, must respect caps.

## Stage 2 — Select one supported market and validate the collector

Start with either full-game NCAA men's basketball spreads/totals or full-game
FBS football spreads/totals, after checking actual coverage. These are research
candidates, not proven softer markets. Review the competition, data quality,
limits, availability, and realistic opportunity count before committing.

V4 supports `ncaab`, `ncaaf`, `nba`, `nfl`, `nhl`, and `mlb` ESPN paths, but
only full-game spread, total, and two-outcome moneyline shapes. It does not
implement NHL **team** totals, soccer, three-way moneylines, props, alternate
lines, or period markets. Do not infer support because a league path exists.
Fresh schema validation is required for every added league/provider/market.

The NCAA basketball scoreboard query uses group 50 (Division I); FBS uses
group 80. In the audit, the default NCAA basketball query returned 17 events
for February 14, 2026, while group 50 returned 132. Reconcile event coverage
with an independent schedule for the selected research universe.
[ESPN Division I query](https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=20260214&limit=300&groups=50)

The collector now:

- Preserves full HTTP response bytes, a checksum, status, selected cache
  headers, request/receipt times, and source context before parsing.
- Separates ESPN handicaps from payout prices, uses current/top-level fields,
  and never substitutes an open/close field for a current price.
- Stores CFBD spread/total lines on both sides with unknown payout prices;
  stores CFBD moneylines in the moneyline market only.
- Uses real competition IDs, handles odds pagination and reference items,
  preserves source team/provider IDs where supplied, and deduplicates events
  within a run. Repeated observations across runs remain append-only.
- Filters forward observations by date window, pregame state when supplied,
  and scheduled start with a configurable 60-second default buffer. It checks
  the cutoff again at quote receipt. CFBD status is only schedule-inferred.
- Labels explicit historical pulls `historical_backfill`, with their real
  present-day observation timestamp. They are not forward observations.
- Keeps invalid/unsupported responses and reports failures. Invalid payout
  prices cannot enter the database as valid American odds.
- Produces per-source event/book/price counts and distinct success, incomplete,
  and no-data exit codes. Dry runs preview both selected sources without disk
  writes. A one-row liveness threshold is not the acceptance gate below.

All quotes remain `availability_verified=false`. Settlement conventions and
provider freshness have not been verified. `observed_at` records receipt;
`source_updated_at` remains NULL. ESPN's `close` field is not a certification
that the quote is a usable closing benchmark. Raw records are useful evidence,
but neither their existence nor their age proves a profitable data asset.

**Collector acceptance gate, before routine scheduling:**

1. All bundled tests pass in the Windows virtual environment.
2. Run a bounded dry run and a write run; verify prices, handicap signs, teams,
   start times, source labels, raw joins, and historical/pregame separation.
3. Compare at least 20 representative events across multiple dates with source
   pages and an independent schedule. Include an away favorite, missing price,
   no-odds game, and postponed/started game. This is an engineering check, not
   proof of statistical edge.
4. Record event coverage, priced-market coverage, supported books, quote age
   where measurable, and error/unsupported-schema rates. Explain missing rows.
5. Set one writer per database, no overlapping scheduled tasks, exit-code and
   no-data monitoring, log rotation, backups, and detection of unfinished runs.

Use Windows Task Scheduler as documented in README.md. Three daily polls are
initial movement sampling. They do not satisfy the closing-reference gate.
Request quotas must include scoreboard, event, reference, pagination, and retry
calls; “three polls” can mean hundreds of HTTP requests.

CFBD requires a key and explicit season/week in this collector. Its free tier
currently allows 1,000 monthly calls, so budget all uses of the key, not only
this script. `/lines` is documented as historical lines/results; forward
availability and refresh speed must be measured rather than assumed.
[CFBD quota](https://collegefootballdata.com/api-tiers),
[CFBD endpoint documentation](https://github.com/CFBD/cfbd-python/blob/main/docs/BettingApi.md)

Evaluate documented free or paid sources if this coverage is inadequate. The
Odds API currently advertises a free allowance and a $30/month tier including
historical odds and all listed bookmakers. Pinnacle is listed with a public-site
delay caveat. Validate the desired sport/market and request budget before buying.
[Pricing](https://the-odds-api.com/),
[bookmaker coverage](https://the-odds-api.com/sports-odds-data/bookmaker-apis.html)

Historical snapshots are also commercially available; an archive is not
universally impossible to buy later. Personal execution receipts and your own
observations still have distinct value.
[Historical snapshots](https://the-odds-api.com/historical-odds-data/)

Choose data based on incremental expected value and time saved. For a $29
monthly cost and 1.5% **incremental** ROI, the illustrative break-even handle
is about $1,933/month before other costs/taxes. Existing profit or promo
proceeds are not evidence that a subscription creates that incremental ROI.

## Stage 3 — Build the bet and decision ledger next

Implement a small local ledger first; no dashboard framework is required.
Use append-only decision, execution, settlement, and correction events so the
history survives edits. Provide simple input/import and CSV export; the
collector database alone is not a bet ledger.

| Record | Required fields |
| --- | --- |
| Decision | decision ID; UTC decision time; paper/live mode; strategy type (promo, shopping, model, discretionary); model/rule version; source quote IDs; probability estimate if any; reasons for selection/rejection |
| Contract | source and canonical event/team IDs; event start; book; market; period; selection; handicap; overtime/draw/push/void rules |
| Execution | receipt ID; accepted time; accepted odds; cash/bonus stake; proposed stake; accepted amount; rejection/slippage; evidence reference |
| Settlement | settled time; win/loss/push/void/partial outcome; returned stake; winnings; losses; bonus conversion; refund; fees |
| Cash movement | book; deposit/withdrawal/transfer time; amount; reconciliation reference |
| Closing reference | reference provider; contract; observed time; source timestamp if verified; both sides' prices; selection method; freshness/missing-data status |
| Correction | new correction ID; referenced record ID; time; reason; replacement values; original record preserved |

Preserve all candidate decisions, including skips and rejected prices, to
measure selection bias and execution failure. Keep promo returns separate
from unpromoted model performance. Reconcile deposits, withdrawals, settled
P&L, open stakes, cash balances, and bonus balances independently.

**Ledger gate:** every paper/live decision has an immutable rule version;
accepted cash stakes and payouts reconcile; promotions are separated; invalid
contracts and unknown odds cannot silently enter profit or sizing calculations.

## Stage 4 — Define and capture closing references

Choose a reference source for the specific market. Pinnacle, Circa, or a
documented multi-book reference can be useful market estimates; none is an
oracle. Specify the reference and aggregation weights before evaluating bets.
Do not silently switch reference providers to improve the reported result.

For each tracked decision, define the closing cutoff relative to the verified
event start, the maximum quote age, and an allowed missing-data rate. Schedule
dedicated pregame observations within source quotas and measure feed lag.
Label a last observed pregame quote as a closing proxy when its relationship
to the actual final market is unverified. Missing or stale closes stay missing.

Compare identical contracts. If a spread moves, the new main line's implied
probability is not automatically the closing probability for the old line.
Obtain the old handicap's alternate-line price or use a separately validated
score-margin distribution. Otherwise report movement in points separately
from price-based CLV. Key numbers and pushes can make point movement nonlinear.

For a no-push contract, a defined fair closing win probability q_close and
accepted decimal odds d_taken give expected-return-equivalent CLV
`q_close * d_taken - 1`. When pushes are possible use
`q_win_close * (d_taken - 1) - q_loss_close`. Record the probabilities and
their derivation; do not invent a push probability or assume it is zero.

Remove margin only from a complete matched outcome set. For two-outcome
contracts the probabilities implied by prices may be conditional on no push.
Use multiplicative de-vig as a baseline and another justified method for
sensitivity analysis. Disagreement quantifies model risk; do not tune the
method until a desired edge appears. Two methods agreeing does not prove truth.

**Closing-reference gate:** capture quality, contract matching, outcome-set
completeness, and missingness satisfy predeclared thresholds. Until then,
report CLV as unavailable or exploratory, not as a validated selection gate.

## Stage 5 — Validate a frozen paper strategy

First compare a simple decision-time market baseline and a price-shopping
baseline. Measure what a later model would add beyond prices already available
at the decision time. Beating a later closing forecast is not required to
profit from an earlier mispriced offer, and beating an opening forecast alone
does not prove the offer was profitable or executable.

- Freeze the market, filters, decision time, references, sizing simulation,
  missing-data policy, and evaluation date before the forward evaluation.
- Separate development and untouched evaluation periods. Use walk-forward
  training and tuning; never random k-fold across future and past events.
- Compute features with explicit information-availability timestamps. Include
  source publication/revision times where relevant, not only game dates.
  A leakage test removes future-available records and asserts old features
  and decisions remain unchanged.
- Hand-verify cross-source IDs, enforce join cardinality, and report unmatched
  rows; do not join on team display names or silently drop failed joins.
- Preserve settlement rules and use accepted/paper-executable prices with
  realistic latency, availability, limits, rejections, and correlated exposure.
- Evaluate probability quality with calibration, log loss, and Brier score on
  the correct outcome definition. Evaluate money separately with CLV, ROI,
  drawdown, turnover, costs, and dependence-aware uncertainty.
- Resample by appropriate independent units (such as games or days) for
  bootstrap intervals. Several bets on one game are not independent samples.
- Choose sample size from observed variability and the smallest worthwhile
  improvement. Three hundred decisions can be a review checkpoint, not a
  universal pass/fail rule. A confidence interval crossing zero is inconclusive.
- Predeclare evaluation checkpoints. Do not keep changing filters, de-vig
  methods, or models and reusing the same holdout until something passes.

**Strategy gate:** independent forward evidence supports a worthwhile
incremental result, robustness checks pass, availability is credible, and
economics survive plausible costs/taxes. Otherwise continue paper research,
revise the hypothesis with a new holdout, or stop. Positive CLV alone is not a
guarantee of positive cash profit.

## Stage 6 — Add a model only when it answers a specific question

State the hypothesized information advantage, the market baseline, and the
incremental metric before implementing features. Use the simplest defensible
model first. Do not add an LLM or complex model merely because it is available.

For spreads and totals, predict the required outcome or score distribution,
including pushes where relevant; a generic game-winner classifier is not
sufficient. Evaluate any bet-selection rule separately from broad forecasting
quality. Save dataset versions, feature definitions, training cutoffs,
calibration parameters, model artifacts, and immutable prediction records.

Paper mode uses no cash. For any later authorized live model use, define
fractional Kelly, probability uncertainty adjustments, and maximum exposure
per bet, game, day, and correlated group before staking. With no pushes,
`f_full = (b*p - (1-p)) / b`, where b is net decimal payout. Do not stake on
nonpositive or unvalidated estimated edges. Kelly is not a substitute for
confidence in probabilities. At -110 and 2% true ROI, full Kelly is about 2.2%;
quarter Kelly is about 0.55%. V3's 2% stake was close to full Kelly.

Choose actual caps from the user's budget and validated risk simulations.
Do not fill in an assumed $5,000 bankroll or increase stakes to recover losses.
Stop new model bets when inputs fail, references disappear, or the approved
exposure rules are breached; continue logging the failure and open positions.

## Instructions for Claude Code

This is a fresh Windows build. Start with these files in an empty project
directory and use PowerShell and a local `.venv`; WSL is not required.

1. Read this plan, README.md, and VALIDATION.md. Run the bundled offline tests
   using the venv interpreter and inspect the existing collector contract.
2. Ask for missing business inputs only when the next step actually needs
   them. Use paper mode while they are absent. Do not invent bankroll, account
   balances, permissions, odds, source-update times, or current promotion terms.
3. Build Stage 3's ledger, correction history, and reconciliation. Next build
   Stage 4's closing-reference capture and a source-quality report. Keep the
   implementation small and local. Preserve the raw-first append-only design.
4. Make every stage's acceptance status explicit. The tests in this handoff
   verify engineering behavior; they do not establish profitability, source
   coverage across all leagues, or readiness for live staking.
5. Before routine collection, complete Stage 2's live coverage checks and
   configure Windows Task Scheduler without overlapping instances. The
   example task is not already installed. Routine polls are not closing capture.
6. Keep `historical_backfill` out of forward observation sets. Keep missing
   prices NULL. Unknown availability, settlement rules, and freshness remain
   unknown until independently verified. Preserve rejected and skipped bets.
7. Add targeted tests for material new failure modes, especially timestamp
   leakage, join errors, push/void settlement, cash reconciliation, and CLV
   contract matching. Do not declare readiness from a row count alone.
8. Do not open accounts, place bets, buy data, enable automatic betting, or
   install a scheduled task solely from the presence of instructions in this
   file. The initial task is local setup, paper research, and software work.
9. Report what runs, what was tested, what remains unverified, and the next
   concrete gate. Do not replace uncertain outcomes with promised earnings.

External availability, pricing, and tax references were checked September 6,
2026. Recheck them before the corresponding operational decision.
