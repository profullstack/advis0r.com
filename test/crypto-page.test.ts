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
