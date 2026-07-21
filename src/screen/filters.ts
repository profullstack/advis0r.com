/**
 * Deterministic filter engine (PRD §9, §12.3). Runs BEFORE any LLM analysis.
 * A low nominal share price NEVER improves a score — filters only include or
 * exclude candidates (PRD §9.1, §14).
 */
import type {
  AlpacaAsset,
  CompanyFacts,
  MarketSnapshot,
  TechnicalIndicatorSet,
} from "../types.ts";

export interface ScreenCriteria {
  priceMin?: number;
  priceMax?: number;
  marketCapMin?: number;
  marketCapMax?: number;
  avgVolumeMin?: number;
  avgDollarVolumeMin?: number;
  maxSpreadPercent?: number;
  floatMin?: number;
  floatMax?: number;

  exchanges?: string[]; // NASDAQ,NYSE,AMEX
  excludeOtc?: boolean;
  excludeBankrupt?: boolean;
  excludeGoingConcern?: boolean;

  // Technical filters (§12.3)
  rsiMin?: number;
  rsiMax?: number;
  aboveSma20?: boolean;
  aboveSma50?: boolean;
  aboveSma200?: boolean;
  goldenCross?: boolean;
  relativeVolumeMin?: number;
  momentum20dMin?: number;
  momentum60dMin?: number;
  trend?: "bullish" | "neutral" | "bearish";
}

export interface Candidate {
  symbol: string;
  asset?: AlpacaAsset;
  snapshot?: MarketSnapshot;
  facts?: CompanyFacts;
  technical?: TechnicalIndicatorSet;
}

export interface FilterResult {
  symbol: string;
  passed: boolean;
  reasons: string[]; // reasons for exclusion (empty when passed)
}

function lastPrice(c: Candidate): number | undefined {
  return c.snapshot?.latestTrade?.price ?? c.snapshot?.dailyBar?.close;
}

function spreadPercent(c: Candidate): number | undefined {
  const q = c.snapshot?.latestQuote;
  if (!q || !q.bidPrice || !q.askPrice) return undefined;
  const mid = (q.bidPrice + q.askPrice) / 2;
  if (!mid) return undefined;
  return ((q.askPrice - q.bidPrice) / mid) * 100;
}

export function applyFilters(c: Candidate, crit: ScreenCriteria): FilterResult {
  const reasons: string[] = [];
  const price = lastPrice(c);

  if (crit.priceMin != null && (price == null || price < crit.priceMin))
    reasons.push(`price < ${crit.priceMin}`);
  if (crit.priceMax != null && (price == null || price > crit.priceMax))
    reasons.push(`price > ${crit.priceMax}`);

  const mcap = c.facts?.marketCap;
  if (crit.marketCapMin != null && mcap != null && mcap < crit.marketCapMin)
    reasons.push(`marketCap < ${crit.marketCapMin}`);
  if (crit.marketCapMax != null && mcap != null && mcap > crit.marketCapMax)
    reasons.push(`marketCap > ${crit.marketCapMax}`);

  const advol = c.technical?.avgDailyVolume;
  if (crit.avgVolumeMin != null && advol != null && advol < crit.avgVolumeMin)
    reasons.push(`avgVolume < ${crit.avgVolumeMin}`);
  const addollar = c.technical?.avgDollarVolume;
  if (crit.avgDollarVolumeMin != null && addollar != null && addollar < crit.avgDollarVolumeMin)
    reasons.push(`avgDollarVolume < ${crit.avgDollarVolumeMin}`);

  const spread = spreadPercent(c);
  if (crit.maxSpreadPercent != null && spread != null && spread > crit.maxSpreadPercent)
    reasons.push(`spread ${spread.toFixed(2)}% > ${crit.maxSpreadPercent}%`);

  const float = c.facts?.publicFloat;
  if (crit.floatMin != null && float != null && float < crit.floatMin)
    reasons.push(`float < ${crit.floatMin}`);
  if (crit.floatMax != null && float != null && float > crit.floatMax)
    reasons.push(`float > ${crit.floatMax}`);

  const exch = c.asset?.exchange?.toUpperCase();
  if (crit.exchanges?.length && exch && !crit.exchanges.map((e) => e.toUpperCase()).includes(exch))
    reasons.push(`exchange ${exch} not in [${crit.exchanges.join(",")}]`);
  if (crit.excludeOtc && exch === "OTC") reasons.push("OTC excluded");
  if (crit.excludeBankrupt && c.facts?.bankrupt) reasons.push("bankrupt excluded");
  if (crit.excludeGoingConcern && c.facts?.goingConcern) reasons.push("going-concern excluded");

  // Technical filters
  const t = c.technical;
  if (t) {
    if (crit.rsiMin != null && t.rsi14 != null && t.rsi14 < crit.rsiMin)
      reasons.push(`RSI ${t.rsi14.toFixed(1)} < ${crit.rsiMin}`);
    if (crit.rsiMax != null && t.rsi14 != null && t.rsi14 > crit.rsiMax)
      reasons.push(`RSI ${t.rsi14.toFixed(1)} > ${crit.rsiMax}`);
    if (crit.aboveSma20 && !(price != null && t.sma[20] != null && price > t.sma[20]!))
      reasons.push("not above SMA20");
    if (crit.aboveSma50 && !(price != null && t.sma[50] != null && price > t.sma[50]!))
      reasons.push("not above SMA50");
    if (crit.aboveSma200 && !(price != null && t.sma[200] != null && price > t.sma[200]!))
      reasons.push("not above SMA200");
    if (crit.goldenCross && !t.goldenCross) reasons.push("no golden cross");
    if (crit.relativeVolumeMin != null && t.relativeVolume != null && t.relativeVolume < crit.relativeVolumeMin)
      reasons.push(`relVol ${t.relativeVolume.toFixed(2)} < ${crit.relativeVolumeMin}`);
    if (crit.momentum20dMin != null && t.momentum[20] != null && t.momentum[20]! < crit.momentum20dMin)
      reasons.push(`mom20 < ${crit.momentum20dMin}`);
    if (crit.momentum60dMin != null && t.momentum[60] != null && t.momentum[60]! < crit.momentum60dMin)
      reasons.push(`mom60 < ${crit.momentum60dMin}`);
    if (crit.trend && t.trend !== crit.trend) reasons.push(`trend ${t.trend} != ${crit.trend}`);
  }

  return { symbol: c.symbol, passed: reasons.length === 0, reasons };
}
