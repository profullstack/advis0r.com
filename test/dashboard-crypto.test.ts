/**
 * Crypto dashboard tab — the real public/index.html and public/app.js, driven
 * in a real DOM.
 *
 * This is the project's first frontend test, and it exists because the crypto
 * tab reuses the stock side's machinery rather than copying it: `attachLookup`
 * now serves both the ticker boxes and the crypto picker, and the crypto modal
 * mounts the same charts. That reuse is the right call, but it means a change
 * made for one surface can silently break the other — so the equity lookup is
 * asserted here too, not just the crypto path.
 *
 * Hermetic on purpose. Every request is answered from the fixtures below, so
 * the suite never needs a server, a database, or Alpaca credentials, and it
 * cannot go red because a crypto price moved. What it checks is the page's own
 * logic: routing, formatting, rendering, and wiring.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const read = (f: string) => readFileSync(join(PUBLIC_DIR, f), "utf8");

/* ---- Fixtures ---------------------------------------------------------- */

const bar = (t: string, close: number, i = 0) => ({
  symbol: "BTC/USD", timestamp: t, open: close - 1, high: close + 1, low: close - 2,
  close, volume: 10 + i, vwap: close, timeframe: "1Day", adjustment: "raw",
});

const snapshot = (symbol: string, price: number, prev: number) => {
  const [base, quote] = symbol.split("/");
  return {
    symbol, base, quote, name: { BTC: "Bitcoin", ETH: "Ethereum", DOGE: "Dogecoin" }[base!] ?? base,
    latestTrade: { symbol, price, size: 1, timestamp: "2026-08-06T13:00:00Z" },
    latestQuote: {
      symbol, bidPrice: price * 0.9995, bidSize: 1, askPrice: price * 1.0005, askSize: 1,
      timestamp: "2026-08-06T13:00:00Z",
    },
    dailyBar: { symbol, timestamp: "2026-08-06T00:00:00Z", open: prev, high: price * 1.01, low: price * 0.99, close: price, volume: 12.5, timeframe: "1Day", adjustment: "raw" },
    prevDailyBar: { symbol, timestamp: "2026-08-05T00:00:00Z", open: prev, high: prev, low: prev, close: prev, volume: 9, timeframe: "1Day", adjustment: "raw" },
    feed: "us", delayed: false, fetchedAt: "2026-08-06T13:00:00Z",
    change: { absolute: price - prev, percent: ((price - prev) / prev) * 100 },
  };
};

const CRYPTO_DISCLAIMER =
  "This output is generated from public market data and automated analysis. " +
  "Digital assets are unregulated in many jurisdictions, trade 24/7 without circuit breakers, " +
  "and may be extremely volatile, thinly traded, or subject to manipulation and total loss.";

const CAVEATS = [
  "Volume, relativeVolume and avgDollarVolume reflect Alpaca's US crypto venue alone, not aggregate market volume — the liquidity component of the score is not comparable to an equity's.",
  "52-week and moving-average windows count calendar days: crypto trades 24/7, so a 200-day window here spans less market activity per bar than 200 equity sessions.",
];

/** Prices chosen to span the formatter's precision bands: $60k down to $0.06. */
const GRID_PRICES: Record<string, [number, number]> = {
  "BTC/USD": [64250.5, 64000], "ETH/USD": [1895.5, 1900], "SOL/USD": [72.95, 72],
  "XRP/USD": [0.8204, 0.82], "DOGE/USD": [0.06893, 0.07], "ADA/USD": [0.20556, 0.2],
  "LINK/USD": [11.23, 11], "AVAX/USD": [14.5, 14.4], "LTC/USD": [62.1, 62],
  "DOT/USD": [3.15, 3.2], "BCH/USD": [402.5, 400], "MATIC/USD": [0.19233, 0.19],
};

/** Routes the page's requests to canned payloads. Unknown paths get `{}`. */
function respond(rawUrl: string): unknown {
  const url = new URL(rawUrl, "http://localhost");
  const p = url.pathname;
  const symbols = (url.searchParams.get("symbols") ?? url.searchParams.get("symbol") ?? "").split(",");

  if (p === "/health") return { ok: true };
  if (p === "/api/stats") return { documents: 1, signals: 2, transcripts: 3, analyses: 4 };
  if (p === "/api/topics") return { topics: ["AI infrastructure"] };
  if (p === "/api/discover") return { candidates: [], disclaimer: "" };
  if (p === "/api/auth/me") return { user: null };

  if (p === "/crypto/snapshot") {
    return {
      snapshots: symbols.map((s) => {
        const [price, prev] = GRID_PRICES[s] ?? [1, 1];
        return snapshot(s, price, prev);
      }),
      disclaimer: CRYPTO_DISCLAIMER,
    };
  }
  if (p === "/crypto/report") {
    return {
      symbol: "BTC/USD", slug: "BTC-USD", name: "Bitcoin", base: "BTC", quote: "USD",
      snapshot: snapshot("BTC/USD", 64250.5, 64000),
      technical: {
        symbol: "BTC/USD", asOf: "2026-08-06T00:00:00Z", lastClose: 64250.5,
        sma: { 20: 64381.3, 50: 63231.8, 200: 70510.2 }, ema: { 9: 63984.1, 21: 64004.5 },
        rsi14: 50.74, macd: { macd: -9.5, signal: 21.4, histogram: -30.9 },
        bollinger: { upper: 66274.8, middle: 64381.3, lower: 62487.8 },
        atr14: 1553.1, vwap: 64657.1, relativeVolume: 0.24, avgDailyVolume: 1.45,
        avgDollarVolume: 93047.3, momentum: { 20: 0.4, 60: 1.33, 120: -9.73 },
        distanceFrom52WeekHigh: -34.5, distanceFrom52WeekLow: 11.1,
        goldenCross: false, deathCross: true, breakout: false, breakdown: false,
        gapPercent: 0.03, trend: "bearish", volatilityRegime: "normal",
      },
      technicalScore: { symbol: "BTC/USD", score: 22.67, breakdown: {}, horizonQuarters: 2 },
      caveats: CAVEATS,
      generatedAt: "2026-08-06T13:00:00Z",
      disclaimer: CRYPTO_DISCLAIMER,
    };
  }
  if (p === "/crypto/bars") {
    return {
      timeframe: "1Day",
      bars: { "BTC/USD": Array.from({ length: 30 }, (_, i) => bar(`2026-07-0${(i % 9) + 1}T00:00:00Z`, 64000 + i * 10, i)) },
      disclaimer: CRYPTO_DISCLAIMER,
    };
  }
  if (p === "/crypto/orderbook") {
    return {
      orderbooks: [{
        symbol: "BTC/USD", timestamp: "2026-08-06T13:00:00Z",
        bids: Array.from({ length: 12 }, (_, i) => ({ price: 64200 - i, size: 0.5 })),
        asks: Array.from({ length: 12 }, (_, i) => ({ price: 64300 + i, size: 0.5 })),
      }],
      disclaimer: CRYPTO_DISCLAIMER,
    };
  }
  if (p === "/crypto/lookup") {
    return {
      query: url.searchParams.get("q"),
      matches: [
        { symbol: "BTC/USD", slug: "BTC-USD", base: "BTC", quote: "USD", name: "Bitcoin" },
        { symbol: "BTC/USDC", slug: "BTC-USDC", base: "BTC", quote: "USDC", name: "Bitcoin" },
      ],
    };
  }
  if (p === "/api/lookup") {
    return {
      query: url.searchParams.get("q"),
      matches: [{ symbol: "RIVN", name: "Rivian Automotive, Inc.", exchange: "NASDAQ", hasReport: true }],
    };
  }
  return {};
}

/* ---- Harness ------------------------------------------------------------ */

let dom: JSDOM;
let win: any;
let pageErrors: string[] = [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (sel: string) => win.document.querySelector(sel);
const $$ = (sel: string) => [...win.document.querySelectorAll(sel)];
const text = (sel: string) => $(sel)?.textContent ?? "";
const click = (el: any) => el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const type = (el: any, value: string) => {
  el.value = value;
  el.dispatchEvent(new win.Event("input", { bubbles: true }));
};
/** Cards are addressed by their destination now that they are links. */
const cardFor = (pair: string) =>
  $$(".cxcard").find((c: any) => c.getAttribute("href") === `/crypto/${pair.replace("/", "-")}`);

/** `where` is anything after the origin: "#crypto", "?pair=BTC-USD". */
async function loadPage(where = "#crypto") {
  pageErrors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e: Error) => pageErrors.push(e.message));
  vc.on("error", (...a: unknown[]) => pageErrors.push(a.join(" ")));

  dom = new JSDOM(read("index.html"), {
    url: `http://localhost/${where}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  win = dom.window as any;

  // The chart vendor is a browser-only global that needs a canvas; the page
  // already no-ops when it is absent, and charts are not what this file tests.
  win.LightweightCharts = null;
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.alert = () => {};
  win.fetch = async (input: any) => {
    const u = String(input?.url ?? input);
    return {
      ok: true, status: 200,
      json: async () => respond(u),
      text: async () => JSON.stringify(respond(u)),
    };
  };

  // Concatenated rather than evaluated separately: in a browser, top-level
  // `const`/`let` from separate <script> tags share one global lexical scope,
  // but each eval() call would get its own — auth.js's state would be
  // invisible to app.js's handlers, which is a harness artifact, not a bug.
  win.eval([read("app.js"), read("auth.js")].join("\n;\n"));
  await sleep(150); // boot() + the tab's first fetch
}

beforeEach(async () => { await loadPage(); });
afterEach(() => { try { win?.close(); } catch {} });

/* ---- Tests -------------------------------------------------------------- */

describe("crypto tab", () => {
  test("the page evaluates without errors", () => {
    expect(pageErrors).toEqual([]);
  });

  test("#crypto routes straight to the tab", () => {
    const tab = $$("#tabs button").find((b: any) => b.dataset.view === "crypto");
    expect(tab).toBeTruthy();
    expect(tab.classList.contains("active")).toBe(true);
    expect($('.view[data-view="crypto"]').classList.contains("active")).toBe(true);
  });

  test("the grid renders one card per pair", () => {
    const cards = $$(".cxcard");
    expect(cards.length).toBe(12);
    expect(text("#cx-summary")).toContain("12 pairs");
    expect(text("#cx-summary")).toContain("Alpaca US crypto venue");
  });

  test("every card is a real link to a shareable page", () => {
    // The regression this locks down: these were <button>s that opened a modal,
    // so the URL never changed and there was nothing to copy or crawl.
    const cards = $$(".cxcard");
    expect(cards.every((c: any) => c.tagName === "A")).toBe(true);
    expect(cards.map((c: any) => c.getAttribute("href"))).toContain("/crypto/BTC-USD");
    expect(cards.every((c: any) => /^\/crypto\/[A-Z0-9]+-[A-Z]+$/.test(c.getAttribute("href")))).toBe(true);
  });

  test("prices keep precision across four orders of magnitude", () => {
    const priceOf = (pair: string) => cardFor(pair)?.querySelector(".cx-price")?.textContent;
    // The bug this guards: a fixed 2dp renders DOGE as "$0.00".
    expect(priceOf("BTC/USD")).toBe("$64,250.50");
    expect(priceOf("DOGE/USD")).toBe("$0.06893");
    expect(priceOf("MATIC/USD")).toBe("$0.19233");
    expect(priceOf("SOL/USD")).toBe("$72.9500");
  });

  test("direction is shown as a signed percent and a card modifier", () => {
    const up = cardFor("BTC/USD");
    const down = cardFor("ETH/USD");
    expect(up.classList.contains("positive")).toBe(true);
    expect(up.querySelector(".cx-sub").textContent).toContain("+0.39%");
    expect(down.classList.contains("negative")).toBe(true);
    expect(down.querySelector(".cx-sub").textContent).toContain("-0.24%");
  });

  test("a pair with no data at all is dropped rather than rendered blank", async () => {
    // A card showing "—" for every field is worse than no card.
    const cards = $$(".cxcard");
    for (const c of cards) expect(c.querySelector(".cx-price").textContent).not.toBe("—");
  });
});

/**
 * The modal is no longer how you reach a pair — cards link to pages now. It
 * survives as the in-app interactive chart, reached from the page via
 * "Open the interactive chart" (/?pair=BTC-USD), so it is still worth testing.
 */
describe("crypto interactive view", () => {
  beforeEach(async () => {
    // Reached the way a person reaches it: the link on the rendered page.
    await loadPage("?pair=BTC-USD");
    await sleep(350);
  });

  test("opens and finishes loading", () => {
    expect($("#detail").classList.contains("hidden")).toBe(false);
    expect(text("#detail-panel")).not.toContain("Loading BTC/USD");
    expect(text("#detail-panel")).toContain("BTC/USD");
    expect(text("#detail-panel")).toContain("Bitcoin");
  });

  test("shows market, technicals and the order book", () => {
    const panel = text("#detail-panel");
    expect(panel).toContain("Spread");
    expect(panel).toContain("RSI(14)");
    expect(panel).toContain("Order book");
    // depth=8 is requested and enforced in the render, so a 12-deep book trims.
    expect($$("#detail-panel .ob-row.bid").length).toBe(8);
    expect($$("#detail-panel .ob-row.ask").length).toBe(8);
  });

  test("carries the venue-volume caveat and the crypto disclaimer", () => {
    const panel = text("#detail-panel");
    // Publishing a liquidity score without this note invites it to be read as
    // illiquidity, when it only reflects Alpaca's own venue.
    expect(panel).toContain("US crypto venue alone");
    expect(panel).toContain("circuit breakers");
  });

  test("omits the SEC block, which cannot exist for a digital asset", () => {
    expect(text("#detail-panel")).not.toContain("Fundamentals (SEC)");
  });
});

describe("crypto lookup", () => {
  test("typing a name offers pairs", async () => {
    type($("#cx-find"), "bitcoin");
    await sleep(400);
    const rows = $$("#cx-find-results .lookup-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].querySelector(".lookup-sym").textContent).toBe("BTC/USD");
    // The crypto directory has no exchange column; it shows the quote instead.
    expect(rows[0].querySelector(".lookup-meta").textContent.trim()).toBe("USD");
  });

  test("picking a row navigates away instead of opening a modal", async () => {
    // jsdom locks `location` down completely — it cannot be stubbed, and its
    // "Not implemented: navigation to another Document" error does not name the
    // destination. So this asserts the behaviour change that matters (it left
    // the page rather than opening an unshareable modal); the *destination* is
    // covered by the card-href test above, which reads a real href.
    type($("#cx-find"), "bitcoin");
    await sleep(400);
    $("#cx-find-results .lookup-row").dispatchEvent(
      new win.MouseEvent("mousedown", { bubbles: true }),
    );
    await sleep(250);
    expect(pageErrors.join(" ")).toContain("navigation to another Document");
    expect($("#detail").classList.contains("hidden")).toBe(true);
  });
});

/**
 * `attachLookup` is shared with the ticker boxes. These assertions are the
 * reason this file is worth having: they fail if the crypto options argument
 * ever changes the default behaviour the stock side depends on.
 */
describe("equity surfaces still work after the shared-lookup refactor", () => {
  test("the ticker lookup still resolves company names", async () => {
    type($("#sig-ticker"), "rivian");
    await sleep(400);
    const rows = $$("#sig-ticker-results .lookup-row");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0].querySelector(".lookup-sym").textContent).toBe("RIVN");
  });

  test("the ticker lookup still renders its exchange + report meta column", async () => {
    type($("#sig-ticker"), "rivian");
    await sleep(400);
    const meta = $("#sig-ticker-results .lookup-row .lookup-meta").textContent;
    expect(meta).toContain("NASDAQ");
    expect(meta).toContain("report");
  });

  test("the watchlist lookup still works", async () => {
    type($("#my-add"), "rivian");
    await sleep(400);
    expect($$("#my-add-results .lookup-row").length).toBeGreaterThan(0);
  });

  test("every tab still activates", () => {
    for (const view of ["discover", "watchlist", "search", "signals", "crypto", "about"]) {
      click($$("#tabs button").find((b: any) => b.dataset.view === view));
      expect($(`.view[data-view="${view}"]`).classList.contains("active")).toBe(true);
    }
  });
});

describe("deep links", () => {
  test("?pair=BTC-USD opens that pair on the crypto tab", async () => {
    win?.close();
    const prev = respond;
    dom = new JSDOM(read("index.html"), {
      url: "http://localhost/?pair=BTC-USD",
      runScripts: "outside-only",
      pretendToBeVisual: true,
    });
    win = dom.window as any;
    win.LightweightCharts = null;
    win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
    win.alert = () => {};
    win.fetch = async (input: any) => ({
      ok: true, status: 200,
      json: async () => prev(String(input?.url ?? input)),
      text: async () => JSON.stringify(prev(String(input?.url ?? input))),
    });
    win.eval([read("app.js"), read("auth.js")].join("\n;\n"));
    await sleep(400);
    expect($('.view[data-view="crypto"]').classList.contains("active")).toBe(true);
    expect(text("#detail-panel")).toContain("BTC/USD");
  });
});
