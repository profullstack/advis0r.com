import { describe, expect, test } from "bun:test";
import {
  sma,
  ema,
  rsi,
  atr,
  momentumPct,
  calculateIndicators,
  scoreTechnicalSetup,
} from "../src/technical/indicators.ts";
import type { IndicatorConfig, MarketBar } from "../src/types.ts";

const cfg: IndicatorConfig = {
  movingAverages: [20, 50, 200],
  emaPeriods: [9, 21],
  rsiPeriod: 14,
  macd: { fast: 12, slow: 26, signal: 9 },
  bollinger: { period: 20, stdDev: 2 },
  atrPeriod: 14,
  relativeVolumePeriod: 20,
};

function makeBars(closes: number[]): MarketBar[] {
  return closes.map((c, i) => ({
    symbol: "TEST",
    timestamp: new Date(Date.UTC(2025, 0, 1 + i)).toISOString(),
    open: c,
    high: c + 1,
    low: c - 1,
    close: c,
    volume: 1_000_000,
    timeframe: "1Day",
    adjustment: "all",
  }));
}

describe("indicators", () => {
  test("sma computes simple mean of last N", () => {
    expect(sma([1, 2, 3, 4, 5], 5)).toBe(3);
    expect(sma([1, 2], 5)).toBeNull();
  });

  test("ema returns a value when enough data", () => {
    const v = ema([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 5);
    expect(v).not.toBeNull();
    expect(v!).toBeGreaterThan(5);
  });

  test("rsi is 100 for a monotonically rising series", () => {
    const values = Array.from({ length: 30 }, (_, i) => i + 1);
    expect(rsi(values, 14)).toBe(100);
  });

  test("atr is positive for a series with range", () => {
    const bars = makeBars(Array.from({ length: 30 }, (_, i) => 100 + i));
    expect(atr(bars, 14)!).toBeGreaterThan(0);
  });

  test("momentum reflects percentage change", () => {
    const values = [100, ...Array(20).fill(0).map((_, i) => 100 + i)];
    const m = momentumPct([100, 110], 1);
    expect(m).toBeCloseTo(10, 5);
    expect(values.length).toBeGreaterThan(0);
  });

  test("calculateIndicators + scoreTechnicalSetup produce a 0-100 score", () => {
    const bars = makeBars(Array.from({ length: 260 }, (_, i) => 10 + i * 0.05));
    const ind = calculateIndicators(bars, cfg);
    expect(ind.trend).toBe("bullish");
    const score = scoreTechnicalSetup(ind, 2);
    expect(score.score).toBeGreaterThanOrEqual(0);
    expect(score.score).toBeLessThanOrEqual(100);
  });
});
