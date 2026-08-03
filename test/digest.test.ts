/**
 * Watchlist email digest tests.
 *
 * The properties worth pinning down are the ones whose failure is visible in
 * someone's inbox: sending on a market holiday, sending twice, sending at the
 * wrong hour, computing a percentage against the wrong baseline, or shipping an
 * email with a broken unsubscribe link.
 */
import { describe, expect, test } from "bun:test";
import {
  addDays,
  digestsDue,
  etDate,
  formatSessionDate,
  isFirstTradingDayOfWeek,
  isTradingDay,
  marketHolidays,
  nextSendAt,
  parseFrequency,
  premarketOpen,
  previousTradingDay,
  tradingDaysBetween,
  weekKey,
  weekStart,
} from "../src/digest/schedule.ts";
import {
  MARKET_INDICES,
  buildMarketSummary,
  summaryForTickers,
  type Performance,
} from "../src/digest/summary.ts";
import {
  digestSubject,
  money,
  percent,
  renderDigest,
  unsubscribeUrl,
  volume,
  windowLabel,
} from "../src/digest/render.ts";
import type { MarketBar } from "../src/types.ts";
import type { AlpacaMarketDataClient } from "../src/providers/interfaces.ts";

/* ---------------- market calendar ---------------- */

describe("trading-day calendar", () => {
  test("weekends are never trading days", () => {
    expect(isTradingDay("2026-08-01")).toBe(false); // Saturday
    expect(isTradingDay("2026-08-02")).toBe(false); // Sunday
    expect(isTradingDay("2026-08-03")).toBe(true); // Monday
  });

  test("recognizes the 2026 NYSE holiday set", () => {
    const h = marketHolidays(2026);
    expect(h.has("2026-01-01")).toBe(true); // New Year's Day (Thursday)
    expect(h.has("2026-01-19")).toBe(true); // MLK, 3rd Monday
    expect(h.has("2026-02-16")).toBe(true); // Washington's Birthday
    expect(h.has("2026-04-03")).toBe(true); // Good Friday
    expect(h.has("2026-05-25")).toBe(true); // Memorial Day
    expect(h.has("2026-06-19")).toBe(true); // Juneteenth
    expect(h.has("2026-07-03")).toBe(true); // July 4 falls Saturday -> observed Friday
    expect(h.has("2026-09-07")).toBe(true); // Labor Day
    expect(h.has("2026-11-26")).toBe(true); // Thanksgiving
    expect(h.has("2026-12-25")).toBe(true); // Christmas
  });

  test("Good Friday tracks Easter across years", () => {
    expect(marketHolidays(2025).has("2025-04-18")).toBe(true);
    expect(marketHolidays(2027).has("2027-03-26")).toBe(true);
  });

  test("a Sunday holiday is observed on the Monday", () => {
    // July 4, 2027 is a Sunday; the exchange closes Monday the 5th.
    expect(marketHolidays(2027).has("2027-07-05")).toBe(true);
    expect(isTradingDay("2027-07-05")).toBe(false);
  });

  test("New Year's Day is the exception: no Friday-before observance", () => {
    // Jan 1, 2028 is a Saturday. The market is open Friday Dec 31, 2027.
    expect(isTradingDay("2027-12-31")).toBe(true);
  });

  test("previousTradingDay steps over weekends and holidays", () => {
    expect(previousTradingDay("2026-08-03")).toBe("2026-07-31"); // Monday -> Friday
    expect(previousTradingDay("2026-12-28")).toBe("2026-12-24"); // past Christmas + weekend
    expect(previousTradingDay("2026-07-06")).toBe("2026-07-02"); // past the observed July 4
  });

  test("tradingDaysBetween excludes closures inside the range", () => {
    expect(tradingDaysBetween("2026-05-25", "2026-05-29")).toEqual([
      "2026-05-26",
      "2026-05-27",
      "2026-05-28",
      "2026-05-29",
    ]); // Memorial Day Monday dropped
  });
});

describe("week boundaries", () => {
  test("Monday opens the week", () => {
    expect(isFirstTradingDayOfWeek("2026-08-03")).toBe(true);
    expect(isFirstTradingDayOfWeek("2026-08-04")).toBe(false);
    expect(isFirstTradingDayOfWeek("2026-08-08")).toBe(false); // Saturday
  });

  test("a Monday holiday moves the week's first session to Tuesday", () => {
    expect(isTradingDay("2026-05-25")).toBe(false); // Memorial Day
    expect(isFirstTradingDayOfWeek("2026-05-26")).toBe(true);
  });

  test("weekStart and weekKey agree on the ISO week", () => {
    expect(weekStart("2026-08-07")).toBe("2026-08-03");
    expect(weekKey("2026-08-03")).toBe(weekKey("2026-08-07"));
    expect(weekKey("2026-08-03")).not.toBe(weekKey("2026-07-31"));
  });
});

/* ---------------- send timing ---------------- */

/** An instant expressed in Eastern wall-clock terms. */
const et = (dateIso: string, hour: number, minute = 0) => premarketOpen(dateIso).getTime()
  ? new Date(premarketOpen(dateIso).getTime() + ((hour - 4) * 60 + minute) * 60_000)
  : new Date(NaN);

describe("pre-market open", () => {
  test("resolves to 04:00 Eastern in daylight time", () => {
    const open = premarketOpen("2026-08-03");
    expect(open.toISOString()).toBe("2026-08-03T08:00:00.000Z"); // EDT = UTC-4
    expect(etDate(open)).toBe("2026-08-03");
  });

  test("resolves to 04:00 Eastern in standard time", () => {
    expect(premarketOpen("2026-01-05").toISOString()).toBe("2026-01-05T09:00:00.000Z"); // EST = UTC-5
  });

  test("an instant just before midnight ET still belongs to that Eastern date", () => {
    expect(etDate(new Date("2026-08-04T03:30:00Z"))).toBe("2026-08-03");
  });
});

describe("digestsDue", () => {
  test("nothing is due before the bell", () => {
    const decision = digestsDue(et("2026-08-04", 3, 30));
    expect(decision.windows).toEqual([]);
    expect(decision.skipped).toContain("04:00 ET");
  });

  test("the daily digest is due right after the bell, covering the prior session", () => {
    const decision = digestsDue(et("2026-08-04", 4, 2));
    expect(decision.windows).toHaveLength(1);
    expect(decision.windows[0]!.frequency).toBe("daily");
    expect(decision.windows[0]!.sessions).toEqual(["2026-08-03"]);
    expect(decision.windows[0]!.periodKey).toBe("daily:2026-08-04");
  });

  test("Monday adds the weekly digest, covering the whole prior week", () => {
    const decision = digestsDue(et("2026-08-03", 4, 5));
    expect(decision.windows.map((w) => w.frequency)).toEqual(["daily", "weekly"]);
    const weekly = decision.windows[1]!;
    expect(weekly.sessions).toEqual([
      "2026-07-27", "2026-07-28", "2026-07-29", "2026-07-30", "2026-07-31",
    ]);
    expect(weekly.periodKey).toBe("weekly:2026-W31");
  });

  test("nothing is due on a weekend or a market holiday", () => {
    expect(digestsDue(et("2026-08-08", 5)).windows).toEqual([]);
    expect(digestsDue(et("2026-12-25", 5)).skipped).toContain("not a US equity trading day");
  });

  test("a run long after the open is skipped rather than delivered late", () => {
    expect(digestsDue(et("2026-08-04", 14)).skipped).toContain("past the");
    // ...but a run inside the catch-up window still delivers.
    expect(digestsDue(et("2026-08-04", 9)).windows).toHaveLength(1);
  });

  test("force bypasses every gate but still builds a real window", () => {
    const decision = digestsDue(et("2026-12-25", 20), { force: true });
    expect(decision.windows.map((w) => w.frequency)).toEqual(["daily", "weekly"]);
    expect(decision.windows[0]!.sessions).toEqual(["2026-12-24"]);
  });
});

describe("nextSendAt", () => {
  test("daily points at tomorrow's open once today's has passed", () => {
    expect(nextSendAt("daily", et("2026-08-03", 6))!.toISOString()).toBe("2026-08-04T08:00:00.000Z");
  });

  test("daily points at today's open when the bell has not rung", () => {
    expect(nextSendAt("daily", et("2026-08-03", 1))!.toISOString()).toBe("2026-08-03T08:00:00.000Z");
  });

  test("weekly skips to the next week's first session", () => {
    const next = nextSendAt("weekly", et("2026-08-04", 6))!;
    expect(etDate(next)).toBe("2026-08-10"); // the following Monday
  });

  test("weekly lands on Tuesday when Monday is a holiday", () => {
    expect(etDate(nextSendAt("weekly", et("2026-05-22", 6))!)).toBe("2026-05-26");
  });

  test("off has no next send", () => {
    expect(nextSendAt("off", new Date())).toBeNull();
  });
});

describe("parseFrequency", () => {
  test("accepts the three valid values", () => {
    expect(parseFrequency("daily")).toBe("daily");
    expect(parseFrequency("WEEKLY")).toBe("weekly");
    expect(parseFrequency(" off ")).toBe("off");
  });

  test("unknown input falls back to the caller's default, not silently to daily", () => {
    expect(parseFrequency("hourly")).toBe("daily");
    expect(parseFrequency(undefined, "off")).toBe("off");
  });
});

/* ---------------- summary ---------------- */

function bar(symbol: string, date: string, close: number, opts: Partial<MarketBar> = {}): MarketBar {
  return {
    symbol,
    // Midnight ET, the way Alpaca timestamps a daily bar.
    timestamp: `${date}T04:00:00Z`,
    open: opts.open ?? close,
    high: opts.high ?? close,
    low: opts.low ?? close,
    close,
    volume: opts.volume ?? 1_000_000,
    timeframe: "1Day",
    adjustment: "all",
  };
}

/** Market client backed by a fixed bar list; records what was requested. */
function stubMarket(bars: MarketBar[]): AlpacaMarketDataClient & { requested: string[] } {
  const requested: string[] = [];
  return {
    requested,
    async getBars(request) {
      requested.push(...request.symbols);
      return bars.filter((b) => request.symbols.includes(b.symbol));
    },
    async getSnapshots() { return []; },
    async getLatestTrades() { return []; },
    async getLatestQuotes() { return []; },
    async getAssets() { return []; },
    async getCalendar() { return []; },
  } as AlpacaMarketDataClient & { requested: string[] };
}

/** Minimal libSQL stand-in: every query returns no rows. */
const emptyDb = { execute: async () => ({ rows: [] }) } as any;

const dailyWindow = digestsDue(et("2026-08-04", 5)).windows[0]!;
const weeklyWindow = digestsDue(et("2026-08-03", 5)).windows[1]!;

describe("market summary", () => {
  test("daily change is measured against the prior session's close", async () => {
    const market = stubMarket([
      bar("AAA", "2026-07-31", 10),
      bar("AAA", "2026-08-03", 11, { open: 10.2, high: 11.5, low: 10.1, volume: 2_000_000 }),
    ]);
    const summary = await buildMarketSummary({ db: emptyDb, market }, dailyWindow, ["AAA"]);
    const perf = summary.byTicker.get("AAA")!;
    expect(perf.close).toBe(11);
    expect(perf.previousClose).toBe(10);
    expect(perf.changePercent).toBeCloseTo(10, 6);
    expect(perf.volume).toBe(2_000_000);
    expect(perf.sessions).toBe(1);
  });

  test("weekly aggregates the window and measures from the prior week's close", async () => {
    const market = stubMarket([
      bar("AAA", "2026-07-24", 100),
      bar("AAA", "2026-07-27", 102, { open: 100.5, high: 103, low: 100, volume: 1_000 }),
      bar("AAA", "2026-07-29", 108, { high: 112, low: 101, volume: 2_000 }),
      bar("AAA", "2026-07-31", 110, { high: 111, low: 106, volume: 3_000 }),
    ]);
    const summary = await buildMarketSummary({ db: emptyDb, market }, weeklyWindow, ["AAA"]);
    const perf = summary.byTicker.get("AAA")!;
    expect(perf.sessions).toBe(3); // only the sessions that actually have bars
    expect(perf.open).toBe(100.5); // first covered session's open
    expect(perf.close).toBe(110);
    expect(perf.high).toBe(112);
    expect(perf.low).toBe(100);
    expect(perf.volume).toBe(6_000);
    expect(perf.previousClose).toBe(100);
    expect(perf.changePercent).toBeCloseTo(10, 6);
  });

  test("a ticker with no bars is reported unavailable, never invented", async () => {
    const summary = await buildMarketSummary(
      { db: emptyDb, market: stubMarket([bar("AAA", "2026-08-03", 5)]) },
      dailyWindow,
      ["AAA", "ZZZ"],
    );
    expect(summary.byTicker.has("ZZZ")).toBe(false);
    expect(summary.unavailable.has("ZZZ")).toBe(true);
  });

  test("a bar outside the window never stands in for a missing session", async () => {
    // Only a stale bar from two sessions earlier exists.
    const summary = await buildMarketSummary(
      { db: emptyDb, market: stubMarket([bar("AAA", "2026-07-30", 9)]) },
      dailyWindow,
      ["AAA"],
    );
    expect(summary.unavailable.has("AAA")).toBe(true);
  });

  test("broad-market indices are fetched alongside the user's tickers", async () => {
    const market = stubMarket([bar("SPY", "2026-07-31", 500), bar("SPY", "2026-08-03", 505)]);
    const summary = await buildMarketSummary({ db: emptyDb, market }, dailyWindow, ["AAA"]);
    expect(market.requested).toEqual(expect.arrayContaining(MARKET_INDICES.map((i) => i.symbol)));
    expect(summary.indices[0]!.label).toBe("S&P 500");
    expect(summary.indices[0]!.changePercent).toBeCloseTo(1, 6);
    // A missing index is omitted rather than reported as a broken ticker.
    expect(summary.unavailable.has("QQQ")).toBe(false);
  });

  test("one fetch serves every subscriber (tickers are deduped)", async () => {
    const market = stubMarket([]);
    await buildMarketSummary({ db: emptyDb, market }, dailyWindow, ["AAA", "aaa", "BBB"]);
    const watched = market.requested.filter((s) => !MARKET_INDICES.some((i) => i.symbol === s));
    expect(watched).toEqual(["AAA", "BBB"]);
  });

  test("a market-data outage is surfaced, not thrown", async () => {
    const broken = {
      ...stubMarket([]),
      getBars: async () => { throw new Error("alpaca 403"); },
    } as unknown as AlpacaMarketDataClient;
    const summary = await buildMarketSummary({ db: emptyDb, market: broken }, dailyWindow, ["AAA"]);
    expect(summary.marketError).toContain("403");
    expect(summary.unavailable.has("AAA")).toBe(true);
  });

  test("Yahoo-style opening-bell timestamps map to the same session", async () => {
    const yahooBars: MarketBar[] = [
      { ...bar("AAA", "2026-07-31", 10), timestamp: "2026-07-31T13:30:00Z" },
      { ...bar("AAA", "2026-08-03", 12), timestamp: "2026-08-03T13:30:00Z" },
    ];
    const summary = await buildMarketSummary(
      { db: emptyDb, market: stubMarket(yahooBars) },
      dailyWindow,
      ["AAA"],
    );
    expect(summary.byTicker.get("AAA")!.changePercent).toBeCloseTo(20, 6);
  });
});

describe("per-user slice", () => {
  const perf = (ticker: string, changePercent: number): Performance => ({
    ticker, sessions: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, changePercent,
  });

  const summary = {
    window: dailyWindow,
    indices: [],
    byTicker: new Map([
      ["AAA", perf("AAA", 1)],
      ["BBB", perf("BBB", -8)],
      ["CCC", perf("CCC", 4)],
    ]),
    unavailable: new Set(["DDD"]),
    headlines: new Map(),
    source: "test",
  };

  test("rows are ordered by the size of the move, direction aside", () => {
    const user = summaryForTickers(summary as any, ["AAA", "BBB", "CCC"]);
    expect(user.rows.map((r) => r.ticker)).toEqual(["BBB", "CCC", "AAA"]);
  });

  test("gainers and losers are split and sorted", () => {
    const user = summaryForTickers(summary as any, ["AAA", "BBB", "CCC"]);
    expect(user.gainers.map((r) => r.ticker)).toEqual(["CCC", "AAA"]);
    expect(user.losers.map((r) => r.ticker)).toEqual(["BBB"]);
  });

  test("a user only ever sees their own tickers", () => {
    const user = summaryForTickers(summary as any, ["AAA", "DDD"]);
    expect(user.rows.map((r) => r.ticker)).toEqual(["AAA"]);
    expect(user.unavailable).toEqual(["DDD"]);
  });
});

/* ---------------- rendering ---------------- */

describe("formatting", () => {
  test("sub-dollar prices keep four decimals — the house specialty", () => {
    expect(money(0.4231)).toBe("$0.4231");
    expect(money(12.5)).toBe("$12.50");
    expect(money(undefined)).toBe("—");
  });

  test("percentages are always signed", () => {
    expect(percent(3.456)).toBe("+3.46%");
    expect(percent(-3.4)).toBe("-3.40%");
    expect(percent(undefined)).toBe("—");
  });

  test("volume is abbreviated", () => {
    expect(volume(2_500_000)).toBe("2.5M");
    expect(volume(1_200_000_000)).toBe("1.2B");
    expect(volume(0)).toBe("—");
  });

  test("window labels name the session or the range", () => {
    expect(windowLabel(dailyWindow)).toBe("Monday, August 3, 2026");
    expect(windowLabel(weeklyWindow)).toBe("July 27, 2026 – July 31, 2026");
  });

  test("session dates are rendered in market terms, not the server's zone", () => {
    expect(formatSessionDate("2026-08-03")).toBe("Monday, August 3, 2026");
  });
});

describe("digest email", () => {
  const summary = {
    window: dailyWindow,
    indices: [{ ticker: "SPY", label: "S&P 500", sessions: 1, open: 1, high: 1, low: 1, close: 1, volume: 1, changePercent: 0.8 }],
    byTicker: new Map([
      ["AAA", { ticker: "AAA", companyName: "Alpha Corp", sessions: 1, open: 9, high: 11.4, low: 8.9, close: 11, volume: 2_000_000, previousClose: 10, changeAbs: 1, changePercent: 10 }],
      ["BBB", { ticker: "BBB", sessions: 1, open: 5, high: 5, low: 4, close: 4, volume: 500, previousClose: 5, changeAbs: -1, changePercent: -20 }],
    ]),
    unavailable: new Set(["ZZZ"]),
    headlines: new Map([["AAA", [{ ticker: "AAA", title: "Alpha lands a contract", url: "https://example.com/a", publisher: "Example Wire" }]]]),
    source: "iex",
  } as any;

  const ctx = { appUrl: "https://advis0r.com", unsubscribeToken: "tok-123", displayName: "Sam" };
  const user = summaryForTickers(summary, ["AAA", "BBB", "ZZZ"]);
  const msg = renderDigest(summary, user, ctx)!;

  test("renders both a text and an HTML body", () => {
    expect(msg.html).toContain("<!doctype html>");
    expect(msg.text.length).toBeGreaterThan(80);
  });

  test("the subject names the period and the biggest mover", () => {
    expect(msg.subject).toContain("Daily watchlist");
    expect(msg.subject).toContain("Monday, August 3, 2026");
    expect(msg.subject).toContain("BBB -20.00%"); // largest absolute move leads
  });

  test("every watched ticker appears in both bodies", () => {
    for (const body of [msg.html, msg.text]) {
      expect(body).toContain("AAA");
      expect(body).toContain("BBB");
      expect(body).toContain("+10.00%");
      expect(body).toContain("-20.00%");
    }
  });

  test("missing data is stated rather than hidden", () => {
    expect(msg.html).toContain("ZZZ");
    expect(msg.text).toContain("No market data this period for ZZZ");
  });

  test("carries a working unsubscribe link and one-click headers", () => {
    const url = unsubscribeUrl(ctx.appUrl, ctx.unsubscribeToken);
    expect(url).toBe("https://advis0r.com/unsubscribe?token=tok-123");
    expect(msg.html).toContain(url);
    expect(msg.text).toContain(url);
    expect(msg.headers!["List-Unsubscribe"]).toBe(`<${url}>`);
    expect(msg.headers!["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  test("carries the mandatory disclaimer", () => {
    expect(msg.html).toContain("research aid");
    expect(msg.text).toContain("research aid");
  });

  test("headlines are linked", () => {
    expect(msg.html).toContain("https://example.com/a");
    expect(msg.text).toContain("Alpha lands a contract");
  });

  test("hostile content in a company name or headline cannot inject markup", () => {
    const hostile = {
      ...summary,
      byTicker: new Map([
        ["AAA", { ...summary.byTicker.get("AAA"), companyName: `<script>alert(1)</script>` }],
      ]),
      headlines: new Map([["AAA", [{ ticker: "AAA", title: `"><img src=x onerror=alert(1)>`, url: "https://example.com/x" }]]]),
    };
    const out = renderDigest(hostile, summaryForTickers(hostile as any, ["AAA"]), ctx)!;
    // No attacker-supplied tag survives as markup; the text is still shown, inert.
    expect(out.html).not.toContain("<script");
    expect(out.html).not.toContain("<img");
    expect(out.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(out.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  test("nothing is sent when no watched ticker has data", () => {
    const blank = { ...summary, byTicker: new Map(), unavailable: new Set(["AAA"]) };
    expect(renderDigest(blank as any, summaryForTickers(blank as any, ["AAA"]), ctx)).toBeNull();
  });

  test("the weekly digest reports a range instead of a volume", () => {
    const weekly = { ...summary, window: weeklyWindow };
    const out = renderDigest(weekly, summaryForTickers(weekly as any, ["AAA"]), ctx)!;
    expect(out.subject).toContain("Weekly watchlist");
    expect(out.html).toContain("Range");
    expect(out.text).toContain("range");
  });

  test("the subject is stable when nothing moved", () => {
    const flat = {
      ...summary,
      byTicker: new Map([["AAA", { ticker: "AAA", sessions: 1, open: 1, high: 1, low: 1, close: 1, volume: 1 }]]),
    };
    expect(digestSubject(dailyWindow, summaryForTickers(flat as any, ["AAA"]))).toBe(
      "Daily watchlist: Monday, August 3, 2026",
    );
  });
});

/* ---------------- calendar helpers ---------------- */

describe("date arithmetic", () => {
  test("addDays crosses month and year boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(addDays("2028-02-28", 1)).toBe("2028-02-29"); // leap year
  });
});
