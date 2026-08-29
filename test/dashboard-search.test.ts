/**
 * Search tab — the real public/index.html and public/app.js, driven in a real DOM.
 *
 * The tab's whole design is a routing decision made in the browser: one box
 * that decides, from what you typed, whether to search transcripts, search the
 * web, or fetch a pasted page. That decision is not visible in any API test,
 * so it is pinned here.
 *
 * Two behaviours matter more than the rendering and are asserted directly:
 *
 *  - **A dead web search must not take the transcripts down with it.** Web
 *    search runs on a metered third-party budget that will empty; when it
 *    answers 402 the tab still has to show what it got for free.
 *  - **The server's explanation has to reach the reader.** "Credits are
 *    exhausted" is actionable; "failed (402)" is not.
 *
 * Hermetic: every request is answered from the fixtures below, so this never
 * needs a server, a key, or a credit.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { JSDOM, VirtualConsole } from "jsdom";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PUBLIC_DIR = join(import.meta.dir, "..", "public");
const read = (f: string) => readFileSync(join(PUBLIC_DIR, f), "utf8");

/* ---- Fixtures ---------------------------------------------------------- */

const WEB_RESPONSE = {
  kind: "web",
  query: "ai infrastructure",
  pages: 1,
  cached: false,
  results: [
    {
      title: "Data center buildout accelerates",
      url: "https://www.reuters.com/tech/buildout",
      host: "reuters.com",
      tier: 1,
      tierLabel: "reputable press",
      publisher: "reuters.com",
      snippet: "Operators are racing to add capacity.",
      publishedAt: "2026-08-27",
    },
    {
      title: "Inside the data center buildout",
      url: "https://www.cnbc.com/2026/08/28/inside",
      host: "cnbc.com",
      tier: 1,
      tierLabel: "reputable press",
      publisher: "cnbc.com",
      snippet: "A tour of the power problem.",
    },
  ],
  trending: ["ai infrastructure stocks", "data center reits"],
  questions: ["What counts as AI infrastructure?"],
  phrases: [{ phrase: "data center buildout", count: 2, words: 3 }],
  niches: [
    { label: "data center buildout", count: 2, hosts: ["reuters.com", "cnbc.com"], members: [0, 1] },
  ],
  sources: [
    { host: "reuters.com", count: 1, tier: 1, tierLabel: "reputable press" },
    { host: "cnbc.com", count: 1, tier: 1, tierLabel: "reputable press" },
  ],
  creditsRemaining: 24113,
};

const PARSE_RESPONSE = {
  url: "https://www.cnbc.com/2026/08/28/inside",
  host: "cnbc.com",
  tier: 1,
  tierLabel: "reputable press",
  ok: true,
  cached: false,
  meta: {
    title: "Inside the data center buildout",
    description: "A tour of the power problem.",
    siteName: "CNBC",
    author: "A Reporter",
    publishedAt: "2026-08-28T11:00:00.000Z",
    keywords: ["data centers", "power"],
    headings: ["The power problem", "What comes next"],
    feeds: ["https://www.cnbc.com/id/100003114/device/rss/rss.html"],
  },
  phrases: [{ phrase: "data center", count: 4, words: 2 }],
  tickers: [
    { symbol: "NVDA", name: "NVIDIA Corporation", hasReport: true },
    { symbol: "SOUN", hasReport: false },
  ],
  textLength: 4200,
  wordCount: 700,
  excerpt: "The buildout is limited by power, not by chips.",
};

const TRANSCRIPTS_RESPONSE = {
  query: "ai infrastructure",
  results: [
    {
      ticker: "RIVN",
      event_date: "2026-05-01",
      speaker: "CEO",
      text: "We are expanding our compute footprint this year.",
    },
  ],
};

/* ---- Harness ------------------------------------------------------------ */

let dom: JSDOM;
let win: any;
let pageErrors: string[] = [];
let requests: string[] = [];
/** Per-path status overrides, so error paths (402, 503) can be exercised. */
let failures: Record<string, { status: number; body: unknown }> = {};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const $ = (sel: string) => win.document.querySelector(sel);
const $$ = (sel: string) => [...win.document.querySelectorAll(sel)];
const text = (sel: string) => $(sel)?.textContent ?? "";
const click = (el: any) => el?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
const sent = (fragment: string) => requests.some((u) => u.includes(fragment));

function respond(rawUrl: string): unknown {
  const url = new URL(rawUrl, "http://localhost");
  const p = url.pathname;
  if (p === "/health") return { ok: true };
  if (p === "/api/stats") return { documents: 1, signals: 2, transcripts: 3, analyses: 4 };
  if (p === "/api/topics") return { topics: ["AI infrastructure"] };
  if (p === "/api/discover") return { candidates: [], disclaimer: "" };
  if (p === "/api/auth/me") return { user: null };
  if (p === "/api/search") return TRANSCRIPTS_RESPONSE;
  if (p === "/api/web") return { ...WEB_RESPONSE, kind: url.searchParams.get("kind") ?? "web" };
  if (p === "/api/parse") return { ...PARSE_RESPONSE, url: url.searchParams.get("url") };
  return {};
}

/** Type into the search box and run it. */
async function search(query: string, opts: { mode?: string; time?: string } = {}) {
  $("#sq").value = query;
  if (opts.mode) $("#sq-mode").value = opts.mode;
  if (opts.time) $("#sq-time").value = opts.time;
  requests = [];
  click($("#sq-run"));
  await sleep(60);
}

async function loadPage(where = "search") {
  pageErrors = [];
  requests = [];
  failures = {};
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
  win.LightweightCharts = null;
  win.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  win.alert = () => {};
  win.fetch = async (input: any) => {
    const u = String(input?.url ?? input);
    requests.push(u);
    const path = new URL(u, "http://localhost").pathname;
    const failure = failures[path];
    if (failure) {
      return {
        ok: false,
        status: failure.status,
        json: async () => failure.body,
        text: async () => JSON.stringify(failure.body),
      };
    }
    return { ok: true, status: 200, json: async () => respond(u), text: async () => JSON.stringify(respond(u)) };
  };

  win.eval([read("app.js"), read("auth.js")].join("\n;\n"));
  await sleep(150);
}

beforeEach(async () => { await loadPage(); });
afterEach(() => { try { win?.close(); } catch {} });

/* ---- Tests -------------------------------------------------------------- */

describe("search tab", () => {
  test("the page evaluates without errors", () => {
    expect(pageErrors).toEqual([]);
  });

  test("/search routes straight to the tab", () => {
    expect($('.view[data-view="search"]').classList.contains("active")).toBe(true);
  });

  test("the box offers the modes and time windows", () => {
    expect($$("#sq-mode option").map((o: any) => o.value)).toEqual([
      "auto", "transcripts", "web", "news", "url",
    ]);
    expect($$("#sq-time option").map((o: any) => o.value)).toContain("last_week");
  });
});

describe("auto mode", () => {
  test("a phrase searches transcripts and the web together", async () => {
    await search("ai infrastructure");
    expect(sent("/api/search?q=ai%20infrastructure")).toBe(true);
    expect(sent("/api/web?q=ai+infrastructure&kind=web")).toBe(true);
    expect(sent("/api/parse")).toBe(false);
    // Both sets of results are on the page at once.
    expect(text("#search-results")).toContain("RIVN");
    expect(text("#search-results")).toContain("Data center buildout accelerates");
  });

  test("a pasted URL is parsed instead of searched", async () => {
    await search("https://www.cnbc.com/2026/08/28/inside");
    expect(sent("/api/parse?url=")).toBe(true);
    expect(sent("/api/web")).toBe(false);
    expect(sent("/api/search?q=")).toBe(false);
  });

  test("a URL without a scheme is still recognised as one", async () => {
    await search("cnbc.com/2026/08/28/inside");
    expect(sent("/api/parse?url=")).toBe(true);
    expect(sent("/api/web")).toBe(false);
  });
});

describe("web results", () => {
  beforeEach(async () => { await search("ai infrastructure", { mode: "web" }); });

  test("each result links out, names its publisher and shows its source tier", () => {
    const first = $$("#search-results .res")[0];
    const link = first.querySelector(".res-title");
    expect(link.getAttribute("href")).toBe("https://www.reuters.com/tech/buildout");
    // Outbound links must not leak PageRank or referrer trust.
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(link.getAttribute("rel")).toContain("nofollow");
    expect(first.textContent).toContain("reuters.com");
    expect(first.textContent).toContain("reputable press");
    expect(first.textContent).toContain("Operators are racing to add capacity.");
  });

  test("related searches, recurring phrases and niches all render", () => {
    const body = text("#search-results");
    expect(body).toContain("ai infrastructure stocks"); // Google's related search
    expect(body).toContain("data center buildout"); // computed phrase + niche
    expect(body).toContain("What counts as AI infrastructure?"); // people-also-ask
    expect(body).toContain("cnbc.com"); // publisher breakdown
  });

  test("the credit balance is shown, because this is the search that costs money", () => {
    expect(text("#search-results")).toContain("24,113 credits left");
  });

  test("clicking a phrase runs it as the next search", async () => {
    const chip = $$("#search-results .chip-btn").find((c: any) => c.dataset.q === "data center buildout");
    expect(chip).toBeTruthy();
    requests = [];
    click(chip);
    await sleep(60);
    expect($("#sq").value).toBe("data center buildout");
    expect(sent("q=data+center+buildout")).toBe(true);
  });

  test("a result can be handed straight to the parser", async () => {
    const parse = $$("#search-results [data-parse]")[0];
    requests = [];
    click(parse);
    await sleep(60);
    expect(sent("/api/parse?url=https%3A%2F%2Fwww.reuters.com%2Ftech%2Fbuildout")).toBe(true);
  });
});

describe("news mode", () => {
  test("news is requested as news, with the time window applied", async () => {
    await search("soundhound", { mode: "news", time: "last_week" });
    expect(sent("kind=news")).toBe(true);
    expect(sent("time=last_week")).toBe(true);
    expect(sent("/api/search?q=")).toBe(false); // news mode is news only
  });
});

describe("a parsed page", () => {
  beforeEach(async () => { await search("https://www.cnbc.com/2026/08/28/inside"); });

  test("the page is described: title, publisher, byline and length", () => {
    const body = text("#search-results");
    expect(body).toContain("Inside the data center buildout");
    expect(body).toContain("CNBC");
    expect(body).toContain("A Reporter");
    expect(body).toContain("700 words");
    expect(body).toContain("The buildout is limited by power, not by chips.");
  });

  test("its outline, declared keywords and feeds come through", () => {
    const body = text("#search-results");
    expect(body).toContain("The power problem");
    expect(body).toContain("data centers");
    expect($$("#search-results a").some((a: any) => a.href.includes("rss"))).toBe(true);
  });

  test("a ticker it names links to that stock's report", () => {
    const chip = $$("#search-results .tlink").find((c: any) => c.dataset.ticker === "NVDA");
    expect(chip).toBeTruthy();
    expect(chip.textContent).toContain("NVIDIA Corporation");
    // A real link, so it can be copied, middle-clicked and shared; the
    // document-level `.tlink` handler intercepts an ordinary click.
    expect(chip.tagName).toBe("A");
    expect(chip.getAttribute("href")).toBe("/stocks/NVDA");
  });
});

describe("when the web search cannot run", () => {
  test("an exhausted budget says so, and the transcripts still show", async () => {
    failures["/api/web"] = { status: 402, body: { error: "Web search credits are exhausted for this month." } };
    await search("ai infrastructure");
    const body = text("#search-results");
    expect(body).toContain("credits are exhausted");
    // The point of the assertion: free results survive a paid failure.
    expect(body).toContain("RIVN");
    expect(body).toContain("We are expanding our compute footprint");
  });

  test("a deployment with no key says that instead of failing vaguely", async () => {
    failures["/api/web"] = { status: 503, body: { error: "not configured" } };
    await search("ai infrastructure", { mode: "web" });
    expect(text("#search-results")).toContain("not configured");
  });

  test("a throttled caller is told when to come back", async () => {
    failures["/api/web"] = { status: 429, body: { error: "Too many web searches. Try again in 60 minutes." } };
    await search("ai infrastructure", { mode: "web" });
    expect(text("#search-results")).toContain("Try again in 60 minutes");
  });

  test("a refused URL shows the reason it was refused", async () => {
    failures["/api/parse"] = { status: 400, body: { error: "That host resolves to a private address." } };
    await search("http://10.0.0.5/admin");
    expect(text("#search-results")).toContain("private address");
  });
});
