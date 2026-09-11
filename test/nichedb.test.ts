/**
 * nichedb.dev mirror: the client, the mappings into the site's own shapes, the
 * symbol walk with its cursor, and the switch.
 *
 * Everything runs against a fake `fetch` with fixtures in the documented item
 * shape (nichedb docs/markets.md), because the `symbol`/`history`/`fundamentals`
 * kinds were not deployed when this was written. The test that matters most is
 * the last one: with the switch off, no request to nichedb can be made.
 */
import { afterEach, beforeAll, afterAll, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/index.ts";
import {
  NEWS_KIND,
  NichedbClient,
  PAGE_LIMIT,
  nichedbEnabled,
  symbolTag,
  type NichedbItem,
} from "../src/providers/nichedb.ts";
import {
  HISTORY_MAX_AGE_DAYS,
  NichedbMarkets,
  barTimestamp,
  fundamentalsToFacts,
  historyToBars,
  isFresh,
  newsItemsToHits,
  nichedbMarketsFromEnv,
  symbolItemsToRows,
} from "../src/providers/nichedb-markets.ts";
import { NewsProvider } from "../src/providers/news/index.ts";
import { readCursor, syncSymbolsFromNichedb, writeCursor, SYMBOLS_CURSOR_KEY } from "../src/symbols/nichedb-sync.ts";
import type { SymbolRow } from "../src/symbols/directory.ts";

const NOW = Date.parse("2026-09-11T12:00:00Z");

/** A fake fetch that answers each URL from `routes` (substring match) and records what was asked. */
function fakeFetch(routes: Array<[string, unknown]> | ((url: string) => unknown), calls: string[] = []) {
  const fetchImpl = (async (input: any, init?: any) => {
    const url = String(input);
    calls.push(url);
    const body =
      typeof routes === "function"
        ? routes(url)
        : (routes.find(([needle]) => url.includes(needle))?.[1] ?? { count: 0, items: [] });
    if (body instanceof Response) return body;
    return {
      ok: true,
      status: 200,
      headers: init?.headers,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

const item = (over: Partial<NichedbItem>): NichedbItem => ({
  id: 1,
  collection: "markets",
  kind: "history",
  external_id: "x",
  updated_at: "2026-09-10T00:20:00.000Z",
  title: null,
  summary: null,
  url: null,
  image_url: null,
  published_at: null,
  tags: [],
  data: {},
  ...over,
});

const HISTORY = item({
  id: 10,
  kind: "history",
  external_id: "history:AAPL",
  published_at: "2026-09-10T00:00:00.000Z",
  tags: ["history", "symbol:aapl", "feed:iex"],
  data: {
    symbol: "AAPL",
    timeframe: "1Day",
    feed: "iex",
    adjustment: "split",
    bars: [
      ["2026-09-03", 100, 101, 99, 100.5, 1000, 100.2],
      ["2026-09-04", 100.5, 102, 100, 101.5, 1100, null],
      ["2026-09-08", 101.5, 103, 101, 102.5, 1200, 102.1],
      ["2026-09-09", 102.5, 104, 102, 103.5, 1300, 103.2],
      ["2026-09-10", 103.5, 105, 103, 104.5, 1400, 104.1],
    ],
    first: "2026-09-03",
    last: "2026-09-10",
    count: 5,
  },
});

const FY = (end: string, val: number, start?: string) => ({
  start: start ?? `${Number(end.slice(0, 4)) - 1}-${end.slice(5)}`,
  end, val, fy: Number(end.slice(0, 4)), fp: "FY", form: "10-K", filed: `${Number(end.slice(0, 4)) + 1}-02-01`, unit: "USD",
});
const Q = (end: string, val: number) => ({
  start: null, end, val, fy: Number(end.slice(0, 4)), fp: "Q2", form: "10-Q", filed: end, unit: "USD",
});

const FUNDAMENTALS = item({
  id: 20,
  kind: "fundamentals",
  external_id: "sec:facts:320193",
  published_at: "2026-08-01T00:00:00.000Z",
  tags: ["fundamentals", "symbol:aapl", "cik:320193", "exchange:nasdaq"],
  data: {
    cik: 320193,
    symbol: "AAPL",
    symbols: ["AAPL"],
    name: "Apple Inc.",
    exchange: "Nasdaq",
    concepts: {
      RevenueFromContractWithCustomerExcludingAssessedTax: [FY("2024-09-28", 391_000), FY("2025-09-27", 416_000)],
      Revenues: [FY("2025-09-27", 1)],
      CashAndCashEquivalentsAtCarryingValue: [Q("2025-06-28", 28_000), Q("2026-06-27", 30_000)],
      LongTermDebtNoncurrent: [Q("2026-06-27", 80_000)],
      LongTermDebtCurrent: [Q("2026-06-27", 10_000)],
      LongTermDebt: [Q("2026-06-27", 999_999)],
      NetCashProvidedByUsedInOperatingActivities: [Q("2026-06-27", -12_000)],
      EntityCommonStockSharesOutstanding: [Q("2026-06-27", 15_000)],
      CommonStockSharesOutstanding: [Q("2026-06-27", 14_000)],
      EntityPublicFloat: [Q("2025-03-28", 3_000_000)],
    },
    latest: {
      revenue: 416_000, cash: 30_000, operatingCashFlow: -12_000, sharesOutstanding: 15_000,
      publicFloat: 3_000_000, longTermDebt: 90_000, period: "2026-06-27", fp: "Q3", fy: 2026,
      form: "10-Q", filed: "2026-08-01",
    },
  },
});

const symbolItem = (id: number, symbol: string, over: Record<string, unknown> = {}, updated = "2026-09-10T06:00:00.000Z") =>
  item({
    id,
    kind: "symbol",
    external_id: `alpaca:asset:${id}`,
    updated_at: updated,
    title: `${symbol} · ${symbol} Inc.`,
    tags: ["symbol", "exchange:nasdaq", "class:us_equity", "tradable"],
    data: {
      assetId: String(id), symbol, name: `${symbol} Inc.`, exchange: "NASDAQ", assetClass: "us_equity",
      status: "active", tradable: true, fractionable: true, attributes: [], ...over,
    },
  });

const NEWS = [
  item({
    id: 30, kind: NEWS_KIND, external_id: "alpaca-news-1", title: "AAPL beats on iPhone",
    summary: "Apple reported...", url: "https://www.benzinga.com/news/1", published_at: "2026-09-09T13:05:00.000Z",
    tags: ["market-news", "benzinga", "aapl"], data: { source: "benzinga", author: "A. Writer", symbols: ["AAPL"] },
  }),
  item({
    id: 31, kind: NEWS_KIND, external_id: "alpaca-news-2", title: "AAPL supplier note",
    summary: null, url: "https://www.reuters.com/x", published_at: "2026-09-08T09:00:00.000Z",
    tags: ["market-news", "aapl"], data: { source: null, author: "R. Byline", symbols: ["AAPL"] },
  }),
  item({ id: 32, kind: NEWS_KIND, external_id: "alpaca-news-3", title: "no url", url: null, tags: ["aapl"], data: {} }),
];

describe("client: URLs and tags", () => {
  const client = new NichedbClient({ baseUrl: "https://mirror.example/", fetch: fakeFetch([]).fetchImpl, now: () => NOW });

  test("history is one item by its symbol tag, lower-cased in Alpaca's spelling", () => {
    const u = new URL(client.itemsUrl({ collection: "markets", kind: "history", tags: [symbolTag("BRK.B")], limit: 1 }));
    expect(u.origin).toBe("https://mirror.example");
    expect(u.pathname).toBe("/api/v1/items");
    expect(u.searchParams.get("collection")).toBe("markets");
    expect(u.searchParams.get("kind")).toBe("history");
    expect(u.searchParams.get("tags")).toBe("symbol:brk.b");
    expect(u.searchParams.get("limit")).toBe("1");
  });

  test("fundamentals accepts a ticker or a plain CIK", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const c = new NichedbClient({ baseUrl: "https://mirror.example", fetch: fetchImpl });
    await c.fundamentalsItem("aapl");
    await c.fundamentalsItem("0000320193");
    expect(new URL(calls[0]!).searchParams.get("tags")).toBe("symbol:aapl");
    expect(new URL(calls[1]!).searchParams.get("tags")).toBe("cik:320193");
    expect(new URL(calls[1]!).searchParams.get("kind")).toBe("fundamentals");
  });

  test("news is the market-news kind, tagged with the bare lower-case symbol, windowed on published_at", async () => {
    const { fetchImpl, calls } = fakeFetch([]);
    const c = new NichedbClient({ baseUrl: "https://mirror.example", fetch: fetchImpl, now: () => NOW });
    await c.newsItems("AAPL", { sinceDays: 90 });
    const u = new URL(calls[0]!);
    expect(u.searchParams.get("kind")).toBe("market-news");
    expect(u.searchParams.get("tags")).toBe("aapl");
    expect(u.searchParams.get("from")).toBe(new Date(NOW - 90 * 86_400_000).toISOString());
    expect(u.searchParams.get("since")).toBeNull();
    expect(u.searchParams.get("sort")).toBe("published");
    expect(u.searchParams.get("order")).toBe("desc");
  });

  test("limit is capped at the API's 200 and tags are normalized", () => {
    const u = new URL(client.itemsUrl({ collection: "markets", tags: [" Symbol:AAPL "], limit: 5000 }));
    expect(u.searchParams.get("limit")).toBe(String(PAGE_LIMIT));
    expect(u.searchParams.get("tags")).toBe("symbol:aapl");
  });

  test("sends the research User-Agent and a timeout signal", async () => {
    let seen: any;
    const fetchImpl = (async (_u: any, init: any) => {
      seen = init;
      return { ok: true, status: 200, json: async () => ({ items: [] }) } as any;
    }) as unknown as typeof fetch;
    await new NichedbClient({ fetch: fetchImpl }).historyItem("AAPL");
    expect(seen.headers["User-Agent"]).toBe("advis0r.com/2.0 (research)");
    expect(seen.signal).toBeInstanceOf(AbortSignal);
  });

  test("base URL comes from NICHEDB_URL when not given, default nichedb.dev", () => {
    const prev = process.env.NICHEDB_URL;
    delete process.env.NICHEDB_URL;
    expect(new NichedbClient().baseUrl).toBe("https://nichedb.dev");
    process.env.NICHEDB_URL = "https://staging.example/";
    expect(new NichedbClient().baseUrl).toBe("https://staging.example");
    if (prev === undefined) delete process.env.NICHEDB_URL;
    else process.env.NICHEDB_URL = prev;
  });

  test("a non-2xx answer throws rather than returning an empty page", async () => {
    const fetchImpl = (async () => ({ ok: false, status: 503, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(new NichedbClient({ fetch: fetchImpl }).historyItem("AAPL")).rejects.toThrow(/503/);
  });

  test("symbolItem goes through /api/v1/match and verifies data.symbol", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["/api/v1/match", { items: [symbolItem(2, "AAPLW"), symbolItem(1, "AAPL")] }],
    ]);
    const c = new NichedbClient({ baseUrl: "https://mirror.example", fetch: fetchImpl });
    const hit = await c.symbolItem("aapl");
    expect(hit?.id).toBe(1);
    const u = new URL(calls[0]!);
    expect(u.pathname).toBe("/api/v1/match");
    expect(u.searchParams.get("kind")).toBe("symbol");
    expect(u.searchParams.get("q")).toBe("AAPL");
    expect(await c.symbolItem("ZZZZ")).toBeNull();
  });
});

describe("history item → MarketBar[]", () => {
  test("maps the seven-tuple into the Alpaca bar shape, oldest first", () => {
    const out = historyToBars(HISTORY, {}, NOW)!;
    expect(out.feed).toBe("iex");
    expect(out.delayed).toBe(true);
    expect(out.last).toBe("2026-09-10");
    expect(out.bars).toHaveLength(5);
    const first = out.bars[0]!;
    expect(first).toEqual({
      symbol: "AAPL", timestamp: barTimestamp("2026-09-03"), open: 100, high: 101, low: 99, close: 100.5,
      volume: 1000, vwap: 100.2, timeframe: "1Day", adjustment: "split",
    });
    // A null vwap is absent, as the Alpaca mapper leaves an unsent `vw`.
    expect(out.bars[1]!.vwap).toBeUndefined();
    // Midnight Eastern, so the report page's slice(0, 10) and the digest's
    // etDate() both read the bar's own day.
    expect(first.timestamp).toBe("2026-09-03T05:00:00Z");
  });

  test("cuts the window to the days asked for", () => {
    const out = historyToBars(HISTORY, { start: "2026-09-04T00:00:00Z", end: "2026-09-09T23:00:00Z" }, NOW)!;
    expect(out.bars.map((b) => b.timestamp.slice(0, 10))).toEqual(["2026-09-04", "2026-09-08", "2026-09-09"]);
  });

  test("a SIP feed is not delayed", () => {
    const sip = item({ ...HISTORY, data: { ...HISTORY.data, feed: "sip" } });
    expect(historyToBars(sip, {}, NOW)!.delayed).toBe(false);
  });

  test("a window whose last bar is older than five days is refused (live fallback)", () => {
    const sixDays = NOW + 6 * 86_400_000;
    expect(historyToBars(HISTORY, {}, sixDays)).toBeNull();
    const fiveDays = Date.parse("2026-09-10T00:00:00Z") + HISTORY_MAX_AGE_DAYS * 86_400_000;
    expect(historyToBars(HISTORY, {}, fiveDays)).not.toBeNull();
    expect(isFresh("2026-09-10", fiveDays + 1)).toBe(false);
    expect(isFresh("not a date", NOW)).toBe(false);
  });

  test("no item, the wrong kind, or an empty window all mean fallback", () => {
    expect(historyToBars(null, {}, NOW)).toBeNull();
    expect(historyToBars(item({ kind: "symbol", data: HISTORY.data }), {}, NOW)).toBeNull();
    expect(historyToBars(item({ data: { ...HISTORY.data, bars: [] } }), {}, NOW)).toBeNull();
    // Fresh item but the requested window is entirely before its first bar.
    expect(historyToBars(HISTORY, { end: "2026-01-01" }, NOW)).toBeNull();
  });

  test("NichedbMarkets.bars swallows a mirror error into a fallback", async () => {
    const misses: string[] = [];
    const fetchImpl = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
    const m = new NichedbMarkets(new NichedbClient({ fetch: fetchImpl }), { onMiss: (w, why) => misses.push(`${w}: ${why}`) });
    expect(await m.bars("AAPL", {})).toBeNull();
    expect(misses[0]).toMatch(/^history: .*offline/);
  });
});

describe("fundamentals item → CompanyFacts", () => {
  test("derives the same figures the SEC provider does, from the same concepts", () => {
    const facts = fundamentalsToFacts(FUNDAMENTALS, "aapl", "2026-09-11T12:00:00Z")!;
    expect(facts.symbol).toBe("AAPL");
    expect(facts.source).toBe("nichedb");
    expect(facts.companyName).toBe("Apple Inc.");
    expect(facts.cik).toBe("0000320193");
    expect(facts.exchange).toBe("Nasdaq");
    // Revenue: RevenueFromContract... wins over Revenues, like sec.ts.
    expect(facts.revenue).toBe(416_000);
    expect(facts.revenueGrowth).toBe(6.4);
    // Shares from the cover page (dei), not the balance sheet.
    expect(facts.sharesOutstanding).toBe(15_000);
    expect(facts.publicFloat).toBe(3_000_000);
    expect(facts.cashBalance).toBe(30_000);
    // Debt is current + non-current; the LongTermDebt total is only a fallback.
    expect(facts.totalDebt).toBe(90_000);
    expect(facts.freeCashFlow).toBe(-12_000);
    // cash / (burn / 12) = 30000 / 1000 = 30 months.
    expect(facts.runwayMonths).toBe(30);
    expect(facts.asOf).toBe("2026-09-11T12:00:00Z");
  });

  test("asOf is point-in-time: a past cutoff reads what was known then", () => {
    const facts = fundamentalsToFacts(FUNDAMENTALS, "AAPL", "2025-08-01T00:00:00Z")!;
    expect(facts.cashBalance).toBe(28_000);
    expect(facts.revenue).toBe(391_000);
    // Only one full year on/before the cutoff: no growth figure.
    expect(facts.revenueGrowth).toBeUndefined();
    // Nothing filed by then: absent, never the item's current headline.
    expect(facts.totalDebt).toBeUndefined();
    expect(facts.sharesOutstanding).toBeUndefined();
  });

  test("falls back to the item's `latest` when concepts are missing", () => {
    const thin = item({ kind: "fundamentals", data: { cik: "1", symbol: "X", name: "X Co", latest: { revenue: 5, cash: 7 } } });
    const facts = fundamentalsToFacts(thin, "X")!;
    expect(facts.revenue).toBe(5);
    expect(facts.cashBalance).toBe(7);
    expect(facts.cik).toBe("0000000001");
  });

  test("no item or the wrong kind means the live SEC path", () => {
    expect(fundamentalsToFacts(null, "AAPL")).toBeNull();
    expect(fundamentalsToFacts(HISTORY, "AAPL")).toBeNull();
  });
});

describe("news items → hits for the news pipeline", () => {
  test("maps publisher, host, tier, date and snippet like an RSS hit", () => {
    const hits = newsItemsToHits(NEWS);
    expect(hits).toHaveLength(2);
    expect(hits[0]).toEqual({
      title: "AAPL beats on iPhone",
      url: "https://www.benzinga.com/news/1",
      publisher: "benzinga",
      host: "benzinga.com",
      tier: 2,
      publishedAt: "2026-09-09",
      snippet: "Apple reported...",
    });
    // No source name: the byline; tier from the article host.
    expect(hits[1]!.publisher).toBe("R. Byline");
    expect(hits[1]!.tier).toBe(1);
    expect(hits[1]!.snippet).toBeUndefined();
  });

  test("hits go through NewsProvider first and count against the per-ticker cap", async () => {
    const { fetchImpl } = fakeFetch([["/api/v1/items", { count: 2, items: NEWS }]]);
    const markets = new NichedbMarkets(new NichedbClient({ fetch: fetchImpl, now: () => NOW }));
    const rssCalls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any) => {
      rssCalls.push(String(input));
      return new Response("<rss><channel></channel></rss>", { status: 200, headers: { "content-type": "application/rss+xml" } });
    }) as any;
    try {
      const provider = new NewsProvider({
        downloadsDir: "/tmp",
        perTicker: 1,
        discover: (t) => markets.newsHits(t, { sinceDays: 90 }),
      });
      const docs = await provider.search({ topic: "news", tickers: ["AAPL"], from: "2026-06-13" });
      expect(docs).toHaveLength(1);
      expect(docs[0]!.url).toBe("https://www.benzinga.com/news/1");
      expect(docs[0]!.publisher).toBe("benzinga");
      expect(docs[0]!.sourceTier).toBe(2);
      expect(docs[0]!.publishedAt).toBe("2026-09-09");
      expect(docs[0]!.tickers).toEqual(["AAPL"]);
      // The RSS feeds still ran after the wire.
      expect(rssCalls.some((u) => u.includes("feeds.finance.yahoo.com"))).toBe(true);
      expect(rssCalls.some((u) => u.includes("nichedb"))).toBe(false);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("symbol directory walk with a stored cursor", () => {
  const dir = mkdtempSync(join(tmpdir(), "advis0r-nichedb-"));
  let db: Client;
  beforeAll(async () => {
    db = createClient({ url: `file:${join(dir, "cursor.sqlite")}` });
    await migrate(db);
  });
  afterAll(() => {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("symbol items become directory rows; crypto pairs are left out", () => {
    const rows = symbolItemsToRows([
      symbolItem(1, "AAPL"),
      symbolItem(2, "BTC/USD", { assetClass: "crypto", exchange: "CRYPTO" }),
      symbolItem(3, "DEAD", { tradable: false, status: "inactive", exchange: "OTC" }),
      item({ kind: "symbol", data: { symbol: "NONAME" } }),
    ]);
    expect(rows.map((r) => r.symbol)).toEqual(["AAPL", "DEAD"]);
    expect(rows[0]).toEqual({
      symbol: "AAPL", name: "AAPL Inc.", exchange: "NASDAQ", assetClass: "us_equity", status: "active",
      tradable: true, source: "nichedb",
    });
    expect(rows[1]!.tradable).toBe(false);
  });

  test("a first sync walks every page by id and stores the newest updated_at", async () => {
    const page1 = Array.from({ length: PAGE_LIMIT }, (_, i) => symbolItem(1000 + i, `S${i}`, {}, "2026-09-10T06:00:00.000Z"));
    const page2 = [symbolItem(5000, "LAST", {}, "2026-09-10T06:30:00.000Z"), symbolItem(5001, "BTC/USD", { assetClass: "crypto" })];
    const { fetchImpl, calls } = fakeFetch((url) => {
      const after = new URL(url).searchParams.get("after");
      if (!after) return { count: page1.length, items: page1 };
      if (after === "1199") return { count: page2.length, items: page2 };
      return { count: 0, items: [] };
    });
    const written: SymbolRow[][] = [];
    const client = new NichedbClient({ baseUrl: "https://mirror.example", fetch: fetchImpl });
    const r = await syncSymbolsFromNichedb(db, client, {
      upsert: async (_db, rows) => { written.push(rows); return rows.length; },
    });
    expect(r.pages).toBe(2);
    expect(r.items).toBe(PAGE_LIMIT + 2);
    expect(r.written).toBe(PAGE_LIMIT + 1);
    expect(r.since).toBeUndefined();
    expect(r.cursor).toBe("2026-09-10T06:30:00.000Z");
    expect(await readCursor(db, SYMBOLS_CURSOR_KEY)).toBe("2026-09-10T06:30:00.000Z");
    // Page one had no cursor and no keyset; page two continued after its last id.
    const u1 = new URL(calls[0]!);
    expect(u1.searchParams.get("kind")).toBe("symbol");
    expect(u1.searchParams.get("sort")).toBe("id");
    expect(u1.searchParams.get("order")).toBe("asc");
    expect(u1.searchParams.get("limit")).toBe("200");
    expect(u1.searchParams.get("since")).toBeNull();
    expect(u1.searchParams.get("after")).toBeNull();
    expect(new URL(calls[1]!).searchParams.get("after")).toBe("1199");
    // A short page ends the walk without asking for an empty third page.
    expect(calls).toHaveLength(2);
  });

  test("the next sync passes the cursor as since= and keeps it when nothing moved", async () => {
    const { fetchImpl, calls } = fakeFetch([["since=", { count: 0, items: [] }]]);
    const client = new NichedbClient({ baseUrl: "https://mirror.example", fetch: fetchImpl });
    const r = await syncSymbolsFromNichedb(db, client, { upsert: async () => 0 });
    expect(new URL(calls[0]!).searchParams.get("since")).toBe("2026-09-10T06:30:00.000Z");
    expect(r.pages).toBe(0);
    expect(r.cursor).toBe("2026-09-10T06:30:00.000Z");
  });

  test("a delta advances the cursor to the newest row seen", async () => {
    const moved = [symbolItem(7, "MOVED", {}, "2026-09-11T06:00:00.000Z")];
    const { fetchImpl } = fakeFetch([["since=", { count: 1, items: moved }]]);
    const client = new NichedbClient({ baseUrl: "https://mirror.example", fetch: fetchImpl });
    const r = await syncSymbolsFromNichedb(db, client, { upsert: async (_db, rows) => rows.length });
    expect(r.written).toBe(1);
    expect(r.cursor).toBe("2026-09-11T06:00:00.000Z");
    expect(await readCursor(db, SYMBOLS_CURSOR_KEY)).toBe("2026-09-11T06:00:00.000Z");
  });

  test("a failed walk leaves the cursor where it was, so it is repeated", async () => {
    await writeCursor(db, SYMBOLS_CURSOR_KEY, "2026-09-11T06:00:00.000Z");
    const fetchImpl = (async () => ({ ok: false, status: 502, json: async () => ({}) })) as unknown as typeof fetch;
    await expect(syncSymbolsFromNichedb(db, new NichedbClient({ fetch: fetchImpl }), { upsert: async () => 0 })).rejects.toThrow(/502/);
    expect(await readCursor(db, SYMBOLS_CURSOR_KEY)).toBe("2026-09-11T06:00:00.000Z");
  });
});

describe("the switch", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test("NICHEDB_MARKETS must be set to 1 (or true)", () => {
    expect(nichedbEnabled({})).toBe(false);
    expect(nichedbEnabled({ NICHEDB_MARKETS: "0" })).toBe(false);
    expect(nichedbEnabled({ NICHEDB_MARKETS: "" })).toBe(false);
    expect(nichedbEnabled({ NICHEDB_MARKETS: "1" })).toBe(true);
    expect(nichedbEnabled({ NICHEDB_MARKETS: "true" })).toBe(true);
    expect(nichedbMarketsFromEnv({})).toBeUndefined();
    expect(nichedbMarketsFromEnv({ NICHEDB_MARKETS: "off" })).toBeUndefined();
    expect(nichedbMarketsFromEnv({ NICHEDB_MARKETS: "1", NICHEDB_URL: "https://m.example" })?.client.baseUrl).toBe("https://m.example");
  });

  test("off, a news search reaches every feed but never nichedb", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: any) => {
      calls.push(String(input));
      return new Response("<rss><channel></channel></rss>", { status: 200 });
    }) as any;
    const markets = nichedbMarketsFromEnv({ NICHEDB_MARKETS: undefined });
    const provider = new NewsProvider({
      downloadsDir: "/tmp",
      perTicker: 8,
      discover: markets ? (t) => markets.newsHits(t) : undefined,
    });
    await provider.search({ topic: "news", tickers: ["AAPL"] });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.filter((u) => u.includes("nichedb"))).toEqual([]);
  });

  test("on, the reads a report build makes are one request each", async () => {
    const { fetchImpl, calls } = fakeFetch([
      ["kind=history", { count: 1, items: [HISTORY] }],
      ["kind=fundamentals", { count: 1, items: [FUNDAMENTALS] }],
    ]);
    const markets = nichedbMarketsFromEnv({ NICHEDB_MARKETS: "1" }, { fetch: fetchImpl });
    const bars = await markets!.bars("AAPL", { start: "2026-09-01", end: "2026-09-11" });
    const facts = await markets!.facts("AAPL", "2026-09-11T00:00:00Z");
    expect(bars?.bars.length).toBe(5);
    expect(facts?.revenue).toBe(416_000);
    expect(calls).toHaveLength(2);
    expect(markets!.client.requests).toBe(2);
  });
});
