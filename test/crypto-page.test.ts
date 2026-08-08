/**
 * Crypto pages and the crypto analysis.
 *
 * The pages exist because a modal is not shareable: the URL never changes, so
 * there is nothing to paste, crawl, or preview. So the assertions here are
 * mostly about a link resolving to real content without JavaScript.
 *
 * The analysis is separate from the equity analyzer on purpose, and the tests
 * that matter most are the negative ones: it must not invent numbers, and it
 * must say plainly what it structurally cannot see.
 */
import { describe, expect, test } from "bun:test";
import { analyzeCrypto } from "../src/crypto/analysis.ts";
import { cryptoMoney, renderCryptoPage, renderMissingCryptoPage } from "../src/crypto/page.ts";
import { getPair } from "../src/crypto/pairs.ts";
import { calculateIndicators, scoreTechnicalSetup } from "../src/technical/indicators.ts";
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

/** `direction: 1` rises monotonically, `-1` falls. */
function bars(symbol: string, n = 300, direction: 1 | -1 = 1): MarketBar[] {
  return Array.from({ length: n }, (_, i) => {
    const close = direction === 1 ? 100 + i : 100 + (n - i);
    return {
      symbol,
      timestamp: new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString(),
      open: close, high: close + 1, low: close - 1, close,
      volume: 1000 + i, vwap: close,
      timeframe: "1Day" as const, adjustment: "raw" as const,
    };
  });
}

const OPTS = { appUrl: "https://advis0r.com" };
const PAIR = getPair("BTC/USD")!;

const indicatorsFor = (dir: 1 | -1 = 1) => calculateIndicators(bars("BTC/USD", 300, dir), INDICATORS);

describe("crypto money formatting", () => {
  test("precision scales with magnitude", () => {
    // A fixed 2dp renders DOGE as "$0.00" — the bug this exists to avoid.
    expect(cryptoMoney(64250.5)).toBe("$64,250.50");
    expect(cryptoMoney(72.95)).toBe("$72.9500");
    expect(cryptoMoney(0.06893)).toBe("$0.06893");
    expect(cryptoMoney(0.00001234)).toBe("$0.00001234");
  });

  test("absent values are a dash, never zero", () => {
    // "$0.00" for a missing price is a claim; "—" is the truth.
    expect(cryptoMoney(null)).toBe("—");
    expect(cryptoMoney(undefined)).toBe("—");
    expect(cryptoMoney("nonsense")).toBe("—");
  });
});

describe("crypto analysis", () => {
  test("returns nothing when there are no indicators", () => {
    // The important negative: no inputs must produce no thesis, not a hedged
    // one assembled from defaults.
    expect(analyzeCrypto("BTC/USD", "Bitcoin", undefined, undefined)).toBeNull();
  });

  test("reads a rising series as constructive", () => {
    const ind = indicatorsFor(1);
    const a = analyzeCrypto("BTC/USD", "Bitcoin", ind, scoreTechnicalSetup(ind, 2))!;
    expect(a.thesis).toContain("Bitcoin");
    expect(a.thesis).toContain("BTC/USD");
    expect(a.supportSummary.join(" ")).toContain("above its");
    expect(a.basedOn).toContain("RSI(14)");
  });

  test("reads a falling series as deteriorating", () => {
    const ind = indicatorsFor(-1);
    const a = analyzeCrypto("BTC/USD", "Bitcoin", ind, scoreTechnicalSetup(ind, 2))!;
    expect(a.riskSummary.join(" ")).toContain("below its");
  });

  test("every number in the output came from the indicators", () => {
    const ind = indicatorsFor(1);
    const a = analyzeCrypto("BTC/USD", "Bitcoin", ind, scoreTechnicalSetup(ind, 2))!;
    const text = [a.thesis, ...a.supportSummary, ...a.riskSummary].join(" ");
    // Any figure quoted must be traceable: RSI is the one repeated verbatim.
    if (ind.rsi14 != null) expect(text).toContain(ind.rsi14.toFixed(1));
    // No placeholder or sentinel values leaked through.
    expect(text).not.toContain("NaN");
    expect(text).not.toContain("undefined");
    expect(text).not.toContain("Infinity");
  });

  test("states what it structurally cannot see", () => {
    const ind = indicatorsFor(1);
    const a = analyzeCrypto("BTC/USD", "Bitcoin", ind, scoreTechnicalSetup(ind, 2))!;
    const gaps = a.missingData.join(" ");
    expect(gaps).toContain("No issuer, filings or executive communications");
    expect(gaps).toContain("Alpaca's US venue only");
    expect(gaps).toContain("on-chain");
    // The thesis itself must not imply fundamental coverage.
    expect(a.thesis).toContain("price behaviour only");
  });
});

describe("crypto page", () => {
  const render = (overrides: Record<string, unknown> = {}) => {
    const ind = indicatorsFor(1);
    return renderCryptoPage(
      {
        pair: PAIR,
        snapshot: {
          symbol: "BTC/USD", base: "BTC", quote: "USD",
          latestTrade: { symbol: "BTC/USD", price: 64250.5, size: 1, timestamp: "2026-08-06T13:00:00Z" },
          latestQuote: {
            symbol: "BTC/USD", bidPrice: 64200, bidSize: 1, askPrice: 64300, askSize: 1,
            timestamp: "2026-08-06T13:00:00Z",
          },
          dailyBar: undefined,
          prevDailyBar: {
            symbol: "BTC/USD", timestamp: "2026-08-05T00:00:00Z", open: 64000, high: 64000,
            low: 64000, close: 64000, volume: 1, timeframe: "1Day", adjustment: "raw",
          },
          feed: "us", delayed: false, fetchedAt: "2026-08-06T13:00:00Z",
        },
        bars: bars("BTC/USD", 60),
        technical: ind,
        technicalScore: scoreTechnicalSetup(ind, 2),
        analysis: analyzeCrypto("BTC/USD", "Bitcoin", ind, scoreTechnicalSetup(ind, 2)),
        caveats: ["Volume is venue-only."],
        fetchedAt: "2026-08-06T13:00:00Z",
        ...overrides,
      } as any,
      OPTS,
    );
  };

  test("renders without JavaScript and is self-describing", () => {
    const page = render();
    expect(page).toContain("<!doctype html>");
    expect(page).not.toContain("<script src=");
    expect(page).toContain(`<link rel="canonical" href="https://advis0r.com/crypto/BTC-USD">`);
    expect(page).toContain('property="og:title"');
    expect(page).toContain("Bitcoin");
  });

  test("carries pricing — the thing the JSON page could not show", () => {
    const page = render();
    expect(page).toContain("$64,250.50"); // last trade
    expect(page).toContain("$64,200.00"); // bid
    expect(page).toContain("$64,300.00"); // ask
    expect(page).toContain("bps"); // spread
    expect(page).toContain("+0.39%"); // change vs previous close
  });

  test("carries the analysis, its caveats and the disclaimer", () => {
    const page = render();
    expect(page).toContain("Analysis");
    expect(page).toContain("technical only");
    expect(page).toContain("What this cannot see");
    expect(page).toContain("Volume is venue-only.");
    expect(page).toContain("circuit breakers");
  });

  test("says why the analysis is absent rather than showing an empty section", () => {
    const page = render({ analysis: null, technical: undefined, technicalScore: undefined, bars: [] });
    expect(page).toContain("Analysis");
    expect(page).toContain("Not enough price history");
    // And it must not claim a score it does not have.
    expect(page).not.toContain("NaN");
  });

  test("links to its own JSON rather than hiding it", () => {
    expect(render()).toContain('href="/api/crypto/BTC-USD"');
  });

  test("shows multi-period performance, which is what the modal never had", () => {
    const page = render({
      performance: {
        changes: [
          { label: "24h", days: 1, percent: 1.5, from: 63300 },
          { label: "7d", days: 7, percent: -4.25, from: 67000 },
          { label: "1y", days: 365, percent: null, from: null },
        ],
        high52: 124720.32, low52: 58531.14,
        high52At: "2026-01-04", low52At: "2026-06-02",
        volumeQuote: 987654.3, barCount: 120,
      },
    });
    expect(page).toContain("Performance");
    expect(page).toContain("+1.50%");
    expect(page).toContain("-4.25%");
    expect(page).toContain("$124,720.32");
    expect(page).toContain("2026-01-04");
    // A period without enough history says why rather than showing a number.
    expect(page).toContain("less history than it needs");
    // Venue figures must be labelled as such, now that market-wide ones share
    // the page — the two are easy to mistake for each other.
    expect(page).toContain("Alpaca's US venue");
    expect(page).toContain("Supply &amp; valuation");
  });

  test("shows the order book, the other thing only the modal had", () => {
    const page = render({
      orderbook: {
        symbol: "BTC/USD", timestamp: "2026-08-06T13:00:00Z",
        bids: Array.from({ length: 12 }, (_, i) => ({ price: 64200 - i, size: 0.5 })),
        asks: Array.from({ length: 12 }, (_, i) => ({ price: 64300 + i, size: 0.5 })),
      },
    });
    expect(page).toContain("Order book");
    expect(page).toContain("$64,200.00");
    // Capped at 8 a side, as the modal was.
    expect((page.match(/ob-row bid/g) ?? []).length).toBe(8);
    expect((page.match(/ob-row ask/g) ?? []).length).toBe(8);
    expect(page).toContain("as of page load, not live");
  });

  test("omits the order book entirely when the upstream gave none", () => {
    // An empty two-column grid reads as "no liquidity", which is a claim.
    expect(render({ orderbook: undefined })).not.toContain("Order book");
  });

  test("shows market cap and supply, attributed to its own source", () => {
    const page = render({
      fundamentals: {
        base: "BTC", coingeckoId: "bitcoin",
        marketCap: 1_292_252_659_205, marketCapRank: 1,
        fullyDilutedValuation: 1_292_252_659_205,
        circulatingSupply: 20_066_703, totalSupply: 20_066_721, maxSupply: 21_000_000,
        ath: 126_080, athDate: "2025-10-06T10:57:42.000Z", athChangePercent: -48.92,
        volume24h: 18_396_856_097, lastUpdated: "2026-08-06T13:00:00.000Z",
      },
    });
    expect(page).toContain("Supply &amp; valuation");
    expect(page).toContain("$1.29T"); // market cap
    expect(page).toContain("#1"); // rank
    expect(page).toContain("20.07M BTC"); // circulating supply
    expect(page).toContain("21.00M BTC"); // max supply
    expect(page).toContain("$126,080.00"); // ATH
    expect(page).toContain("2025-10-06");
    expect(page).toContain("-48.92%");
    // Provenance: the reader must never have to guess which vendor a number
    // came from when two are on one page.
    expect(page).toContain("CoinGecko");
    expect(page).toContain("not comparable");
  });

  test("an uncapped supply says so rather than showing a dash", () => {
    const page = render({
      fundamentals: {
        base: "ETH", coingeckoId: "ethereum", marketCap: 2e11, marketCapRank: 2,
        fullyDilutedValuation: null, circulatingSupply: 1.2e8, totalSupply: 1.2e8,
        maxSupply: null, ath: 4800, athDate: null, athChangePercent: null,
        volume24h: 1e10, lastUpdated: null,
      },
    });
    expect(page).toContain("uncapped");
  });

  test("a migrated token explains itself instead of showing $0.00", () => {
    // The MKR/MATIC case. "$0.00 market cap" would be a false statement.
    const page = render({
      fundamentals: {
        base: "MKR", coingeckoId: "maker", marketCap: null, marketCapRank: null,
        fullyDilutedValuation: null, circulatingSupply: null, totalSupply: null,
        maxSupply: null, ath: null, athDate: null, athChangePercent: null,
        volume24h: null, lastUpdated: "2026-08-06T13:00:00.000Z",
        unavailableReason: "the upstream reports no circulating supply for this asset, which usually means it has migrated to a successor token",
      },
    });
    expect(page).toContain("Supply &amp; valuation");
    expect(page).toContain("migrated to a successor token");
    expect(page).not.toContain("$0.00");
    expect(page).not.toContain("$NaN");
  });

  test("an unreachable source says so rather than implying zero", () => {
    const page = render({ fundamentals: null });
    expect(page).toContain("Supply &amp; valuation");
    expect(page).toContain("could not be reached");
    expect(page).toContain("Nothing is estimated");
  });

  test("no longer points at the in-app modal", () => {
    // That link led to a second, weaker view of the same pair.
    expect(render()).not.toContain("/?pair=");
  });

  test("a market failure degrades the page instead of replacing it", () => {
    const page = render({ marketError: "alpaca timeout" });
    expect(page).toContain("alpaca timeout");
    // The rest of the page is still there.
    expect(page).toContain("Technical");
  });
});

describe("missing crypto page", () => {
  test("suggests the pair the visitor probably meant", () => {
    const page = renderMissingCryptoPage("bitcoin", getPair("BTC/USD"), OPTS);
    expect(page).toContain("Did you mean");
    expect(page).toContain('href="/crypto/BTC-USD"');
    // A 404 must never be indexed as real content.
    expect(page).toContain('name="robots" content="noindex"');
  });

  test("still helps when there is nothing to suggest", () => {
    const page = renderMissingCryptoPage("zzzz", undefined, OPTS);
    expect(page).not.toContain("Did you mean");
    expect(page).toContain("/api/crypto/assets");
  });
});
