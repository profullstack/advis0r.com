/**
 * Grid sparklines.
 *
 * The downsampler is the part worth guarding: it must never drop the last
 * point, because the line's endpoint sits directly beside the current price on
 * the card, and a line ending somewhere else reads as the card contradicting
 * itself. The service is the other part — twelve cards must cost one set of
 * upstream requests, not twelve.
 */
import { describe, expect, test } from "bun:test";
import { SparklineService, downsample, toSeries } from "../src/crypto/sparkline.ts";
import type { AlpacaCryptoClient } from "../src/crypto/client.ts";
import type { MarketBar } from "../src/types.ts";

const NOW = Date.parse("2026-08-08T00:00:00Z");

function bars(symbol: string, closes: number[]): MarketBar[] {
  return closes.map((close, i) => ({
    symbol,
    timestamp: new Date(NOW - (closes.length - 1 - i) * 3_600_000).toISOString(),
    open: close, high: close + 1, low: close - 1, close,
    volume: 1, timeframe: "1Hour" as const, adjustment: "raw" as const,
  }));
}

describe("downsample", () => {
  test("keeps a short series untouched", () => {
    expect(downsample([1, 2, 3], 24)).toEqual([1, 2, 3]);
  });

  test("always keeps the first and last point", () => {
    // The last point sits beside the printed price; losing it makes the card
    // disagree with itself.
    const values = Array.from({ length: 168 }, (_, i) => i);
    const out = downsample(values, 56);
    expect(out).toHaveLength(56);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBe(167);
  });

  test("samples evenly across the window", () => {
    const out = downsample([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5);
    expect(out).toEqual([0, 2, 5, 7, 9]);
  });

  test("degenerate limits do not throw", () => {
    expect(downsample([1, 2, 3], 1)).toEqual([3]);
    expect(downsample([1, 2, 3], 0)).toEqual([]);
    expect(downsample([], 10)).toEqual([]);
  });
});

describe("toSeries", () => {
  test("reports the change across the window it actually has", () => {
    const s = toSeries("BTC/USD", bars("BTC/USD", [100, 110]), 24);
    expect(s.changePercent).toBeCloseTo(10, 6);
    expect(s.first).toBe(100);
    expect(s.last).toBe(110);
    expect(s.start).toBeTruthy();
    expect(s.end).toBeTruthy();
  });

  test("a falling window is negative", () => {
    expect(toSeries("X", bars("X", [200, 100]), 24).changePercent).toBeCloseTo(-50, 6);
  });

  test("non-finite closes are dropped rather than poisoning the line", () => {
    const rows = bars("X", [100, 0, 110]);
    (rows[1] as any).close = NaN;
    const s = toSeries("X", rows, 24);
    expect(s.points).toEqual([100, 110]);
    expect(s.points.every(Number.isFinite)).toBe(true);
  });

  test("a zero opening price cannot produce Infinity", () => {
    const s = toSeries("X", bars("X", [0, 50]), 24);
    expect(s.changePercent).toBeNull();
  });
});

describe("service", () => {
  const client = (calls: any[] = []) =>
    ({
      getBars: async (req: any) => {
        calls.push(req);
        return [...bars("BTC/USD", [100, 105, 110]), ...bars("ETH/USD", [50, 49, 48])];
      },
    }) as unknown as AlpacaCryptoClient;

  test("returns a series per requested pair", async () => {
    const svc = new SparklineService(client(), { now: () => NOW });
    const out = await svc.get(["BTC/USD", "ETH/USD"], "24h");
    expect(out.get("BTC/USD")!.points).toEqual([100, 105, 110]);
    expect(out.get("ETH/USD")!.changePercent).toBeCloseTo(-4, 6);
  });

  test("requests hourly bars over the period's window", async () => {
    const calls: any[] = [];
    await new SparklineService(client(calls), { now: () => NOW }).get(["BTC/USD"], "7d");
    expect(calls[0].timeframe).toBe("1Hour");
    const hours = (NOW - Date.parse(calls[0].start)) / 3_600_000;
    expect(hours).toBeCloseTo(24 * 7, 3);
  });

  test("a second call inside the TTL does not hit upstream again", async () => {
    const calls: any[] = [];
    const svc = new SparklineService(client(calls), { now: () => NOW });
    await svc.get(["BTC/USD"], "24h");
    await svc.get(["BTC/USD"], "24h");
    expect(calls).toHaveLength(1);
  });

  test("concurrent loads collapse into one paginated fetch", async () => {
    const calls: any[] = [];
    const svc = new SparklineService(client(calls), { now: () => NOW });
    await Promise.all([svc.get(["BTC/USD"], "24h"), svc.get(["BTC/USD"], "24h")]);
    expect(calls).toHaveLength(1);
  });

  test("the two periods are cached separately", async () => {
    const calls: any[] = [];
    const svc = new SparklineService(client(calls), { now: () => NOW });
    await svc.get(["BTC/USD"], "24h");
    await svc.get(["BTC/USD"], "7d");
    expect(calls).toHaveLength(2);
  });

  test("a pair with a single bar is omitted, not drawn flat", async () => {
    // One observation is not a trend; a flat line would assert a stability we
    // never saw.
    const thin = { getBars: async () => bars("BTC/USD", [100]) } as unknown as AlpacaCryptoClient;
    const out = await new SparklineService(thin, { now: () => NOW }).get(["BTC/USD"], "24h");
    expect(out.has("BTC/USD")).toBe(false);
  });
});
