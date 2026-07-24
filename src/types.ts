/**
 * Core domain types for transcript-search.
 *
 * These mirror the interfaces described in the PRD (sections 8, 10, 15, 22).
 * They are the shared contract between providers, the filter engine, the
 * analysis providers, and the reporting layer.
 */

// --- Events & documents ---------------------------------------------------

export type EventType =
  | "earnings_call"
  | "investor_day"
  | "conference"
  | "keynote"
  | "fireside_chat"
  | "interview"
  | "shareholder_meeting"
  | "product_launch"
  | "press_conference"
  | "podcast"
  | "presentation"
  | "sec_exhibit"
  | "blog_post"
  | "video"
  | "news_article"
  | "press_release"
  | "conference_talk"
  | "other";

/**
 * Source reputation tier (PRD v3 §3.3). Determines evidentiary weight and
 * whether a document may source facts at all.
 *
 *  0 — Primary: SEC, company IR, company-owned channels, newswires.
 *  1 — Reputable press: AP, Reuters, Bloomberg, WSJ, FT, CNBC, MarketWatch…
 *  2 — Analysis/opinion: Motley Fool, Seeking Alpha, Benzinga… context only.
 *  3 — Excluded/adverse: aggregators, paid-IR and stock-promotion outlets.
 */
export type SourceTier = 0 | 1 | 2 | 3;

/** How a transcript's text was produced — provenance for grounding (PRD §8.4). */
export type TextProvenance =
  | "filing" // verbatim from an SEC document
  | "published" // verbatim published text (article, press release)
  | "captions" // platform-provided captions (e.g. YouTube)
  | "asr"; // machine-transcribed audio — derived, may contain errors

export interface TranscriptQuery {
  topic: string;
  from?: string; // ISO date
  to?: string; // ISO date
  tickers?: string[];
  eventTypes?: EventType[];
  limit?: number;
}

export interface SourceDocument {
  id: string;
  providerId: string;
  title: string;
  url: string;
  eventType: EventType;
  publishedAt?: string;
  tickers: string[];
  /** Publisher / outlet name, when the source is news or a wire release. */
  publisher?: string;
  /** Reputation tier (PRD v3 §3.3). Defaults to 0 for SEC/primary sources. */
  sourceTier?: SourceTier;
  /** True when only a headline/snippet is available (publisher blocked us). */
  paywalled?: boolean;
  /** Direct media URL for audio/video sources. */
  mediaUrl?: string;
  mediaType?: "audio" | "video" | "article" | "filing";
  durationMs?: number;
  /** Free-form provider metadata preserved for audit/reproducibility. */
  meta?: Record<string, unknown>;
}

export interface DownloadedDocument extends SourceDocument {
  localPath: string;
  contentType: string;
  checksum: string;
  fetchedAt: string;
}

export interface TranscriptSegment {
  index: number;
  speaker?: string;
  speakerTitle?: string;
  text: string;
  startMs?: number;
  endMs?: number;
}

export interface ParsedTranscript extends DownloadedDocument {
  segments: TranscriptSegment[];
  /** How the text was produced. Defaults to "filing" for SEC documents. */
  provenance?: TextProvenance;
  /** ASR model identity, when `provenance === "asr"` (PRD §8.4 grounding). */
  asrModel?: string;
  asrVersion?: string;
}

export interface NormalizedTranscript extends ParsedTranscript {
  eventDate: string;
  primaryTicker?: string;
  language: string;
}

// --- Signals (PRD §10) ----------------------------------------------------

export type SignalType = string; // one of the taxonomies in PRD §10.1 / §10.2

export interface TranscriptSignal {
  id: string;
  ticker: string;
  speaker: string;
  speakerTitle?: string;
  eventDate: string;
  eventType: EventType;
  signalType: SignalType;
  direction: "positive" | "negative" | "mixed" | "neutral";
  strength: number;
  novelty: number;
  specificity: number;
  quote: string;
  contextBefore: string;
  contextAfter: string;
  sourceUrl: string;
  evidenceHash: string;
  /** Reputation tier of the document this signal came from (PRD v3 §3.3). */
  sourceTier?: SourceTier;
  /** True when the sentence is filing boilerplate rather than a claim. */
  isBoilerplate?: boolean;
  /** Why it was flagged — kept for auditability rather than silently dropping. */
  boilerplateReasons?: string[];
  /** 1 = attributed to a named speaker; lower when inferred or unknown. */
  speakerConfidence?: number;
  /** Offset into the source media, enabling play-at-timestamp evidence links. */
  startMs?: number;
  /** How the underlying text was produced (ASR text is derived, not verbatim). */
  provenance?: TextProvenance;
}

export interface Contradiction {
  id: string;
  ticker: string;
  description: string;
  claimEvidenceId: string;
  counterEvidenceId: string;
  severity: number;
}

// --- Market data (PRD §7.3, §22) ------------------------------------------

export type AlpacaFeed = "iex" | "sip" | "otc" | "yahoo";
export type AdjustmentMode = "raw" | "split" | "dividend" | "all";
export type BarTimeframe =
  | "1Min"
  | "5Min"
  | "15Min"
  | "1Hour"
  | "1Day"
  | "1Week";

export interface MarketBar {
  symbol: string;
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  vwap?: number;
  timeframe: BarTimeframe;
  adjustment: AdjustmentMode;
}

export interface LatestTrade {
  symbol: string;
  price: number;
  size: number;
  timestamp: string;
}

export interface LatestQuote {
  symbol: string;
  bidPrice: number;
  bidSize: number;
  askPrice: number;
  askSize: number;
  timestamp: string;
}

export interface MarketSnapshot {
  symbol: string;
  latestTrade?: LatestTrade;
  latestQuote?: LatestQuote;
  dailyBar?: MarketBar;
  prevDailyBar?: MarketBar;
  /** Provenance required by PRD §7.3. */
  feed: AlpacaFeed;
  delayed: boolean;
  fetchedAt: string;
  requestId?: string;
}

export interface AlpacaAsset {
  symbol: string;
  name: string;
  exchange: string;
  assetClass: string;
  tradable: boolean;
  status: string;
  fractionable?: boolean;
}

export interface MarketSession {
  date: string;
  open: string;
  close: string;
  sessionOpen: string;
  sessionClose: string;
}

export interface BarsRequest {
  symbols: string[];
  timeframe: BarTimeframe;
  start?: string;
  end?: string;
  limit?: number;
  adjustment?: AdjustmentMode;
  feed?: AlpacaFeed;
}

export interface CalendarRequest {
  start?: string;
  end?: string;
}

// --- Technical analysis (PRD §12) -----------------------------------------

export interface IndicatorConfig {
  movingAverages: number[];
  emaPeriods: number[];
  rsiPeriod: number;
  macd: { fast: number; slow: number; signal: number };
  bollinger: { period: number; stdDev: number };
  atrPeriod: number;
  relativeVolumePeriod: number;
}

export interface TechnicalIndicatorSet {
  symbol: string;
  asOf: string;
  lastClose: number;
  sma: Record<number, number | null>;
  ema: Record<number, number | null>;
  rsi14: number | null;
  macd: { macd: number | null; signal: number | null; histogram: number | null };
  bollinger: { upper: number | null; middle: number | null; lower: number | null };
  atr14: number | null;
  vwap: number | null;
  relativeVolume: number | null;
  avgDailyVolume: number | null;
  avgDollarVolume: number | null;
  momentum: Record<number, number | null>; // keyed by lookback days
  distanceFrom52WeekHigh: number | null;
  distanceFrom52WeekLow: number | null;
  goldenCross: boolean;
  deathCross: boolean;
  breakout: boolean;
  breakdown: boolean;
  gapPercent: number | null;
  trend: "bullish" | "neutral" | "bearish";
  volatilityRegime: "low" | "normal" | "high";
}

export interface TechnicalScore {
  symbol: string;
  score: number; // 0-100
  breakdown: Record<string, number>;
  horizonQuarters: 1 | 2;
}

// --- Fundamentals (PRD §7.4, §7.5) ----------------------------------------

export interface CompanyFacts {
  symbol: string;
  companyName?: string;
  cik?: string;
  exchange?: string;
  sector?: string;
  industry?: string;
  marketCap?: number;
  sharesOutstanding?: number;
  publicFloat?: number;
  revenue?: number;
  revenueGrowth?: number;
  grossMargin?: number;
  operatingMargin?: number;
  freeCashFlow?: number;
  cashBalance?: number;
  totalDebt?: number;
  runwayMonths?: number;
  shareCountGrowth?: number;
  stockBasedComp?: number;
  goingConcern?: boolean;
  bankrupt?: boolean;
  delisting?: boolean;
  asOf: string;
  source: string;
}

export interface FilingMetadata {
  symbol: string;
  cik: string;
  form: string;
  filedAt: string;
  accessionNumber: string;
  url: string;
}

// --- AI analysis (PRD §8) -------------------------------------------------

export interface ModelDescriptor {
  id: string;
  provider: string;
  displayName?: string;
  contextWindow?: number;
  createdAt?: string;
}

export interface Scenario {
  name: "bull" | "base" | "bear";
  probability: number;
  assumptions: string[];
  expectedCatalysts: string[];
  invalidationConditions: string[];
  estimatedRange?: {
    low: number;
    high: number;
    methodology: string;
  };
}

export interface StockAnalysis {
  ticker: string;
  companyName: string;
  asOf: string;
  horizonQuarters: 1 | 2;
  thesis: string;
  catalystSummary: string[];
  riskSummary: string[];
  transcriptSignals: TranscriptSignal[];
  contradictions: Contradiction[];
  catalystScore: number;
  managementCredibilityScore: number;
  executionScore: number;
  financialQualityScore: number;
  valuationScore: number;
  marketAttentionScore: number;
  dilutionRiskScore: number;
  liquidityRiskScore: number;
  overallScore: number;
  confidence: number;
  bullCase: Scenario;
  baseCase: Scenario;
  bearCase: Scenario;
  evidenceIds: string[];
  missingData: string[];
}

export interface AnalysisRequest {
  ticker: string;
  topic: string;
  asOf: string;
  horizonQuarters: 1 | 2;
  model: string;
  /** Deterministic facts the model must ground on (never invents). */
  evidence: EvidenceItem[];
  technical?: TechnicalIndicatorSet;
  technicalScore?: TechnicalScore;
  facts?: CompanyFacts;
  snapshot?: MarketSnapshot;
}

export interface EvidenceItem {
  id: string;
  kind: "transcript" | "market" | "fundamental" | "filing" | "technical";
  ticker: string;
  sourceUrl?: string;
  text: string;
  hash: string;
  observedAt: string;
}

export interface AnalysisResult {
  provider: string;
  model: string;
  promptHash: string;
  inputHash: string;
  analysis: StockAnalysis;
  raw?: unknown;
}

export interface CostEstimate {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number;
}

// --- Ranking (PRD §16) ----------------------------------------------------

export type RiskClassification =
  | "conservative"
  | "speculative"
  | "high-risk speculative";

export interface RankedCandidate {
  rank: number;
  ticker: string;
  companyName: string;
  lastPrice?: number;
  priceTimestamp?: string;
  bidAskSpreadPercent?: number;
  marketCap?: number;
  avgVolume?: number;
  float?: number;
  overallScore: number;
  confidence: number;
  classification: RiskClassification;
  thesis: string;
  primaryCatalyst?: string;
  catalystWindow?: string;
  independentConfirmation?: string;
  mainRisk?: string;
  analysis: StockAnalysis;
  technicalScore?: TechnicalScore;
  provider: string;
  model: string;
  analyzedAt: string;
}
