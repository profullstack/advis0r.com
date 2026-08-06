/**
 * Crypto analysis — deterministic, technical-only.
 *
 * The stock analyzer reasons about executive communications, SEC filings and
 * fundamentals. A digital asset has none of those: no issuer, no filings, no
 * management to assess. Running the equity analyzer here would produce a
 * confident-looking report grounded in nothing — catalystScore falls out of an
 * empty transcript evidence set as 0, and every fundamentals-derived component
 * silently defaults. That is worse than showing no analysis at all.
 *
 * So this is a separate, narrower thing. It reads ONLY the indicators the
 * technical engine already computed locally, states what they say in prose,
 * and is explicit both about what it looked at and about what does not exist
 * to be looked at. It invents no numbers: every figure in the output is one
 * that was passed in.
 *
 * Deliberately not an `AnalysisProvider`: that interface promises an
 * evidence-cited `StockAnalysis` over a corpus, and this has no corpus.
 */
import type { TechnicalIndicatorSet, TechnicalScore } from "../types.ts";

export interface CryptoAnalysis {
  /** One-paragraph read of the current technical state. */
  thesis: string;
  /** Constructive observations, each traceable to an indicator. */
  supportSummary: string[];
  /** Cautionary observations, same rule. */
  riskSummary: string[];
  /** What this analysis structurally cannot see. */
  missingData: string[];
  /** 0-100, straight from the technical score — not a second opinion. */
  technicalScore: number | null;
  /** Which indicators were actually available (nulls are excluded). */
  basedOn: string[];
  method: "deterministic-technical-v1";
}

const pct = (n: number, dp = 1) => `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`;
const near = (a: number, b: number, tolerance = 0.02) => Math.abs(a - b) / (b || 1) < tolerance;

/**
 * What this can never know, stated up front so the absence is a documented
 * property of the method rather than something the reader has to infer.
 */
const STRUCTURAL_GAPS = [
  "No issuer, filings or executive communications exist for a digital asset — the transcript and SEC evidence behind an equity report has no counterpart here.",
  "Volume is Alpaca's US venue only, so liquidity and relative-volume readings are not market-wide.",
  "No on-chain data (holder concentration, exchange flows, supply schedule) is consulted.",
];

export function analyzeCrypto(
  symbol: string,
  name: string,
  indicators: TechnicalIndicatorSet | undefined,
  score: TechnicalScore | undefined,
): CryptoAnalysis | null {
  // No indicators means no analysis. Saying nothing is the correct output;
  // a thesis assembled from absent inputs would be fabrication.
  if (!indicators) return null;

  const t = indicators;
  const support: string[] = [];
  const risks: string[] = [];
  const basedOn: string[] = [];

  const last = t.lastClose;
  const sma20 = t.sma?.[20] ?? null;
  const sma50 = t.sma?.[50] ?? null;
  const sma200 = t.sma?.[200] ?? null;

  for (const [label, value] of [
    ["SMA20", sma20], ["SMA50", sma50], ["SMA200", sma200],
    ["RSI(14)", t.rsi14], ["MACD", t.macd?.macd], ["ATR(14)", t.atr14],
  ] as const) {
    if (value != null) basedOn.push(label);
  }

  // --- Trend, from price vs its own averages -------------------------------
  const above: string[] = [];
  const below: string[] = [];
  for (const [label, v] of [["20-day", sma20], ["50-day", sma50], ["200-day", sma200]] as const) {
    if (v == null) continue;
    (last > v ? above : below).push(label);
  }
  if (above.length) support.push(`Trading above its ${above.join(", ")} average${above.length > 1 ? "s" : ""}.`);
  if (below.length) risks.push(`Trading below its ${below.join(", ")} average${below.length > 1 ? "s" : ""}.`);

  if (t.goldenCross) support.push("50-day average has crossed above the 200-day (golden cross).");
  if (t.deathCross) risks.push("50-day average sits below the 200-day (death cross).");

  // --- Momentum ------------------------------------------------------------
  const m20 = t.momentum?.[20] ?? null;
  const m60 = t.momentum?.[60] ?? null;
  const m120 = t.momentum?.[120] ?? null;
  if (m20 != null) {
    basedOn.push("momentum");
    (m20 >= 0 ? support : risks).push(`${pct(m20)} over the last 20 sessions.`);
  }
  if (m120 != null && m60 != null && m120 < 0 && m60 > 0) {
    support.push(`Recovering: ${pct(m60)} over 60 sessions against ${pct(m120)} over 120.`);
  }

  // --- RSI -----------------------------------------------------------------
  if (t.rsi14 != null) {
    if (t.rsi14 >= 70) risks.push(`RSI ${t.rsi14.toFixed(1)} is in overbought territory.`);
    else if (t.rsi14 <= 30) support.push(`RSI ${t.rsi14.toFixed(1)} is in oversold territory.`);
    else support.push(`RSI ${t.rsi14.toFixed(1)} is neutral.`);
  }

  // --- MACD ----------------------------------------------------------------
  if (t.macd?.macd != null && t.macd.signal != null) {
    const bull = t.macd.macd > t.macd.signal;
    (bull ? support : risks).push(`MACD is ${bull ? "above" : "below"} its signal line.`);
  }

  // --- Range position ------------------------------------------------------
  if (t.distanceFrom52WeekHigh != null) {
    basedOn.push("52-week range");
    if (near(t.distanceFrom52WeekHigh, 0, 0.03)) support.push("Trading at or near its 52-week high.");
    else risks.push(`${pct(t.distanceFrom52WeekHigh)} from its 52-week high.`);
  }
  if (t.distanceFrom52WeekLow != null && t.distanceFrom52WeekLow < 10) {
    risks.push(`Only ${pct(t.distanceFrom52WeekLow)} above its 52-week low.`);
  }

  // --- Volatility ----------------------------------------------------------
  if (t.volatilityRegime === "high") {
    risks.push("Volatility is elevated relative to its own recent range — position sizing matters more than direction.");
  } else if (t.volatilityRegime === "low") {
    support.push("Volatility is subdued relative to its own recent range.");
  }
  if (t.breakout) support.push("Price has broken above its recent range.");
  if (t.breakdown) risks.push("Price has broken below its recent range.");

  // --- Thesis --------------------------------------------------------------
  const trendWord = t.trend === "bullish" ? "constructive" : t.trend === "bearish" ? "deteriorating" : "mixed";
  const scoreClause = score?.score != null
    ? ` The technical setup scores ${score.score.toFixed(0)}/100 on the same rubric used for equities, though its liquidity component is not comparable — see the caveats below.`
    : "";
  const thesis =
    `${name} (${symbol}) presents a ${trendWord} technical picture: ` +
    `${above.length ? `price is above its ${above.join(" and ")} average${above.length > 1 ? "s" : ""}` : "price is below its major averages"}` +
    `${t.rsi14 != null ? `, with RSI at ${t.rsi14.toFixed(1)}` : ""}` +
    `${t.volatilityRegime ? ` and ${t.volatilityRegime} volatility` : ""}.` +
    scoreClause +
    ` This is a reading of price behaviour only — no issuer disclosure exists for a digital asset, so nothing here speaks to adoption, protocol changes, regulation or counterparty risk.`;

  return {
    thesis,
    supportSummary: support,
    riskSummary: risks,
    missingData: STRUCTURAL_GAPS,
    technicalScore: score?.score ?? null,
    basedOn: [...new Set(basedOn)],
    method: "deterministic-technical-v1",
  };
}
