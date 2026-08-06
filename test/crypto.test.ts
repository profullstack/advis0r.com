/**
 * Crypto API.
 *
 * Two things are worth guarding here. First the symbol grammar: Alpaca writes
 * "BTC/USD", a slash is hostile in a URL path, and people type "bitcoin",
 * "btc" and "BTCUSD" — every one of those has to land on the same pair, and
 * anything Alpaca does not serve has to be rejected rather than forwarded
 * upstream to 404 there. Second the route surface: /crypto/** and
 * /api/crypto/** must be the same API, /crypto/BTC-USD must not be shadowed by
 * a named route, and a dead upstream must read as 502 rather than 500.
 *
 * The client is faked throughout — these tests never touch the network.
 */
import { describe, expect, test } from "bun:test";
import { handleCryptoRoute, resetAssetsCache } from "../src/crypto/routes.ts";
import {
  DEFAULT_QUOTE,
  SUPPORTED_PAIRS,
  getPair,
  lookupPairs,
  normalizePair,
  normalizePairs,
} from "../src/crypto/pairs.ts";
import type { AlpacaCryptoClient } from "../src/crypto/client.ts";
import type { IndicatorConfig, MarketBar } from "../src/types.ts";

const INDICATORS: IndicatorConfig = {
  movingAverages: [20, 50, 200],
  emaPeriods: [12, 26],
  rsiPeriod: 14,
  macd: { fast: 12, slow: 26, signal: 9 },
  bollinger: { period: 20, stdDev: 2 },
  atrPeriod: 14,
  relativeVolumePeriod: 20,
};

/** Deterministic upward series, enough history for every indicator. */
function fakeBars(symbol: string, n = 300): MarketBar[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol,
    timestamp: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString(),
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1000 + i,
    vwap: 100 + i,
    timeframe: "1Day" as const,
    adjustment: "raw" as const,
  }));
}

function fakeClient(overrides: Partial<AlpacaCryptoClient> = {}): AlpacaCryptoClient {
  return {
    authenticated: false,
    getSnapshots: async (symbols: string[]) =>
      symbols.map((symbol) => ({
        symbol,
        base: symbol.split("/")[0]!,
        quote: symbol.split("/")[1]!,
        latestTrade: { symbol, price: 110, size: 1, timestamp: "2026-08-06T00:00:00Z" },
        latestQuote: {
          symbol, bidPrice: 109, bidSize: 1, askPrice: 111, askSize: 1,
          timestamp: "2026-08-06T00:00:00Z",
        },
        dailyBar: undefined,
        prevDailyBar: {
          symbol, timestamp: "2026-08-05T00:00:00Z", open: 100, high: 100, low: 100,
          close: 100, volume: 1, timeframe: "1Day" as const, adjustment: "raw" as const,
        },
        feed: "us" as const,
        delayed: false as const,
        fetchedAt: "2026-08-06T00:00:00Z",
      })),
    getLatestTrades: async (symbols: string[]) =>
      symbols.map((symbol) => ({ symbol, price: 110, size: 1, timestamp: "2026-08-06T00:00:00Z" })),
    getLatestQuotes: async (symbols: string[]) =>
      symbols.map((symbol) => ({
        symbol, bidPrice: 109, bidSize: 1, askPrice: 111, askSize: 1,
        timestamp: "2026-08-06T00:00:00Z",
      })),
    getOrderbooks: async (symbols: string[]) =>
      symbols.map((symbol) => ({
        symbol,
        timestamp: "2026-08-06T00:00:00Z",
        bids: Array.from({ length: 30 }, (_, i) => ({ price: 109 - i, size: 1 })),
        asks: Array.from({ length: 30 }, (_, i) => ({ price: 111 + i, size: 1 })),
      })),
    getBars: async ({ symbols }: { symbols: string[] }) => symbols.flatMap((s) => fakeBars(s)),
    ...overrides,
  } as unknown as AlpacaCryptoClient;
}

const get = (path: string, client = fakeClient()) =>
  handleCryptoRoute(new Request(`https://advis0r.com${path}`), path.split("?")[0]!, {
    client,
    indicators: INDICATORS,
  });

async function body(res: Response | null): Promise<any> {
  expect(res).not.toBeNull();
  return JSON.parse(await res!.text());
}

describe("pair normalization", () => {
  test("accepts every spelling a person actually types", () => {
    for (const input of ["BTC/USD", "btc-usd", "btc_usd", "BTCUSD", "btc", " BTC ", "Btc/Usd"]) {
      expect(normalizePair(input)).toBe("BTC/USD");
    }
  });

  test("a bare asset defaults to its USD pair", () => {
    expect(normalizePair("ETH")).toBe(`ETH/${DEFAULT_QUOTE}`);
    expect(normalizePair("DOGE")).toBe("DOGE/USD");
  });

  test("the longest quote wins, so BTCUSDT is not BTCUSD plus a stray T", () => {
    expect(normalizePair("BTCUSDT")).toBe("BTC/USDT");
    expect(normalizePair("ETHUSDC")).toBe("ETH/USDC");
    expect(normalizePair("ETHBTC")).toBe("ETH/BTC");
  });

  test("cross pairs survive the round trip", () => {
    expect(normalizePair("ETH-BTC")).toBe("ETH/BTC");
    expect(normalizePair("LTC/BTC")).toBe("LTC/BTC");
  });

  test("rejects anything Alpaca does not serve rather than forwarding it", () => {
    // ADA trades against USD only; SUI is not listed at all.
    expect(normalizePair("ADA/BTC")).toBeNull();
    expect(normalizePair("SUI")).toBeNull();
    expect(normalizePair("SUI/USD")).toBeNull();
    expect(normalizePair("NVDA")).toBeNull();
    expect(normalizePair("")).toBeNull();
    expect(normalizePair(null)).toBeNull();
    expect(normalizePair("BTC/USD/EXTRA")).toBeNull();
  });

  test("basket parsing de-dupes, preserves order, and reports rejects", () => {
    const { pairs, rejected } = normalizePairs("btc, ETH-USD ,BTCUSD, doge, nope");
    expect(pairs).toEqual(["BTC/USD", "ETH/USD", "DOGE/USD"]);
    expect(rejected).toEqual(["nope"]);
  });

  test("every directory entry normalizes back to itself", () => {
    for (const p of SUPPORTED_PAIRS) {
      expect(normalizePair(p.symbol)).toBe(p.symbol);
      expect(normalizePair(p.slug)).toBe(p.symbol);
      expect(getPair(p.symbol)?.name).toBe(p.name);
    }
  });
});

describe("pair lookup", () => {
  test("a name resolves to the USD pair first", () => {
    expect(lookupPairs("bitcoin")[0]!.symbol).toBe("BTC/USD");
    expect(lookupPairs("ethereum")[0]!.symbol).toBe("ETH/USD");
    expect(lookupPairs("solana")[0]!.symbol).toBe("SOL/USD");
    expect(lookupPairs("dogecoin")[0]!.symbol).toBe("DOGE/USD");
  });

  test("partial names and tickers both work", () => {
    expect(lookupPairs("bitc")[0]!.symbol).toBe("BTC/USD");
    expect(lookupPairs("eth")[0]!.symbol).toBe("ETH/USD");
  });

  test("a miss is empty, not a wrong guess", () => {
    expect(lookupPairs("rivian")).toEqual([]);
    expect(lookupPairs("")).toEqual([]);
  });
});

describe("route dispatch", () => {
  test("non-crypto paths fall through", async () => {
    expect(await get("/api/ticker")).toBeNull();
    expect(await get("/cryptography")).toBeNull();
    // Deeper than one segment is not ours.
    expect(await get("/crypto/BTC-USD/extra")).toBeNull();
  });

  test("/crypto and /api/crypto are the same surface", async () => {
    const a = await body(await get("/crypto"));
    const b = await body(await get("/api/crypto"));
    expect(a).toEqual(b);
    expect(a.endpoints["GET /crypto/assets"]).toBeTruthy();
  });

  test("a pair path is not shadowed by the named routes", async () => {
    const report = await body(await get("/crypto/BTC-USD"));
    expect(report.symbol).toBe("BTC/USD");
    expect(report.name).toBe("Bitcoin");
    expect(report.technicalScore).toBeTruthy();
    // "bars" is reserved, so it stays the bars endpoint.
    const bars = await body(await get("/crypto/bars?symbol=BTC/USD"));
    expect(bars.timeframe).toBe("1Day");
  });

  test("writes are refused", async () => {
    const res = await handleCryptoRoute(
      new Request("https://advis0r.com/crypto/assets", { method: "POST" }),
      "/crypto/assets",
      { client: fakeClient(), indicators: INDICATORS },
    );
    expect(res!.status).toBe(405);
  });
});

describe("data routes", () => {
  test("assets marks each pair live from a real probe", async () => {
    resetAssetsCache();
    const res = await body(await get("/crypto/assets"));
    expect(res.count).toBe(SUPPORTED_PAIRS.length);
    expect(res.liveness).toBe("verified");
    expect(res.assets.every((a: any) => a.status === "live")).toBe(true);
  });

  test("assets degrades honestly when the probe fails", async () => {
    resetAssetsCache();
    const client = fakeClient({
      getLatestTrades: async () => {
        throw new Error("upstream down");
      },
    } as any);
    const res = await body(await get("/crypto/assets", client));
    expect(res.liveness).toBe("unverified");
    // Not "idle" — we do not know, and saying idle would be a false delisting.
    expect(res.assets.every((a: any) => a.status === "unknown")).toBe(true);
  });

  test("a partly-valid basket succeeds but names what it dropped", async () => {
    // Silent truncation is the trap: two of three symbols coming back reads as
    // "no data for the third" when the truth is "we did not accept it".
    const res = await body(await get("/crypto/snapshot?symbols=BTC/USD,ethereum-usd,SOL"));
    expect(res.snapshots.map((s: any) => s.symbol)).toEqual(["BTC/USD", "SOL/USD"]);
    expect(res.rejected).toEqual(["ethereum-usd"]);
    expect(res.rejectedNote).toContain("ethereum-usd");
  });

  test("a fully-valid basket carries no reject noise", async () => {
    const res = await body(await get("/crypto/snapshot?symbols=BTC/USD,ETH/USD"));
    expect(res.rejected).toBeUndefined();
    expect(res.rejectedNote).toBeUndefined();
  });

  test("snapshot reports change against the previous close", async () => {
    const res = await body(await get("/crypto/snapshot?symbols=BTC/USD,ETH/USD"));
    expect(res.snapshots).toHaveLength(2);
    expect(res.snapshots[0].change).toEqual({ absolute: 10, percent: 10 });
    expect(res.snapshots[0].name).toBe("Bitcoin");
  });

  test("quote reports the spread in basis points", async () => {
    const res = await body(await get("/crypto/quote?symbol=BTC/USD"));
    const q = res.quotes[0];
    expect(q.spread).toBe(2);
    expect(q.mid).toBe(110);
    // 2 / 110 * 10_000
    expect(q.spreadBps).toBeCloseTo(181.82, 1);
  });

  test("orderbook honours the depth cap", async () => {
    const res = await body(await get("/crypto/orderbook?symbol=BTC/USD&depth=5"));
    expect(res.orderbooks[0].bids).toHaveLength(5);
    expect(res.orderbooks[0].asks).toHaveLength(5);
  });

  test("technicals are computed locally from bars", async () => {
    const res = await body(await get("/crypto/technicals?symbol=btc"));
    expect(res.symbol).toBe("BTC/USD");
    expect(res.indicators.rsi14).toBeGreaterThan(50); // monotonic rise
    expect(res.indicators.sma[20]).toBeGreaterThan(0);
    expect(res.score.horizonQuarters).toBe(2);
    expect(res.score.score).toBeGreaterThan(0);
  });

  test("the score carries its crypto caveats", async () => {
    // The scoring engine is shared with equities; the liquidity component reads
    // low purely because Alpaca reports its own venue's volume. Publishing the
    // number without that note invites it to be read as illiquidity.
    const res = await body(await get("/crypto/technicals?symbol=BTC/USD"));
    expect(res.caveats.join(" ")).toContain("Alpaca's US crypto venue alone");
    const report = await body(await get("/crypto/BTC-USD"));
    expect(report.caveats).toBeTruthy();
  });

  test("horizon=1 is honoured", async () => {
    const res = await body(await get("/crypto/technicals?symbol=btc&horizon=1"));
    expect(res.score.horizonQuarters).toBe(1);
  });

  test("thin history says so instead of emitting empty indicators", async () => {
    const client = fakeClient({ getBars: async () => [] } as any);
    const res = await body(await get("/crypto/technicals?symbol=BTC/USD", client));
    expect(res.error).toContain("not enough history");
  });
});

describe("errors", () => {
  test("an unsupported pair 400s with a suggestion", async () => {
    const res = await get("/crypto/quote?symbol=bitcoin");
    expect(res!.status).toBe(400);
    const b = await body(res);
    expect(b.error).toContain("unsupported pair");
    // "bitcoin" is a name, not a pair — the error has to point at BTC/USD.
    expect(b.didYouMean.symbol).toBe("BTC/USD");
  });

  test("the single-symbol report route also suggests", async () => {
    const res = await get("/crypto/technicals?symbol=ethereum");
    expect(res!.status).toBe(400);
    const b = await body(res);
    expect(b.didYouMean.symbol).toBe("ETH/USD");
  });

  test("a missing symbol 400s and points at the directory", async () => {
    const res = await get("/crypto/quote");
    expect(res!.status).toBe(400);
    const b = await body(res);
    expect(b.assets).toBe("/crypto/assets");
  });

  test("an oversized basket is refused before any upstream call", async () => {
    const symbols = SUPPORTED_PAIRS.slice(0, 25).map((p) => p.slug).join(",");
    let called = false;
    const client = fakeClient({
      getSnapshots: async () => {
        called = true;
        return [];
      },
    } as any);
    const res = await get(`/crypto/snapshot?symbols=${symbols}`, client);
    expect(res!.status).toBe(400);
    expect(called).toBe(false);
  });

  test("an invalid timeframe lists the valid ones", async () => {
    const res = await get("/crypto/bars?symbol=BTC/USD&timeframe=1Year");
    expect(res!.status).toBe(400);
    const b = await body(res);
    expect(b.valid).toContain("1Day");
  });

  test("a dead upstream is 502, not 500", async () => {
    const client = fakeClient({
      getSnapshots: async () => {
        throw new Error("alpaca is down");
      },
    } as any);
    const res = await get("/crypto/snapshot?symbols=BTC/USD", client);
    expect(res!.status).toBe(502);
    const b = await body(res);
    expect(b.detail).toContain("alpaca is down");
  });
});

describe("compliance", () => {
  test("every data response carries the crypto disclaimer", async () => {
    for (const path of [
      "/crypto",
      "/crypto/assets",
      "/crypto/snapshot?symbols=BTC/USD",
      "/crypto/quote?symbol=BTC/USD",
      "/crypto/bars?symbol=BTC/USD",
      "/crypto/orderbook?symbol=BTC/USD",
      "/crypto/technicals?symbol=BTC/USD",
      "/crypto/BTC-USD",
    ]) {
      const b = await body(await get(path));
      expect(b.disclaimer).toContain("not a guarantee");
    }
  });
});
