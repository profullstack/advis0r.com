/**
 * Multi-period performance.
 *
 * The interesting cases are all about refusing to answer. A 1-year change
 * computed from four months of bars, or a 24h change measured from the oldest
 * bar available because nothing newer matched, are both fabrications that look
 * exactly like real figures.
 */
import { describe, expect, test } from "bun:test";
import { computePerformance } from "../src/crypto/performance.ts";
import type { MarketBar } from "../src/types.ts";

/** `n` daily bars ending today, closing at `f(i)`. */
function series(n: number, f: (i: number) => number): MarketBar[] {
  const end = Date.UTC(2026, 7, 6);
  return Array.from({ length: n }, (_, i) => {
    const close = f(i);
    return {
      symbol: "BTC/USD",
      timestamp: new Date(end - (n - 1 - i) * 86_400_000).toISOString(),
      open: close, high: close + 1, low: close - 1, close,
      volume: 10, vwap: close,
      timeframe: "1Day" as const, adjustment: "raw" as const,
    };
  });
}

const pick = (p: ReturnType<typeof computePerformance>, label: string) =>
  p.changes.find((c) => c.label === label)!;

describe("period changes", () => {
  test("computes a change against the close that many days back", () => {
    // Flat 100 for a year, then today at 110 => +10% over every window.
    const bars = series(400, (i) => (i === 399 ? 110 : 100));
    const p = computePerformance(bars);
    for (const label of ["24h", "7d", "30d", "90d", "1y"]) {
      expect(pick(p, label).percent).toBeCloseTo(10, 6);
      expect(pick(p, label).from).toBe(100);
    }
  });

  test("a period longer than the history is null, not measured from the oldest bar", () => {
    // 100 days only: "+x% over 1y" would be a claim about time we cannot see.
    const p = computePerformance(series(100, (i) => 100 + i));
    expect(pick(p, "30d").percent).not.toBeNull();
    expect(pick(p, "1y").percent).toBeNull();
    expect(pick(p, "1y").from).toBeNull();
  });

  test("a falling series reports negative changes", () => {
    const p = computePerformance(series(400, (i) => 500 - i));
    expect(pick(p, "24h").percent).toBeLessThan(0);
    expect(pick(p, "1y").percent).toBeLessThan(0);
  });

  test("no bars at all yields nulls rather than zeros", () => {
    // Zero would read as "unchanged", which is a different claim from "unknown".
    const p = computePerformance([]);
    expect(p.barCount).toBe(0);
    expect(p.changes.every((c) => c.percent === null)).toBe(true);
    expect(p.high52).toBeNull();
    expect(p.volumeQuote).toBeNull();
  });

  test("a gap in the feed does not shift the window", () => {
    // Index arithmetic would treat 30 bars back as 30 days; these are 2 apart.
    const end = Date.UTC(2026, 7, 6);
    const bars: MarketBar[] = Array.from({ length: 40 }, (_, i) => {
      const close = 100 + i;
      return {
        symbol: "BTC/USD",
        timestamp: new Date(end - (39 - i) * 2 * 86_400_000).toISOString(),
        open: close, high: close, low: close, close,
        volume: 1, timeframe: "1Day" as const, adjustment: "raw" as const,
      };
    });
    const p = computePerformance(bars);
    // 7 days back is ~3.5 bars, so it must not resolve to 7 bars back (=132).
    expect(pick(p, "7d").from).toBeGreaterThan(132);
  });
});

describe("52-week range and volume", () => {
  test("reports the extremes with the dates they occurred", () => {
    const bars = series(300, (i) => (i === 10 ? 10 : i === 200 ? 900 : 100));
    const p = computePerformance(bars);
    expect(p.high52).toBe(901); // high = close + 1
    expect(p.low52).toBe(9); // low = close - 1
    expect(p.high52At).toBe(bars[200]!.timestamp.slice(0, 10));
    expect(p.low52At).toBe(bars[10]!.timestamp.slice(0, 10));
  });

  test("session volume is converted to the quote currency", () => {
    const p = computePerformance(series(5, () => 200));
    expect(p.volumeQuote).toBe(10 * 200);
  });

  test("the bar count is reported so thin history is visible", () => {
    expect(computePerformance(series(12, () => 100)).barCount).toBe(12);
  });
});
