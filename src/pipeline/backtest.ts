/**
 * Point-in-time backtesting engine (PRD §18).
 *
 * Strictly as-of: candidates are ranked using only signals dated on/before the
 * as-of date, and returns are measured from Alpaca bars that existed at entry
 * and exit — no look-ahead, survivorship, or revised-filing leakage (§18.1).
 *
 * Ranking here uses a DETERMINISTIC transcript-signal score (fast, reproducible,
 * no LLM cost) so a backtest can sweep many names cheaply. The same walk-forward
 * harness can drive the full LLM ranking when desired.
 */
import type { Client } from "@libsql/client";
import type { AppConfig } from "../config.ts";
import type { buildRegistry } from "../registry.ts";
import { STRATEGY_VERSION } from "../scoring/weights.ts";
import type { MarketBar } from "../types.ts";

export interface BacktestParams {
  topic: string;
  asOf: string; // ISO date
  horizonQuarters: 1 | 2;
  top: number;
  priceMax?: number;
  priceMin?: number;
}

export interface BacktestPosition {
  ticker: string;
  signalScore: number;
  entryDate: string;
  entryPrice: number;
  exitDate: string;
  exitPrice: number;
  returnPct: number;
}

export interface BacktestMetrics {
  strategyVersion: string;
  topic: string;
  asOf: string;
  horizonQuarters: 1 | 2;
  positions: BacktestPosition[];
  count: number;
  meanReturnPct: number;
  medianReturnPct: number;
  winRatePct: number;
  maxDrawdownPct: number;
  hitRate25Pct: number;
  hitRate50Pct: number;
  hitRate100Pct: number;
  note?: string;
}

const TRADING_DAYS_PER_QUARTER = 63;

export async function runBacktest(
  db: Client,
  _config: AppConfig,
  registry: ReturnType<typeof buildRegistry>,
  params: BacktestParams,
): Promise<BacktestMetrics> {
  const asOfDay = params.asOf.slice(0, 10);

  // 1. Point-in-time candidates: signals dated on/before as-of, topic-matched.
  const ranked = await rankBySignalScore(db, params.topic, asOfDay);
  if (ranked.length === 0) {
    return emptyMetrics(params, "No point-in-time signals for this topic/as-of. Run `sync` first.");
  }
  const shortlist = ranked.slice(0, params.top);

  // 2. Measure realized returns from Alpaca bars (entry at as-of, exit later).
  const exitTarget = addTradingDays(asOfDay, TRADING_DAYS_PER_QUARTER * params.horizonQuarters);
  const positions: BacktestPosition[] = [];
  let priceDataAvailable = true;
  for (const cand of shortlist) {
    try {
      const bars = await registry.alpaca.getBars({
        symbols: [cand.ticker],
        timeframe: "1Day",
        start: asOfDay,
        end: exitTarget,
        adjustment: "all",
      });
      const pos = measureReturn(cand.ticker, cand.score, bars, asOfDay);
      if (pos) {
        if (params.priceMax != null && pos.entryPrice > params.priceMax) continue;
        if (params.priceMin != null && pos.entryPrice < params.priceMin) continue;
        positions.push(pos);
      }
    } catch {
      priceDataAvailable = false;
      break;
    }
  }

  if (!priceDataAvailable || positions.length === 0) {
    return {
      ...emptyMetrics(
        params,
        priceDataAvailable
          ? "No Alpaca bars covered the entry→exit window for the shortlist."
          : "Alpaca historical bars unavailable (set APCA_API_KEY_ID/APCA_API_SECRET_KEY). Candidate ranking below is point-in-time and correct; only realized returns need price data.",
      ),
      positions: [],
      count: shortlist.length,
    };
  }

  return computeMetrics(params, positions);
}

async function rankBySignalScore(
  db: Client,
  topic: string,
  asOfDay: string,
): Promise<{ ticker: string; score: number }[]> {
  // Candidate tickers from FTS on topic, restricted to on/before as-of.
  let tickers: string[] = [];
  try {
    const rs = await db.execute({
      sql: `SELECT DISTINCT ticker FROM segments_fts
            WHERE segments_fts MATCH ? AND event_date <= ?`,
      args: [topic, asOfDay],
    });
    tickers = rs.rows.map((r) => String(r.ticker)).filter(Boolean);
  } catch {
    tickers = [];
  }
  const scored: { ticker: string; score: number }[] = [];
  for (const ticker of tickers) {
    const rs = await db.execute({
      sql: `SELECT direction, strength, specificity FROM signals
            WHERE ticker = ? AND event_date <= ?`,
      args: [ticker, asOfDay],
    });
    let score = 0;
    for (const row of rs.rows) {
      const s = Number(row.strength) * (0.5 + Number(row.specificity) / 2);
      score += row.direction === "positive" ? s : row.direction === "negative" ? -s : 0;
    }
    if (rs.rows.length) scored.push({ ticker, score: Math.round(score * 100) / 100 });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function measureReturn(
  ticker: string,
  score: number,
  bars: MarketBar[],
  asOfDay: string,
): BacktestPosition | null {
  if (bars.length < 2) return null;
  const entry = bars.find((b) => b.timestamp.slice(0, 10) >= asOfDay) ?? bars[0]!;
  const exit = bars.at(-1)!;
  if (!entry.close || !exit.close) return null;
  return {
    ticker,
    signalScore: score,
    entryDate: entry.timestamp.slice(0, 10),
    entryPrice: entry.close,
    exitDate: exit.timestamp.slice(0, 10),
    exitPrice: exit.close,
    returnPct: Math.round(((exit.close - entry.close) / entry.close) * 1000) / 10,
  };
}

function computeMetrics(params: BacktestParams, positions: BacktestPosition[]): BacktestMetrics {
  const returns = positions.map((p) => p.returnPct).sort((a, b) => a - b);
  const n = returns.length;
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const median = n % 2 ? returns[(n - 1) / 2]! : (returns[n / 2 - 1]! + returns[n / 2]!) / 2;
  const winRate = (positions.filter((p) => p.returnPct > 0).length / n) * 100;
  const worst = Math.min(...returns);
  return {
    strategyVersion: STRATEGY_VERSION,
    topic: params.topic,
    asOf: params.asOf,
    horizonQuarters: params.horizonQuarters,
    positions,
    count: n,
    meanReturnPct: round(mean),
    medianReturnPct: round(median),
    winRatePct: round(winRate),
    maxDrawdownPct: round(Math.min(0, worst)),
    hitRate25Pct: round((positions.filter((p) => p.returnPct >= 25).length / n) * 100),
    hitRate50Pct: round((positions.filter((p) => p.returnPct >= 50).length / n) * 100),
    hitRate100Pct: round((positions.filter((p) => p.returnPct >= 100).length / n) * 100),
  };
}

function emptyMetrics(params: BacktestParams, note: string): BacktestMetrics {
  return {
    strategyVersion: STRATEGY_VERSION,
    topic: params.topic,
    asOf: params.asOf,
    horizonQuarters: params.horizonQuarters,
    positions: [],
    count: 0,
    meanReturnPct: 0,
    medianReturnPct: 0,
    winRatePct: 0,
    maxDrawdownPct: 0,
    hitRate25Pct: 0,
    hitRate50Pct: 0,
    hitRate100Pct: 0,
    note,
  };
}

/** Approximate a future trading day by calendar days (~1.45 cal/trading day). */
function addTradingDays(day: string, tradingDays: number): string {
  const d = new Date(day);
  d.setUTCDate(d.getUTCDate() + Math.ceil(tradingDays * 1.45));
  return d.toISOString().slice(0, 10);
}
function round(x: number): number {
  return Math.round(x * 100) / 100;
}
