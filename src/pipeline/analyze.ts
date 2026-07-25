/**
 * Single-ticker analysis pipeline (PRD §21).
 *
 * Deterministic data first (Alpaca bars -> local indicators -> technical score,
 * snapshot, SEC fundamentals, filters), THEN evidence assembly, THEN the LLM.
 * The model only interprets — it never sources facts (PRD §8.4).
 */
import type { Client } from "@libsql/client";
import type { AppConfig } from "../config.ts";
import type { buildRegistry } from "../registry.ts";
import { getAiProvider } from "../registry.ts";
import { calculateIndicators, scoreTechnicalSetup } from "../technical/indicators.ts";
import { buildEvidence } from "../evidence/builder.ts";
import { composeScore, classifyRisk } from "../scoring/score.ts";
import { applyFilters, type ScreenCriteria, type Candidate } from "../screen/filters.ts";
import { STRATEGY_VERSION } from "../scoring/weights.ts";
import type {
  BarsRequest,
  EvidenceItem,
  IndicatorConfig,
  RankedCandidate,
} from "../types.ts";

/**
 * Stage callback for the interactive path (PRD v3 §4.x).
 *
 * The UI previously showed an untimed spinner while this pipeline ran, so a
 * slow or failing stage was indistinguishable from a hang. Every stage now
 * reports as it starts and finishes.
 */
export type AnalyzeStage =
  | "market_data"
  | "fundamentals"
  | "filters"
  | "evidence"
  | "model"
  | "scoring"
  | "persist";

export interface AnalyzeProgress {
  stage: AnalyzeStage;
  message: string;
  elapsedMs: number;
  done?: boolean;
}

export interface AnalyzeOptions {
  /** Receives a stage update as each step starts/completes. */
  onProgress?: (p: AnalyzeProgress) => void;
  topic: string;
  asOf: string;
  from?: string;
  to?: string;
  horizonQuarters: 1 | 2;
  provider: string;
  model: string;
  criteria: ScreenCriteria;
  persist?: boolean;
  /** When true, a ticker with no Alpaca market data is excluded instead of degraded. */
  requireMarketData?: boolean;
}

/** Drop price/liquidity/technical filters (used when market data is absent). */
function stripMarketCriteria(c: ScreenCriteria): ScreenCriteria {
  return {
    exchanges: c.exchanges,
    excludeOtc: c.excludeOtc,
    excludeBankrupt: c.excludeBankrupt,
    excludeGoingConcern: c.excludeGoingConcern,
    marketCapMin: c.marketCapMin,
    marketCapMax: c.marketCapMax,
  };
}

function indicatorConfig(config: AppConfig): IndicatorConfig {
  const t = config.technical;
  return {
    movingAverages: t.movingAverages,
    emaPeriods: t.emaPeriods,
    rsiPeriod: t.rsiPeriod,
    macd: { fast: t.macdFast, slow: t.macdSlow, signal: t.macdSignal },
    bollinger: { period: t.bollingerPeriod, stdDev: t.bollingerStddev },
    atrPeriod: t.atrPeriod,
    relativeVolumePeriod: t.relativeVolumePeriod,
  };
}

export interface AnalyzeOutcome {
  ticker: string;
  filtered: boolean;
  filterReasons: string[];
  candidate?: RankedCandidate;
}

export async function analyzeTicker(
  db: Client,
  config: AppConfig,
  registry: ReturnType<typeof buildRegistry>,
  ticker: string,
  opts: AnalyzeOptions,
): Promise<AnalyzeOutcome> {
  const icfg = indicatorConfig(config);
  const startedAt = Date.now();
  const report = (stage: AnalyzeStage, message: string, done = false) =>
    opts.onProgress?.({ stage, message, elapsedMs: Date.now() - startedAt, done });

  // 1. Deterministic market data.
  report("market_data", `Fetching market data for ${ticker}`);
  const barsReq: BarsRequest = {
    symbols: [ticker],
    timeframe: "1Day",
    start: dateOnly(sub(opts.asOf, config.technical.lookbackDays)),
    end: dateOnly(opts.asOf),
    adjustment: config.alpaca.adjustment,
    feed: config.alpaca.feed,
  };
  // Market data via Alpaca is optional: when credentials are absent (or the
  // API errors), the pipeline degrades gracefully to transcript + SEC evidence
  // and records the gap in missingData rather than failing (PRD §8.4, §27).
  let bars: Awaited<ReturnType<typeof registry.alpaca.getBars>> = [];
  let snapshot: Awaited<ReturnType<typeof registry.alpaca.getSnapshots>>[number] | undefined;
  let asset: Awaited<ReturnType<typeof registry.alpaca.getAssets>>[number] | undefined;
  let marketDataAvailable = true;
  try {
    bars = await registry.alpaca.getBars(barsReq);
    [snapshot] = await registry.alpaca.getSnapshots([ticker]);
    [asset] = await registry.alpaca.getAssets([ticker]);
  } catch (err) {
    marketDataAvailable = false;
    if (opts.requireMarketData) {
      return { ticker, filtered: true, filterReasons: [`market data unavailable: ${String(err)}`] };
    }
  }
  report(
    "market_data",
    marketDataAvailable ? `Market data ready (${bars.length} bars)` : "Market data unavailable — continuing",
    true,
  );

  report("fundamentals", "Fetching SEC company facts");
  const facts = await registry.fundamentals.getCompanyFacts(ticker, opts.asOf);
  report("fundamentals", `Fundamentals ready (${facts.source})`, true);

  // Derive market cap from SEC shares outstanding × last price when both exist.
  const lastPriceForCap = snapshot?.latestTrade?.price ?? snapshot?.dailyBar?.close;
  if (facts.marketCap == null && facts.sharesOutstanding && lastPriceForCap) {
    facts.marketCap = facts.sharesOutstanding * lastPriceForCap;
  }

  const technical = bars.length ? calculateIndicators(bars, icfg) : undefined;
  const technicalScore =
    technical ? scoreTechnicalSetup(technical, opts.horizonQuarters) : undefined;

  // 2. Deterministic filters — before any LLM cost. Price/liquidity/technical
  // filters are only applied when market data is present; otherwise they are
  // skipped (not silently failed).
  const effectiveCriteria = marketDataAvailable
    ? opts.criteria
    : stripMarketCriteria(opts.criteria);
  const candidate: Candidate = { symbol: ticker, asset, snapshot, facts, technical };
  report("filters", "Applying deterministic screen");
  const filter = applyFilters(candidate, effectiveCriteria);
  if (!filter.passed) {
    report("filters", `Filtered out: ${filter.reasons.join("; ")}`, true);
    return { ticker, filtered: true, filterReasons: filter.reasons };
  }
  report("filters", "Passed screen", true);

  // 3. Evidence assembly.
  report("evidence", "Assembling grounded evidence");
  const evidence = await buildEvidence(db, ticker, {
    from: opts.from,
    to: opts.to,
    snapshot,
    facts,
    technical,
  });

  report(
    "evidence",
    `${evidence.items.length} evidence item(s) from ${evidence.independentSources} weighted source(s)`,
    true,
  );

  // 4. LLM interpretation (grounded, structured, validated).
  const ai = getAiProvider(registry, opts.provider);
  report("model", `Running ${opts.provider} (${opts.model}) — this is the slow step`);
  const result = await ai.analyze({
    ticker,
    topic: opts.topic,
    asOf: opts.asOf,
    horizonQuarters: opts.horizonQuarters,
    model: opts.model,
    evidence: evidence.items,
    technical,
    technicalScore,
    facts,
    snapshot,
  });

  report("model", `${result.provider}:${result.model} returned a validated analysis`, true);

  if (!marketDataAvailable && !result.analysis.missingData.includes("Alpaca market/technical data")) {
    result.analysis.missingData.push("Alpaca market/technical data");
  }

  // 5. Deterministic composite score.
  report("scoring", "Composing deterministic score");
  const composite = composeScore({
    analysis: result.analysis,
    technicalScore: technicalScore?.score,
    independentSources: evidence.independentSources,
    missingDataCount: result.analysis.missingData.length,
  });

  const lastPrice = snapshot?.latestTrade?.price ?? snapshot?.dailyBar?.close;
  const ranked: RankedCandidate = {
    rank: 0,
    ticker,
    companyName: result.analysis.companyName || facts.companyName || ticker,
    lastPrice,
    priceTimestamp: snapshot?.latestTrade?.timestamp,
    bidAskSpreadPercent: spread(snapshot),
    marketCap: facts.marketCap,
    avgVolume: technical?.avgDailyVolume ?? undefined,
    float: facts.publicFloat,
    overallScore: composite.overall,
    confidence: composite.confidence,
    classification: classifyRisk(composite.overall, composite.confidence, lastPrice),
    thesis: result.analysis.thesis,
    primaryCatalyst: result.analysis.catalystSummary[0],
    mainRisk: result.analysis.riskSummary[0],
    independentConfirmation: `${evidence.independentSources} independent source(s)`,
    analysis: result.analysis,
    technicalScore,
    provider: result.provider,
    model: result.model,
    analyzedAt: new Date().toISOString(),
  };

  report("scoring", "Score composed", true);

  if (opts.persist) {
    report("persist", "Saving analysis + evidence");
    await persistAnalysis(
      db,
      ticker,
      opts,
      result,
      composite.overall,
      composite.confidence,
      evidence.items,
    );
    report("persist", "Saved", true);
  }

  return { ticker, filtered: false, filterReasons: [], candidate: ranked };
}

async function persistAnalysis(
  db: Client,
  ticker: string,
  opts: AnalyzeOptions,
  result: Awaited<ReturnType<ReturnType<typeof getAiProvider>["analyze"]>>,
  overall: number,
  confidence: number,
  evidence: EvidenceItem[] = [],
): Promise<void> {
  const id = `${ticker}:${opts.asOf}:${result.inputHash.slice(0, 8)}`;
  const now = new Date().toISOString();

  // The analysis row and the evidence it cited are written together: an
  // analysis whose citations cannot be reproduced does not satisfy the
  // grounding/reproducibility invariants (PRD §8.4, §26, §29.14).
  const statements = [
    {
      sql: `INSERT OR REPLACE INTO analyses
        (id, strategy_version, ticker, topic, as_of, horizon_quarters, provider, model,
         prompt_hash, input_hash, output_json, overall_score, confidence, created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      args: [
        id,
        STRATEGY_VERSION,
        ticker,
        opts.topic,
        opts.asOf,
        opts.horizonQuarters,
        result.provider,
        result.model,
        result.promptHash,
        result.inputHash,
        JSON.stringify(result.analysis),
        overall,
        confidence,
        now,
      ],
    },
    // Replace prior evidence for this analysis id so re-running is idempotent.
    { sql: "DELETE FROM analysis_evidence WHERE analysis_id = ?", args: [id] },
    ...evidence.map((item) => ({
      sql: `INSERT OR REPLACE INTO analysis_evidence
        (id, analysis_id, evidence_id, kind, ticker, source_url, text, hash, observed_at)
        VALUES (?,?,?,?,?,?,?,?,?)`,
      args: [
        `${id}:${item.hash}`,
        id,
        item.id,
        item.kind,
        item.ticker,
        item.sourceUrl ?? null,
        item.text,
        item.hash,
        item.observedAt,
      ],
    })),
  ];
  await db.batch(statements, "write");
}

function spread(snapshot?: { latestQuote?: { bidPrice: number; askPrice: number } }): number | undefined {
  const q = snapshot?.latestQuote;
  if (!q || !q.bidPrice || !q.askPrice) return undefined;
  const mid = (q.bidPrice + q.askPrice) / 2;
  return mid ? ((q.askPrice - q.bidPrice) / mid) * 100 : undefined;
}
function sub(iso: string, days: number): string {
  const d = new Date(iso);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString();
}
function dateOnly(iso: string): string {
  return iso.slice(0, 10);
}
