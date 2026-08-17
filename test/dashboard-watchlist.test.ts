/**
 * The watchlist tab — the real public/index.html and public/app.js, in a real DOM.
 *
 * Two things are being locked down. The first is that the tab is a *place*:
 * /watchlist is a path the server can answer and a link someone can send, and
 * the older /#watchlist form still lands there. The second is that the tab is a
 * dashboard rather than a list of links — summary tiles, one chart, and a table
 * whose sort, filter and range survive a reload, because they live in the URL
 * and in storage rather than in a variable that dies with the page.
 *
 * Hermetic like its crypto sibling: every request is answered from the fixtures
 * below, so the suite needs no server, no database and no market data, and
 * cannot go red because a price moved.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const read = (f: string) => readFileSync(join(PUBLIC_DIR, f), "utf8");

/* ---- Fixtures ---------------------------------------------------------- */

const ITEMS = [
  { ticker: "NVDA", note: "Discover “AI infrastructure” · #1", createdAt: "2026-06-01T00:00:00.000Z" },
  { ticker: "RIVN", createdAt: "2026-07-15T00:00:00.000Z" },
  { ticker: "ZZZZ", note: "no market data", createdAt: "2026-08-01T00:00:00.000Z" },
];

const spark = (from: number, to: number, n = 12) =>
  Array.from({ length: n }, (_, i) => Number((from + ((to - from) * i) / (n - 1)).toFixed(2)));

const overviewItem = (
  ticker: string,
  opts: Partial<Record<string, unknown>> = {},
) => ({
  ticker,
  note: ITEMS.find((i) => i.ticker === ticker)?.note,
  createdAt: ITEMS.find((i) => i.ticker === ticker)?.createdAt,
  companyName: null,
  classification: null,
  overallScore: null,
  confidence: null,
  signalCount: 0,
  sourceCount: 0,
  hasReport: false,
  price: null,
  priceAsOf: null,
  changes: [
    { label: "1D", percent: null },
    { label: "1W", percent: null },
    { label: "1M", percent: null },
    { label: "3M", percent: null },
    { label: "1Y", percent: null },
  ],
  rangePercent: null,
  high52: null,
  low52: null,
  fromHigh52: null,
  volume: null,
  avgVolume: null,
  relativeVolume: null,
  spark: [],
  barCount: 0,
  ...opts,
});

/** The 3M payload; the 1Y one differs so a range switch is observable. */
function overview(range: string) {
  const long = range === "1Y";
  return {
    range,
    rangeDays: long ? 365 : 90,
    asOf: "2026-08-14",
    source: "iex",
    items: [
      overviewItem("NVDA", {
        companyName: "NVIDIA Corporation",
        classification: "speculative",
        overallScore: 71.4,
        confidence: 62,
        signalCount: 12,
        sourceCount: 4,
        hasReport: true,
        reportGeneratedAt: "2026-08-14T12:00:00.000Z",
        price: 178.24,
        priceAsOf: "2026-08-14",
        changes: [
          { label: "1D", percent: 1.25 },
          { label: "1W", percent: 3.4 },
          { label: "1M", percent: 9.1 },
          { label: "3M", percent: 22.5 },
          { label: "1Y", percent: 140 },
        ],
        rangePercent: long ? 140 : 22.5,
        high52: 190,
        low52: 90,
        fromHigh52: -6.19,
        spark: spark(150, 178),
        barCount: 250,
      }),
      overviewItem("RIVN", {
        companyName: "Rivian Automotive, Inc.",
        classification: "high-risk speculative",
        overallScore: 44,
        confidence: 51,
        signalCount: 3,
        sourceCount: 1,
        hasReport: true,
        reportGeneratedAt: "2026-08-10T12:00:00.000Z",
        price: 12.06,
        priceAsOf: "2026-08-14",
        changes: [
          { label: "1D", percent: -2.4 },
          { label: "1W", percent: -5.1 },
          { label: "1M", percent: -8 },
          { label: "3M", percent: -14.75 },
          { label: "1Y", percent: -30 },
        ],
        rangePercent: long ? -30 : -14.75,
        high52: 20,
        low52: 10,
        fromHigh52: -39.7,
        spark: spark(15, 12),
        barCount: 250,
      }),
      overviewItem("ZZZZ"),
    ],
    stats: {
      count: 3,
      priced: 2,
      missing: ["ZZZZ"],
      gainers: 1,
      losers: 1,
      unchanged: 0,
      avgDayPercent: -0.575,
      medianDayPercent: -0.575,
      best: { ticker: "NVDA", percent: long ? 140 : 22.5 },
      worst: { ticker: "RIVN", percent: long ? -30 : -14.75 },
      bestDay: { ticker: "NVDA", percent: 1.25 },
      worstDay: { ticker: "RIVN", percent: -2.4 },
      avgScore: 57.7,
      scored: 2,
      withReports: 2,
      rangePercent: long ? 55 : 3.9,
      benchmarkPercent: long ? 18 : 2.1,
    },
    index: {
      points: [
        { t: "2026-05-16", value: 100 },
        { t: "2026-06-16", value: 104.2 },
        { t: "2026-07-16", value: 99.5 },
        { t: "2026-08-14", value: long ? 155 : 103.9 },
      ],
      benchmark: [
        { t: "2026-05-16", value: 100 },
        { t: "2026-06-16", value: 101.1 },
        { t: "2026-07-16", value: 100.4 },
        { t: "2026-08-14", value: long ? 118 : 102.1 },
      ],
      benchmarkSymbol: "SPY",
      benchmarkLabel: "S&P 500 (SPY)",
      members: ["NVDA", "RIVN"],
      excluded: ["ZZZZ"],
    },
  };
}

let watchlistRequests: Array<{ method: string; url: string; body?: string }> = [];

function respond(rawUrl: string): unknown {
  const url = new URL(rawUrl, "http://localhost");
  const p = url.pathname;
  if (p === "/health") return { ok: true };
  if (p === "/api/stats") return { documents: 1, signals: 2, transcripts: 3, analyses: 4 };
  if (p === "/api/topics") return { topics: ["AI infrastructure"] };
  if (p === "/api/discover") return { candidates: [], disclaimer: "" };
  if (p === "/api/auth/me") return { user: { id: "u1", email: "a@b.com", emailVerified: true } };
  if (p === "/api/credits") return { balance: 100, monthlyFree: 100 };
  if (p === "/api/digest") return { frequency: "daily", nextSendAt: "2026-08-18T08:00:00.000Z" };
  if (p === "/api/watchlist/overview") return overview(url.searchParams.get("range") ?? "3M");
  if (p === "/api/watchlist") return { items: ITEMS };
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
const rows = () => $$(".wl-table tbody tr").map((r: any) => r.dataset.ticker);
const cell = (ticker: string, nth: number) =>
  $$(`.wl-table tbody tr`).find((r: any) => r.dataset.ticker === ticker)?.children[nth]?.textContent?.trim();

async function loadPage(where = "/watchlist") {
  pageErrors = [];
  watchlistRequests = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e: Error) => pageErrors.push(e.message));
  vc.on("error", (...a: unknown[]) => pageErrors.push(a.join(" ")));

  dom = new JSDOM(read("index.html"), {
    url: `http://localhost${where}`,
    runScripts: "outside-only",
    pretendToBeVisual: true,
    virtualConsole: vc,
  });
  win = dom.window as any;
  win.LightweightCharts = null;
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.alert = () => {};
  win.fetch = async (input: any, init: any = {}) => {
    const u = String(input?.url ?? input);
    const method = String(init.method ?? "GET");
    if (u.includes("/api/watchlist")) watchlistRequests.push({ method, url: u, body: init.body });
    return {
      ok: true, status: 200,
      json: async () => respond(u),
      text: async () => JSON.stringify(respond(u)),
    };
  };

  win.eval([read("app.js"), read("auth.js")].join("\n;\n"));
  await sleep(200);
}

beforeEach(async () => { await loadPage(); });
afterEach(() => { try { win?.close(); } catch {} });

/* ---- Tests -------------------------------------------------------------- */

describe("routing", () => {
  test("the page evaluates without errors", () => {
    expect(pageErrors).toEqual([]);
  });

  test("/watchlist opens the watchlist tab", () => {
    expect($('.view[data-view="watchlist"]').classList.contains("active")).toBe(true);
    const tab = $$("#tabs button").find((b: any) => b.dataset.view === "watchlist");
    expect(tab.classList.contains("active")).toBe(true);
  });

  test("the older /#watchlist link still lands there, and drops the fragment", async () => {
    await loadPage("/#watchlist");
    expect($('.view[data-view="watchlist"]').classList.contains("active")).toBe(true);
    expect(win.location.pathname).toBe("/watchlist");
  });

  test("an unknown path falls back to Discover", async () => {
    await loadPage("/not-a-tab");
    expect($('.view[data-view="discover"]').classList.contains("active")).toBe(true);
  });

  test("switching tabs writes the path, and Back returns", async () => {
    click($$("#tabs button").find((b: any) => b.dataset.view === "search"));
    expect(win.location.pathname).toBe("/search");
    win.history.back();
    await sleep(60);
    expect(win.location.pathname).toBe("/watchlist");
    expect($('.view[data-view="watchlist"]').classList.contains("active")).toBe(true);
  });
});

describe("summary statistics", () => {
  test("renders a tile per headline number", () => {
    const tiles = $$(".wl-stat");
    expect(tiles.length).toBe(6);
    const labels = tiles.map((t: any) => t.querySelector(".wl-stat-lab").textContent);
    expect(labels).toContain("Tickers");
    expect(labels).toContain("Best");
    expect(labels).toContain("3M equal-weight");
  });

  test("signs the numbers and says what they are measured against", () => {
    const tile = (label: string) =>
      $$(".wl-stat").find((t: any) => t.querySelector(".wl-stat-lab").textContent === label);
    // -0.575 is not exactly representable, so it rounds down at two places.
    expect(tile("Last session").querySelector(".wl-stat-val").textContent).toBe("-0.57%");
    expect(tile("Last session").querySelector(".wl-stat-val").classList.contains("neg")).toBe(true);
    expect(tile("Last session").querySelector(".wl-stat-sub").textContent).toBe("1 up · 1 down");
    expect(tile("3M equal-weight").querySelector(".wl-stat-sub").textContent).toContain("SPY +2.1%");
    expect(tile("Best").textContent).toContain("NVDA");
    expect(tile("Tickers").querySelector(".wl-stat-sub").textContent).toContain("without data");
  });
});

describe("the index chart", () => {
  test("draws both series, rebased, with a legend and direct labels", () => {
    const paths = $$("#wl-chart .wl-line");
    expect(paths.length).toBe(2);
    // Identity never rests on colour alone: the benchmark is dashed as well.
    expect(paths[1].getAttribute("stroke-dasharray")).toBeTruthy();
    const labels = $$("#wl-chart .wl-endlab").map((t: any) => t.textContent);
    expect(labels[0]).toContain("Watchlist");
    expect(labels[1]).toContain("SPY");
    const legend = text("#wl-chart-legend");
    expect(legend).toContain("Watchlist");
    expect(legend).toContain("SPY");
    expect(legend).toContain("+3.9%");
  });

  test("says how many tickers are in the line and which were left out", () => {
    const note = text("#wl-chart-note");
    expect(note).toContain("2 tickers");
    expect(note).toContain("ZZZZ");
  });

  test("a baseline marks the rebasing point", () => {
    expect($("#wl-chart .wl-base")).toBeTruthy();
  });
});

describe("the table", () => {
  test("renders a row per saved ticker, including the unpriced one", () => {
    expect(rows()).toHaveLength(3);
    expect(rows()).toContain("ZZZZ");
  });

  test("shows price, changes and company for a priced row", () => {
    const row = $$(".wl-table tbody tr").find((r: any) => r.dataset.ticker === "NVDA");
    expect(row.textContent).toContain("NVIDIA Corporation");
    expect(row.textContent).toContain("$178.24");
    expect(row.textContent).toContain("+1.25%");
    expect(row.querySelector(".wl-spark")).toBeTruthy();
    expect(row.querySelector(".wl-score").textContent).toBe("71");
  });

  test("an unpriced row shows gaps rather than invented numbers", () => {
    const row = $$(".wl-table tbody tr").find((r: any) => r.dataset.ticker === "ZZZZ");
    expect(row.textContent).toContain("—");
    expect(row.textContent).not.toContain("$");
    expect(row.querySelector(".wl-spark")).toBeNull();
  });

  test("the ticker is a link to its shareable report page", () => {
    const link = $$(".wl-table .wl-tick").find((a: any) => a.textContent === "RIVN");
    expect(link.getAttribute("href")).toBe("/stocks/RIVN");
  });

  test("sorts by the range column, biggest first, by default", () => {
    expect(rows()).toEqual(["NVDA", "RIVN", "ZZZZ"]);
  });

  test("clicking a header sorts by it, and clicking again reverses", () => {
    click($$(".wl-sort").find((b: any) => b.dataset.sort === "d1"));
    expect(rows()).toEqual(["NVDA", "RIVN", "ZZZZ"]);
    click($$(".wl-sort").find((b: any) => b.dataset.sort === "d1"));
    // Ascending puts the worst first — but the row with no data stays last,
    // because "unknown" is not "smallest".
    expect(rows()).toEqual(["RIVN", "NVDA", "ZZZZ"]);
  });

  test("text columns sort A-Z on first click", () => {
    click($$(".wl-sort").find((b: any) => b.dataset.sort === "ticker"));
    expect(rows()).toEqual(["NVDA", "RIVN", "ZZZZ"]);
    click($$(".wl-sort").find((b: any) => b.dataset.sort === "ticker"));
    expect(rows()).toEqual(["ZZZZ", "RIVN", "NVDA"]);
  });

  test("the sorted column is marked for assistive tech", () => {
    click($$(".wl-sort").find((b: any) => b.dataset.sort === "price"));
    const th = $$(".wl-table thead th").find((h: any) => h.querySelector('[data-sort="price"]'));
    expect(th.getAttribute("aria-sort")).toBe("descending");
  });
});

describe("filtering", () => {
  test("the filter box matches ticker, company and note", async () => {
    const box = $("#wl-filter");
    box.value = "rivian";
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(rows()).toEqual(["RIVN"]);

    box.value = "AI infrastructure";
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect(rows()).toEqual(["NVDA"]);
    expect(text("#wl-count")).toBe("1 of 3");
  });

  test("the risk-class chips are built from the classes actually present", () => {
    const chips = $$("#wl-classes button").map((b: any) => b.dataset.class);
    expect(chips).toEqual(["all", "speculative", "high-risk speculative"]);
    click($$("#wl-classes button").find((b: any) => b.dataset.class === "speculative"));
    expect(rows()).toEqual(["NVDA"]);
  });

  test("a filter that matches nothing says so instead of rendering an empty table", () => {
    const box = $("#wl-filter");
    box.value = "nothing matches this";
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
    expect($(".wl-table")).toBeNull();
    expect(text("#my-list")).toContain("No rows match");
  });
});

describe("the range control", () => {
  test("defaults to 3M and labels the column with it", () => {
    expect($$("#wl-ranges button").find((b: any) => b.classList.contains("on")).dataset.range).toBe("3M");
    expect($$(".wl-sort").find((b: any) => b.dataset.sort === "range").textContent).toContain("3M");
  });

  test("switching to 1Y refetches and redraws from the longer window", async () => {
    click($$("#wl-ranges button").find((b: any) => b.dataset.range === "1Y"));
    await sleep(120);
    expect(watchlistRequests.some((r) => r.url.includes("range=1Y"))).toBe(true);
    expect(cell("NVDA", 6)).toBe("+140.0%");
    expect($$(".wl-sort").find((b: any) => b.dataset.sort === "range").textContent).toContain("1Y");
  });
});

describe("state that survives a reload", () => {
  test("sort, filter and range are written to the URL", async () => {
    click($$(".wl-sort").find((b: any) => b.dataset.sort === "ticker"));
    const box = $("#wl-filter");
    box.value = "riv";
    box.dispatchEvent(new win.Event("input", { bubbles: true }));
    click($$("#wl-ranges button").find((b: any) => b.dataset.range === "6M"));
    await sleep(60);
    const params = new URLSearchParams(win.location.search);
    expect(win.location.pathname).toBe("/watchlist");
    expect(params.get("sort")).toBe("ticker");
    expect(params.get("dir")).toBe("asc");
    expect(params.get("q")).toBe("riv");
    expect(params.get("range")).toBe("6M");
  });

  test("a link carrying that state opens the table already configured", async () => {
    await loadPage("/watchlist?sort=ticker&dir=desc&q=riv&range=1Y");
    expect(rows()).toEqual(["RIVN"]);
    expect($$("#wl-ranges button").find((b: any) => b.classList.contains("on")).dataset.range).toBe("1Y");
    expect(watchlistRequests.some((r) => r.url.includes("range=1Y"))).toBe(true);
  });
});

describe("membership", () => {
  test("Remove deletes through the API and takes the row with it", async () => {
    const row = $$(".wl-table tbody tr").find((r: any) => r.dataset.ticker === "RIVN");
    click(row.querySelector(".wl-remove"));
    await sleep(80);
    const del = watchlistRequests.find((r) => r.method === "DELETE");
    expect(del).toBeTruthy();
    expect(JSON.parse(del!.body!)).toEqual({ ticker: "RIVN" });
  });

  test("the summary line names its source and its date", () => {
    const summary = text("#my-summary");
    expect(summary).toContain("3 saved");
    expect(summary).toContain("iex");
    expect(summary).toContain("2026-08-14");
    expect(summary).toContain("ZZZZ");
  });

  test("the dashboard is hidden when nothing is saved", async () => {
    // Same page, an empty list: the prompt should be all there is.
    const original = win.fetch;
    win.fetch = async (input: any, init: any = {}) => {
      const u = String(input?.url ?? input);
      if (u.includes("/api/watchlist/overview")) {
        return { ok: true, status: 200, json: async () => ({ ...overview("3M"), items: [], index: null }) };
      }
      if (u.includes("/api/watchlist")) return { ok: true, status: 200, json: async () => ({ items: [] }) };
      return original(input, init);
    };
    win.dispatchEvent(new win.CustomEvent("advis0r:auth-changed"));
    await sleep(120);
    expect($("#wl-dash").hasAttribute("hidden")).toBe(true);
    expect(text("#my-list")).toContain("Nothing saved yet");
  });
});
