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
  IndicatorConfig,
  RankedCandidate,
} from "../types.ts";

export interface AnalyzeOptions {
  topic: string;
  asOf: string;
  from?: string;
  to?: string;
  horizonQuarters: 1 | 2;
  provider: string;
  model: string;
  criteria: ScreenCriteria;
  persist?: boolean;
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

  // 1. Deterministic market data.
  const barsReq: BarsRequest = {
    symbols: [ticker],
    timeframe: "1Day",
    start: dateOnly(sub(opts.asOf, config.technical.lookbackDays)),
    end: dateOnly(opts.asOf),
    adjustment: config.alpaca.adjustment,
    feed: config.alpaca.feed,
  };
  const bars = await registry.alpaca.getBars(barsReq);
  const [snapshot] = await registry.alpaca.getSnapshots([ticker]);
  const [asset] = await registry.alpaca.getAssets([ticker]);
  const facts = await registry.fundamentals.getCompanyFacts(ticker, opts.asOf);

  const technical = bars.length ? calculateIndicators(bars, icfg) : undefined;
  const technicalScore =
    technical ? scoreTechnicalSetup(technical, opts.horizonQuarters) : undefined;

  // 2. Deterministic filters — before any LLM cost.
  const candidate: Candidate = { symbol: ticker, asset, snapshot, facts, technical };
  const filter = applyFilters(candidate, opts.criteria);
  if (!filter.passed) {
    return { ticker, filtered: true, filterReasons: filter.reasons };
  }

  // 3. Evidence assembly.
  const evidence = await buildEvidence(db, ticker, {
    from: opts.from,
    to: opts.to,
    snapshot,
    facts,
    technical,
  });

  // 4. LLM interpretation (grounded, structured, validated).
  const ai = getAiProvider(registry, opts.provider);
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

  // 5. Deterministic composite score.
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

  if (opts.persist) {
    await persistAnalysis(db, ticker, opts, result, composite.overall, composite.confidence);
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
): Promise<void> {
  const id = `${ticker}:${opts.asOf}:${result.inputHash.slice(0, 8)}`;
  await db.execute({
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
      new Date().toISOString(),
    ],
  });
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
