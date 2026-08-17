/**
 * The priced watchlist — /api/watchlist/overview.
 *
 * What is worth locking down here is not the arithmetic so much as the
 * honesty rules around it: a ticker the provider has no bars for must stay on
 * the list and be named as unpriced rather than quietly disappear or borrow a
 * price from its stored report; a period longer than the history available must
 * come back null; and the equal-weight line must leave out a ticker whose
 * history starts inside the window instead of joining it at par and flattening
 * the curve.
 *
 * The upstream cost is asserted too. One fetch for a whole watchlist, reused
 * across viewers, is the difference between this being a page you can leave
 * open and one that spends a request per row per load.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/index.ts";
import { newId } from "../src/auth/crypto.ts";
import { handleWatchlistRoute } from "../src/auth/watchlist.ts";
import { saveReport } from "../src/reports/store.ts";
import {
  BENCHMARK_SYMBOL,
  BarsCache,
  buildWatchlistOverview,
  isRangeKey,
  type SavedItem,
} from "../src/watchlist/overview.ts";
import type { AlpacaMarketDataClient } from "../src/providers/interfaces.ts";
import type { MarketBar } from "../src/types.ts";

const dir = mkdtempSync(join(tmpdir(), "advis0r-wl-overview-"));
let db: Client;

const DAY = 86_400_000;
/** Fixed clock: every window in these tests is measured back from here. */
const NOW = Date.parse("2026-08-17T20:00:00Z");
const now = () => NOW;

/**
 * One bar per calendar day, closing on a straight line from `from` to `to`.
 * A daily series with no weekend gaps is enough for every rule under test and
 * makes each expected number obvious by hand.
 */
function ramp(symbol: string, days: number, from: number, to: number): MarketBar[] {
  return Array.from({ length: days }, (_, i) => {
    const close = Number((from + ((to - from) * i) / (days - 1)).toFixed(4));
    return {
      symbol,
      timestamp: new Date(NOW - (days - 1 - i) * DAY).toISOString(),
      open: close, high: close * 1.01, low: close * 0.99, close,
      volume: 1_000_000 + i,
      timeframe: "1Day" as const,
      adjustment: "all" as const,
    };
  });
}

/** 400 days of history for the majors; SHORT only started ten days ago. */
const SERIES: Record<string, MarketBar[]> = {
  UP: ramp("UP", 400, 50, 100),      // doubles over the full history
  DOWN: ramp("DOWN", 400, 200, 100), // halves
  SHORT: ramp("SHORT", 10, 10, 11),
  [BENCHMARK_SYMBOL]: ramp(BENCHMARK_SYMBOL, 400, 400, 500),
};

/** Counts what the page actually costs upstream. */
class StubMarket implements AlpacaMarketDataClient {
  calls: string[][] = [];
  async getBars(request: { symbols: string[] }): Promise<MarketBar[]> {
    this.calls.push([...request.symbols]);
    return request.symbols.flatMap((s) => SERIES[s] ?? []);
  }
  async getSnapshots() { return []; }
  async getLatestTrades() { return []; }
  async getLatestQuotes() { return []; }
  async getAssets() { return []; }
  async getCalendar() { return []; }
}

/**
 * What a symbol's line should end at, rebased to 100 over `days`.
 *
 * Computed from the same fixture rather than written as a constant: the
 * windows are calendar-based, so "1Y" starts 365 days back into a 400-day
 * series, not at its first bar — hard-coding the endpoint would encode that
 * off-by-35-sessions mistake as the expectation.
 */
function rebased(symbol: string, days: number): number {
  const since = Date.parse(`${new Date(NOW - days * DAY).toISOString().slice(0, 10)}T00:00:00Z`);
  const win = SERIES[symbol]!.filter((b) => Date.parse(b.timestamp) >= since);
  return (win.at(-1)!.close / win[0]!.close) * 100;
}

const saved = (ticker: string, note?: string): SavedItem => ({
  ticker,
  note,
  createdAt: new Date(NOW - 30 * DAY).toISOString(),
});

function build(market: StubMarket, items: SavedItem[], range?: "1M" | "3M" | "6M" | "1Y", cache?: BarsCache) {
  return buildWatchlistOverview(
    { db, market, marketSource: "iex", now },
    items,
    { range, cache: cache ?? new BarsCache(market, 10 * 60_000, now) },
  );
}

beforeAll(async () => {
  db = createClient({ url: `file:${join(dir, "test.sqlite")}` });
  await migrate(db);
  await saveReport(db, "UP", {
    companyName: "Upward Industries",
    lastPrice: 99,
    overallScore: 71,
    confidence: 60,
    classification: "speculative",
    sources: [{}, {}],
    signals: [{}, {}, {}],
  });
  await saveReport(db, "DOWN", {
    companyName: "Downward Corp",
    lastPrice: 101,
    overallScore: 41,
    confidence: 55,
    classification: "high-risk speculative",
    sources: [],
    signals: [{}],
  });
});

afterAll(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("per-row pricing", () => {
  let market: StubMarket;
  let overview: Awaited<ReturnType<typeof build>>;

  beforeEach(async () => {
    market = new StubMarket();
    overview = await build(market, [saved("UP", "from Discover"), saved("DOWN"), saved("NODATA")], "3M");
  });

  test("prices every row from the bars actually fetched", () => {
    const up = overview.items.find((i) => i.ticker === "UP")!;
    expect(up.price).toBe(100);
    expect(up.priceAsOf).toBe(new Date(NOW).toISOString().slice(0, 10));
    expect(up.barCount).toBe(400);
  });

  test("reports the changes for each window", () => {
    const up = overview.items.find((i) => i.ticker === "UP")!;
    const pct = (label: string) => up.changes.find((c) => c.label === label)!.percent!;
    // The ramp gains 50/399 ≈ 0.1253 per session off a base near 100.
    expect(pct("1D")).toBeCloseTo(0.1255, 3);
    expect(pct("1W")).toBeGreaterThan(pct("1D"));
    // A year back into a 400-day ramp, not the start of it.
    expect(pct("1Y")).toBeCloseTo(rebased("UP", 365) - 100, 3);
    expect(overview.items.find((i) => i.ticker === "DOWN")!.changes.find((c) => c.label === "1Y")!.percent)
      .toBeCloseTo(rebased("DOWN", 365) - 100, 3);
  });

  test("a period longer than the history is null, not extrapolated", async () => {
    const short = (await build(new StubMarket(), [saved("SHORT")], "1M")).items[0]!;
    expect(short.changes.find((c) => c.label === "1D")!.percent).not.toBeNull();
    expect(short.changes.find((c) => c.label === "3M")!.percent).toBeNull();
    expect(short.changes.find((c) => c.label === "1Y")!.percent).toBeNull();
  });

  test("a ticker with no bars stays on the list, unpriced and named", () => {
    const none = overview.items.find((i) => i.ticker === "NODATA")!;
    expect(none.price).toBeNull();
    expect(none.spark).toEqual([]);
    expect(none.rangePercent).toBeNull();
    expect(overview.stats.missing).toEqual(["NODATA"]);
    // Still three rows: dropping it would look like it was never saved.
    expect(overview.items).toHaveLength(3);
  });

  test("the stored report's columns ride along without parsing payloads", () => {
    const up = overview.items.find((i) => i.ticker === "UP")!;
    expect(up.companyName).toBe("Upward Industries");
    expect(up.overallScore).toBe(71);
    expect(up.classification).toBe("speculative");
    expect(up.signalCount).toBe(3);
    expect(up.sourceCount).toBe(2);
    expect(up.hasReport).toBe(true);
    expect(overview.items.find((i) => i.ticker === "NODATA")!.hasReport).toBe(false);
  });

  test("the note and the date it was saved survive", () => {
    expect(overview.items.find((i) => i.ticker === "UP")!.note).toBe("from Discover");
    expect(overview.items[0]!.createdAt).toBeString();
  });

  test("the sparkline covers the selected range and ends on the last close", () => {
    const up = overview.items.find((i) => i.ticker === "UP")!;
    expect(up.spark.length).toBeGreaterThan(2);
    expect(up.spark.at(-1)).toBe(up.price!);
    // Downsampled rather than 90 raw closes on the wire.
    expect(up.spark.length).toBeLessThanOrEqual(40);
  });

  test("52-week context is measured, and distance from the high is signed", () => {
    const up = overview.items.find((i) => i.ticker === "UP")!;
    expect(up.high52).toBeCloseTo(101, 0);
    expect(up.fromHigh52!).toBeLessThanOrEqual(0);
    const down = overview.items.find((i) => i.ticker === "DOWN")!;
    // A year into a downtrend, today is well below the 52-week high.
    expect(down.fromHigh52!).toBeLessThan(-20);
  });
});

describe("summary statistics", () => {
  test("counts movers, names the extremes and averages the scores", async () => {
    const o = await build(new StubMarket(), [saved("UP"), saved("DOWN"), saved("NODATA")], "3M");
    expect(o.stats.count).toBe(3);
    expect(o.stats.priced).toBe(2);
    expect(o.stats.gainers).toBe(1);
    expect(o.stats.losers).toBe(1);
    expect(o.stats.best!.ticker).toBe("UP");
    expect(o.stats.worst!.ticker).toBe("DOWN");
    expect(o.stats.bestDay!.ticker).toBe("UP");
    expect(o.stats.avgScore).toBe(56); // (71 + 41) / 2
    expect(o.stats.scored).toBe(2);
    expect(o.stats.withReports).toBe(2);
  });

  test("an empty watchlist reports nothing and costs no upstream call", async () => {
    const market = new StubMarket();
    const o = await build(market, [], "3M");
    expect(o.items).toEqual([]);
    expect(o.stats.count).toBe(0);
    expect(o.stats.avgDayPercent).toBeNull();
    expect(o.index).toBeNull();
    expect(market.calls).toEqual([]);
  });

  test("the range drives the window", async () => {
    const market = new StubMarket();
    const cache = new BarsCache(market, 10 * 60_000, now);
    const month = await build(market, [saved("UP")], "1M", cache);
    const year = await build(market, [saved("UP")], "1Y", cache);
    expect(month.rangeDays).toBe(30);
    expect(year.rangeDays).toBe(365);
    expect(year.items[0]!.rangePercent!).toBeGreaterThan(month.items[0]!.rangePercent!);
  });
});

describe("the equal-weight index", () => {
  test("rebases every member to 100 and averages them", async () => {
    const o = await build(new StubMarket(), [saved("UP"), saved("DOWN")], "1Y");
    const idx = o.index!;
    expect(idx.points[0]!.value).toBeCloseTo(100, 6);
    expect(idx.members).toEqual(["DOWN", "UP"]);
    // UP rises and DOWN falls across the window; equal weight is their mean.
    const expected = (rebased("UP", 365) + rebased("DOWN", 365)) / 2;
    expect(idx.points.at(-1)!.value).toBeCloseTo(expected, 1);
    expect(o.stats.rangePercent!).toBeCloseTo(expected - 100, 1);
  });

  test("draws the benchmark on the same base", async () => {
    const o = await build(new StubMarket(), [saved("UP")], "1Y");
    const idx = o.index!;
    expect(idx.benchmarkSymbol).toBe("SPY");
    expect(idx.benchmark[0]!.value).toBeCloseTo(100, 6);
    expect(idx.benchmark.at(-1)!.value).toBeCloseTo(rebased(BENCHMARK_SYMBOL, 365), 1);
    expect(o.stats.benchmarkPercent!).toBeCloseTo(rebased(BENCHMARK_SYMBOL, 365) - 100, 1);
  });

  test("leaves out a ticker whose history starts inside the window, and says so", async () => {
    const o = await build(new StubMarket(), [saved("UP"), saved("SHORT")], "1Y");
    const idx = o.index!;
    expect(idx.members).toEqual(["UP"]);
    expect(idx.excluded).toEqual(["SHORT"]);
    // Had SHORT been included at par it would have dragged the line toward 100.
    expect(idx.points.at(-1)!.value).toBeCloseTo(rebased("UP", 365), 1);
  });

  test("both lines are downsampled to a drawable number of points", async () => {
    const o = await build(new StubMarket(), [saved("UP")], "1Y");
    expect(o.index!.points.length).toBeLessThanOrEqual(160);
    expect(o.index!.points.length).toBeGreaterThan(50);
  });
});

describe("upstream cost", () => {
  test("one fetch covers the whole list, benchmark included", async () => {
    const market = new StubMarket();
    await build(market, [saved("UP"), saved("DOWN")], "3M");
    expect(market.calls).toHaveLength(1);
    expect(market.calls[0]).toEqual(["UP", "DOWN", "SPY"]);
  });

  test("a second load inside the TTL costs nothing", async () => {
    const market = new StubMarket();
    const cache = new BarsCache(market, 10 * 60_000, now);
    await build(market, [saved("UP")], "3M", cache);
    await build(market, [saved("UP")], "1Y", cache);
    expect(market.calls).toHaveLength(1);
  });

  test("adding a ticker fetches only the ticker that was added", async () => {
    const market = new StubMarket();
    const cache = new BarsCache(market, 10 * 60_000, now);
    await build(market, [saved("UP")], "3M", cache);
    await build(market, [saved("UP"), saved("DOWN")], "3M", cache);
    expect(market.calls).toHaveLength(2);
    expect(market.calls[1]).toEqual(["DOWN"]);
  });

  test("a provider failure degrades to an unpriced list with the reason", async () => {
    const broken: AlpacaMarketDataClient = {
      async getBars() { throw new Error("Alpaca 403: forbidden"); },
      async getSnapshots() { return []; },
      async getLatestTrades() { return []; },
      async getLatestQuotes() { return []; },
      async getAssets() { return []; },
      async getCalendar() { return []; },
    };
    const o = await buildWatchlistOverview(
      { db, market: broken, marketSource: "iex", now },
      [saved("UP")],
      { cache: new BarsCache(broken, 10 * 60_000, now) },
    );
    expect(o.marketError).toContain("403");
    expect(o.items[0]!.price).toBeNull();
    // The row still carries everything that does not need a price.
    expect(o.items[0]!.companyName).toBe("Upward Industries");
    expect(o.index).toBeNull();
  });
});

describe("the route", () => {
  const url = "http://localhost/api/watchlist/overview";

  test("an anonymous request is 401 with the sign-in marker", async () => {
    const res = (await handleWatchlistRoute(new Request(url), "/api/watchlist/overview", { db }))!;
    expect(res.status).toBe(401);
    expect((await res.json()).authRequired).toBe(true);
  });

  test("it is not a write endpoint", async () => {
    const res = (await handleWatchlistRoute(
      new Request(url, { method: "POST" }),
      "/api/watchlist/overview",
      { db },
    ))!;
    // Unauthenticated first: the method check must never leak whether a
    // watchlist exists.
    expect(res.status).toBe(401);
  });

  test("an unrelated path is still passed through", async () => {
    expect(await handleWatchlistRoute(new Request(url), "/api/stats", { db })).toBeNull();
  });

  test("only the documented ranges are accepted", () => {
    expect(isRangeKey("3M")).toBe(true);
    expect(isRangeKey("1Y")).toBe(true);
    expect(isRangeKey("10Y")).toBe(false);
    expect(isRangeKey(null)).toBe(false);
  });
});
