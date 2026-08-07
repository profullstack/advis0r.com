/**
 * Market cap and supply, from the one non-Alpaca source on the crypto path.
 *
 * The tests that matter most are the refusals. CoinGecko keeps serving records
 * for tokens that have migrated away — MKR to SKY, MATIC to POL — and those
 * records report zero circulating supply and stop updating, while still
 * returning a plausible-looking price. Rendering "$0.00" market cap, or a
 * six-month-old supply figure beside a live price, would be worse than showing
 * nothing.
 *
 * Network is stubbed throughout; these never call CoinGecko.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { CryptoFundamentalsClient, FUNDAMENTALS_ASSETS } from "../src/crypto/fundamentals.ts";

const NOW = Date.parse("2026-08-07T00:00:00Z");

const row = (over: Record<string, unknown> = {}) => ({
  id: "bitcoin", symbol: "btc", name: "Bitcoin",
  current_price: 64399, market_cap: 1_292_252_659_205, market_cap_rank: 1,
  fully_diluted_valuation: 1_292_252_659_205, total_volume: 18_396_856_097,
  circulating_supply: 20_066_703, total_supply: 20_066_721, max_supply: 21_000_000,
  ath: 126_080, ath_change_percentage: -48.92, ath_date: "2025-10-06T10:57:42.000Z",
  last_updated: "2026-08-07T00:00:00.000Z",
  ...over,
});

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Serve `rows` to the next request; records the URLs asked for. */
function stubFetch(rows: unknown[], calls: string[] = []) {
  globalThis.fetch = (async (input: any) => {
    calls.push(String(input));
    return { ok: true, status: 200, json: async () => rows } as any;
  }) as any;
  return calls;
}

const client = (rows: unknown[], calls?: string[]) => {
  stubFetch(rows, calls);
  return new CryptoFundamentalsClient({ now: () => NOW });
};

describe("fetching", () => {
  test("maps a healthy record", async () => {
    const f = (await client([row()]).get("BTC"))!;
    expect(f.marketCap).toBe(1_292_252_659_205);
    expect(f.marketCapRank).toBe(1);
    expect(f.circulatingSupply).toBe(20_066_703);
    expect(f.maxSupply).toBe(21_000_000);
    expect(f.ath).toBe(126_080);
    expect(f.volume24h).toBe(18_396_856_097);
    expect(f.unavailableReason).toBeUndefined();
  });

  test("asks for every asset in one request", async () => {
    const calls: string[] = [];
    await client([row()], calls).get("BTC");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("vs_currency=usd");
    // Explicit ids, never a symbol search — tickers collide across listings.
    expect(calls[0]).toContain("bitcoin");
    expect(calls[0]).toContain("ethereum");
  });

  test("a second lookup is served from cache, not a second request", async () => {
    const calls: string[] = [];
    const c = client([row(), row({ id: "ethereum", symbol: "eth" })], calls);
    await c.get("BTC");
    await c.get("ETH");
    expect(calls).toHaveLength(1);
  });

  test("concurrent misses collapse into one request", async () => {
    // A rate-limited free tier must not be stampeded by parallel page loads.
    const calls: string[] = [];
    const c = client([row()], calls);
    await Promise.all([c.get("BTC"), c.get("BTC"), c.get("BTC")]);
    expect(calls).toHaveLength(1);
  });
});

describe("refusing bad records", () => {
  test("a migrated token reports no supply, so nothing is shown", async () => {
    // This is MKR after the SKY migration: a live-looking price, zero supply.
    const f = (await client([
      row({ id: "maker", symbol: "mkr", current_price: 1272.11, market_cap: 0, circulating_supply: 0 }),
    ]).get("MKR"))!;
    expect(f.marketCap).toBeNull();
    expect(f.circulatingSupply).toBeNull();
    expect(f.unavailableReason).toContain("migrated");
  });

  test("a stale record is rejected even when its numbers look fine", async () => {
    // This is MATIC: last updated six months ago, still returning figures.
    const f = (await client([
      row({
        id: "matic-network", symbol: "matic",
        market_cap: 5_000_000_000, circulating_supply: 9_000_000_000,
        last_updated: "2026-02-03T01:57:00.000Z",
      }),
    ]).get("MATIC"))!;
    expect(f.marketCap).toBeNull();
    expect(f.unavailableReason).toContain("has not updated");
    expect(f.unavailableReason).toContain("185 days");
  });

  test("a fresh record just inside the window is kept", async () => {
    const f = (await client([
      row({ last_updated: new Date(NOW - 6 * 86_400_000).toISOString() }),
    ]).get("BTC"))!;
    expect(f.marketCap).not.toBeNull();
    expect(f.unavailableReason).toBeUndefined();
  });

  test("zero and negative values become null, never rendered figures", async () => {
    const f = (await client([
      row({ market_cap: 0, fully_diluted_valuation: 0, max_supply: null, ath: -1 }),
    ]).get("BTC"))!;
    // circulating_supply is still positive, so the record itself is usable.
    expect(f.unavailableReason).toBeUndefined();
    expect(f.marketCap).toBeNull();
    expect(f.fullyDilutedValuation).toBeNull();
    expect(f.maxSupply).toBeNull();
    expect(f.ath).toBeNull();
  });
});

describe("failure is never fatal", () => {
  test("an upstream error yields null rather than throwing into a page", async () => {
    globalThis.fetch = (async () => ({ ok: false, status: 429, json: async () => ({}) })) as any;
    expect(await new CryptoFundamentalsClient({ now: () => NOW }).get("BTC")).toBeNull();
  });

  test("a network failure yields null", async () => {
    globalThis.fetch = (async () => { throw new Error("offline"); }) as any;
    expect(await new CryptoFundamentalsClient({ now: () => NOW }).get("BTC")).toBeNull();
  });

  test("an asset we do not map yields null without a request", async () => {
    const calls: string[] = [];
    expect(await client([row()], calls).get("NOTACOIN")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  test("an asset missing from the response yields null", async () => {
    expect(await client([row()]).get("SOL")).toBeNull();
  });
});

describe("coverage", () => {
  test("every base asset advis0r lists has a mapping", async () => {
    const { SUPPORTED_PAIRS } = await import("../src/crypto/pairs.ts");
    const bases = [...new Set(SUPPORTED_PAIRS.map((p) => p.base))];
    for (const base of bases) expect(FUNDAMENTALS_ASSETS).toContain(base);
  });
});
