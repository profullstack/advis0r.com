/**
 * Stored ticker reports.
 *
 * The properties that matter are the ones a user would notice: a report page
 * must never present a stale snapshot as live, must never let untrusted source
 * text become markup, and regeneration must be refused to anyone who is not
 * watching the ticker.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/index.ts";
import { newId } from "../src/auth/crypto.ts";
import {
  allReportRefs,
  countReports,
  listReports,
  loadReport,
  normalizeSymbol,
  saveReport,
} from "../src/reports/store.ts";
import {
  relativeTime,
  renderMissingReportPage,
  renderReportIndex,
  renderReportPage,
  renderSitemap,
  sparkline,
} from "../src/reports/page.ts";
import { handleReportRoute, isWatching } from "../src/reports/routes.ts";

const dir = mkdtempSync(join(tmpdir(), "advis0r-reports-"));
let db: Client;

const APP_URL = "https://advis0r.com";

function payload(ticker: string, over: Record<string, any> = {}): Record<string, any> {
  return {
    ticker,
    companyName: `${ticker} Industries`,
    exchange: "NASDAQ",
    lastPrice: 12.34,
    delayed: true,
    marketSource: "iex",
    classification: "speculative",
    overallScore: 71,
    confidence: 62,
    facts: { marketCap: 4.2e9, sharesOutstanding: 340_000_000, revenue: 8.1e8, revenueGrowth: 24.5, cashBalance: 2.2e8, totalDebt: 5e7, runwayMonths: 19 },
    technical: { trend: "bullish", rsi14: 58.2, sma: { 20: 11.9, 50: 10.4, 200: 9.1 }, macd: { macd: 0.31 }, atr14: 0.62, relativeVolume: 1.4, avgDollarVolume: 3.1e7, momentum: { 20: 8.2, 60: 19.4, 120: 31.1 }, distanceFrom52WeekHigh: -12.4, goldenCross: true, volatilityRegime: "elevated" },
    technicalScore: { score: 68 },
    analysis: { thesis: "Deterministic offline thesis.", catalystSummary: ["New contract"], riskSummary: ["Dilution"], missingData: [] },
    bars: [
      { t: "2026-07-29", o: 10, h: 11, l: 9.8, c: 10.5, v: 1e6 },
      { t: "2026-07-30", o: 10.5, h: 12, l: 10.4, c: 11.8, v: 1.2e6 },
      { t: "2026-07-31", o: 11.8, h: 12.6, l: 11.6, c: 12.34, v: 1.4e6 },
    ],
    signals: [],
    sources: [],
    disclaimer: "research aid",
    ...over,
  };
}

async function createUser(email: string, tickers: string[] = []): Promise<string> {
  const id = newId("usr");
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO users (id, email, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?)",
    args: [id, email, "x", now, now],
  });
  for (const t of tickers) {
    await db.execute({
      sql: "INSERT INTO watchlist_items (id, user_id, ticker, created_at) VALUES (?,?,?,?)",
      args: [newId("wl"), id, t, now],
    });
  }
  return id;
}

/** A session cookie for `userId`, so route guards see a signed-in caller. */
async function sessionCookieFor(userId: string): Promise<string> {
  const { generateToken, hashToken } = await import("../src/auth/crypto.ts");
  const { SESSION_COOKIE } = await import("../src/auth/routes.ts");
  const token = generateToken();
  await db.execute({
    sql: `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at)
          VALUES (?,?,?,?,?)`,
    args: [
      newId("ses"), userId, hashToken(token), new Date().toISOString(),
      new Date(Date.now() + 86_400_000).toISOString(),
    ],
  });
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}`;
}

beforeAll(async () => {
  db = createClient({ url: `file:${join(dir, "reports.sqlite")}` });
  await migrate(db);
});

afterAll(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ---------------- symbols ---------------- */

describe("normalizeSymbol", () => {
  test("accepts and upper-cases real symbols", () => {
    expect(normalizeSymbol("nvda")).toBe("NVDA");
    expect(normalizeSymbol("  brk.b ")).toBe("BRK.B");
    expect(normalizeSymbol("F")).toBe("F");
  });

  test("rejects anything that is not a ticker", () => {
    for (const bad of ["", "TOOLONGSYM", "../../etc/passwd", "<script>", "A B", "1234", null, undefined]) {
      expect(normalizeSymbol(bad)).toBeNull();
    }
  });
});

/* ---------------- store ---------------- */

describe("report store", () => {
  test("saves and reads back the whole payload", async () => {
    const saved = await saveReport(db, "AAA", payload("AAA"));
    expect(saved.generatedAt).toBeTruthy();
    const loaded = await loadReport(db, "AAA");
    expect(loaded!.payload.companyName).toBe("AAA Industries");
    expect((loaded!.payload.bars as unknown[]).length).toBe(3);
  });

  test("a missing report is null, not an error", async () => {
    expect(await loadReport(db, "NOPE")).toBeNull();
  });

  test("regenerating replaces the snapshot but keeps the coverage date", async () => {
    const first = await saveReport(db, "BBB", payload("BBB", { lastPrice: 5 }));
    await Bun.sleep(5);
    const second = await saveReport(db, "BBB", payload("BBB", { lastPrice: 9 }));

    expect(second.payload.lastPrice).toBe(9);
    expect(second.generatedAt > first.generatedAt).toBe(true);
    // "Covered since" must survive a rebuild — it is a different fact.
    expect(second.firstGeneratedAt).toBe(first.firstGeneratedAt);

    const rs = await db.execute({ sql: "SELECT COUNT(*) AS n FROM reports WHERE ticker = ?", args: ["BBB"] });
    expect(Number(rs.rows[0]!.n)).toBe(1); // one row per ticker, not a pile of versions
  });

  test("denormalized columns track the payload, so the index needs no JSON parsing", async () => {
    await saveReport(db, "CCC", payload("CCC", {
      overallScore: 88,
      sources: [{ url: "u1" }, { url: "u2" }],
      signals: [{ x: 1 }],
      aiAnalysis: { provider: "anthropic", model: "balanced", createdAt: "2026-08-01T00:00:00Z", analysis: { thesis: "AI thesis." } },
    }));
    const ccc = (await listReports(db, { sort: "ticker", limit: 500 })).find((r) => r.ticker === "CCC")!;
    expect(ccc.companyName).toBe("CCC Industries");
    expect(ccc.overallScore).toBe(88);
    expect(ccc.sourceCount).toBe(2);
    expect(ccc.signalCount).toBe(1);
    expect(ccc.aiProvider).toBe("anthropic");
  });

  test("sorting by score puts unscored reports last, not first", async () => {
    await saveReport(db, "DDD", payload("DDD", { overallScore: null, analysis: { thesis: "t" } }));
    const byScore = await listReports(db, { sort: "score", limit: 500 });
    expect(byScore[0]!.overallScore).toBeGreaterThanOrEqual(Number(byScore[1]!.overallScore ?? 0));
    expect(byScore.at(-1)!.ticker).toBe("DDD");
  });

  test("counts and sitemap refs cover every stored ticker", async () => {
    const total = await countReports(db);
    expect(total).toBeGreaterThanOrEqual(4);
    expect((await allReportRefs(db)).length).toBe(total);
  });
});

/* ---------------- rendering ---------------- */

describe("relativeTime", () => {
  const base = new Date("2026-08-03T12:00:00Z");
  const ago = (ms: number) => relativeTime(new Date(base.getTime() - ms).toISOString(), base);

  test("describes the age of a snapshot in human terms", () => {
    expect(ago(10_000)).toBe("just now");
    expect(ago(5 * 60_000)).toBe("5 minutes ago");
    expect(ago(3 * 3_600_000)).toBe("3 hours ago");
    expect(ago(2 * 86_400_000)).toBe("2 days ago");
    expect(ago(400 * 86_400_000)).toBe("1 year ago");
  });

  test("singularizes correctly", () => {
    expect(ago(60_000)).toBe("1 minute ago");
    expect(ago(86_400_000)).toBe("1 day ago");
  });

  test("a bad timestamp does not throw", () => {
    expect(relativeTime("not-a-date", base)).toBe("unknown");
  });
});

describe("sparkline", () => {
  test("draws a path from closing prices", () => {
    const svg = sparkline([{ t: "2026-07-30", c: 10 }, { t: "2026-07-31", c: 12 }]);
    expect(svg).toContain("<svg");
    expect(svg).toContain("<path");
    expect(svg).toContain("aria-label");
  });

  test("refuses to imply a trend from too few points", () => {
    expect(sparkline([])).toBe("");
    expect(sparkline([{ t: "2026-07-31", c: 10 }])).toBe("");
  });

  test("colours the line by direction", () => {
    expect(sparkline([{ c: 1 }, { c: 2 }])).toContain("#35d07f");
    expect(sparkline([{ c: 2 }, { c: 1 }])).toContain("#ff6b6b");
  });

  test("a flat series does not divide by zero", () => {
    const svg = sparkline([{ c: 5 }, { c: 5 }, { c: 5 }]);
    expect(svg).toContain("<path");
    expect(svg).not.toContain("NaN");
  });
});

describe("report page", () => {
  const report = {
    ticker: "AAA",
    payload: payload("AAA", {
      aiAnalysis: {
        provider: "anthropic",
        model: "balanced",
        createdAt: "2026-08-01T12:00:00Z",
        analysis: {
          thesis: "The company is executing on its stated roadmap.",
          catalystSummary: ["Contract award", "Capacity expansion"],
          riskSummary: ["Customer concentration"],
          bullCase: { probability: 0.3, assumptions: ["Volumes hold"] },
          baseCase: { probability: 0.5 },
          bearCase: { probability: 0.2, assumptions: ["Pricing slips"] },
          missingData: ["Q3 guidance"],
        },
      },
      sources: [{
        url: "https://example.com/a", title: "AAA lands a contract", eventType: "news_article",
        publisher: "Example Wire", publishedAt: "2026-07-31", kind: "news",
        said: [{ signalType: "new_contract", direction: "positive", quote: "We signed a multi-year agreement." }],
      }],
    }),
    generatedAt: "2026-08-03T09:00:00Z",
    firstGeneratedAt: "2026-07-01T09:00:00Z",
  };
  const now = new Date("2026-08-03T12:00:00Z");
  const page = renderReportPage(report, { appUrl: APP_URL, now });

  test("renders a complete standalone document", () => {
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain("</html>");
    expect(page).toContain(`<link rel="stylesheet" href="/styles.css">`);
  });

  test("states when the snapshot was taken — the whole contract of a cached report", () => {
    expect(page).toContain("Snapshot taken");
    expect(page).toContain("3 hours ago");
    expect(page).toContain("Stored, not recomputed");
  });

  test("carries the analysis, its provenance, and both sides of the case", () => {
    expect(page).toContain("The company is executing on its stated roadmap.");
    expect(page).toContain("anthropic:balanced");
    expect(page).toContain("Contract award");
    expect(page).toContain("Customer concentration");
    expect(page).toContain("Bull 30%");
    expect(page).toContain("Q3 guidance");
  });

  test("carries technicals, fundamentals and sources", () => {
    expect(page).toContain("bullish");
    expect(page).toContain("$4.20B"); // market cap
    expect(page).toContain("AAA lands a contract");
    expect(page).toContain("We signed a multi-year agreement.");
  });

  test("is self-describing to crawlers and preview cards", () => {
    expect(page).toContain(`<link rel="canonical" href="https://advis0r.com/stocks/AAA">`);
    expect(page).toContain(`<meta property="og:title"`);
    expect(page).toContain(`application/ld+json`);
    expect(page).toContain(`"@type":"Report"`);
  });

  test("carries the mandatory disclaimer", () => {
    expect(page).toContain("research aid");
  });

  test("needs no JavaScript to show the price history", () => {
    expect(page).toContain("<svg");
    expect(page).not.toContain("<script src=");
  });

  test("untrusted source text cannot become markup", () => {
    const hostile = {
      ...report,
      payload: payload("AAA", {
        companyName: `<script>alert(1)</script>`,
        sources: [{
          url: "https://example.com/x",
          title: `"><img src=x onerror=alert(1)>`,
          eventType: "news_article",
          kind: "news",
          said: [{ signalType: "x", direction: "positive", quote: "</q><script>alert(2)</script>" }],
        }],
        aiAnalysis: { provider: "p", model: "m", analysis: { thesis: `</p><script>alert(3)</script>` } },
      }),
    };
    const out = renderReportPage(hostile, { appUrl: APP_URL, now });
    // No attacker-supplied tag survives; the JSON-LD block cannot be broken out of.
    expect(out).not.toContain("<script>alert");
    expect(out).not.toContain("<img src=x");
    expect(out).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("a report with no analysis still renders the rest of the page", () => {
    const bare = {
      ...report,
      payload: payload("AAA", { analysis: undefined, aiAnalysis: undefined }),
    };
    const out = renderReportPage(bare, { appUrl: APP_URL, now });
    expect(out).toContain("Technical");
    expect(out).toContain("Fundamentals");
  });
});

describe("missing-report page", () => {
  const out = renderMissingReportPage("ZZZ", { appUrl: APP_URL });

  test("explains the situation and offers to build one", () => {
    expect(out).toContain("No report has been generated");
    expect(out).toContain("/?ticker=ZZZ");
  });

  test("is noindex — thin pages for every conceivable symbol are not content", () => {
    expect(out).toContain(`<meta name="robots" content="noindex, follow">`);
  });
});

describe("index page and sitemap", () => {
  test("lists reports with their age and links to each", () => {
    const out = renderReportIndex(
      [{ ticker: "AAA", companyName: "AAA Industries", lastPrice: 12.34, overallScore: 71, sourceCount: 2, signalCount: 0, generatedAt: "2026-08-03T09:00:00Z", aiProvider: "anthropic" }],
      { appUrl: APP_URL, total: 1, sort: "recent", now: new Date("2026-08-03T12:00:00Z") },
    );
    expect(out).toContain(`href="/stocks/AAA"`);
    expect(out).toContain("3 hours ago");
    expect(out).toContain("1 ticker covered");
  });

  test("an empty index says so rather than rendering a bare list", () => {
    const out = renderReportIndex([], { appUrl: APP_URL, total: 0, sort: "recent" });
    expect(out).toContain("No reports yet");
  });

  test("the sitemap lists every report URL with a lastmod", () => {
    const xml = renderSitemap(
      [{ ticker: "AAA", generatedAt: "2026-08-03T09:00:00Z" }, { ticker: "BRK.B", generatedAt: "2026-08-02T09:00:00Z" }],
      APP_URL,
    );
    expect(xml.startsWith("<?xml")).toBe(true);
    expect(xml).toContain("<loc>https://advis0r.com/stocks/AAA</loc>");
    expect(xml).toContain("<loc>https://advis0r.com/stocks/BRK.B</loc>");
    expect(xml).toContain("<lastmod>2026-08-03</lastmod>");
  });
});

/* ---------------- routes ---------------- */

describe("report routes", () => {
  let built = 0;
  const deps = () => ({
    db,
    appUrl: APP_URL,
    buildReport: async (symbol: string) => {
      built += 1;
      return payload(symbol, { lastPrice: 99 });
    },
  });
  const route = (path: string, init?: RequestInit) =>
    handleReportRoute(new Request(`${APP_URL}${path}`, init), path.split("?")[0]!, deps());

  test("serves a stored report page", async () => {
    const res = await route("/stocks/AAA");
    expect(res!.status).toBe(200);
    expect(res!.headers.get("content-type")).toContain("text/html");
    expect(await res!.text()).toContain("AAA Industries");
  });

  test("an unknown ticker is a 404 page, not a 500 and not the SPA", async () => {
    const res = await route("/stocks/ZZZZ");
    expect(res!.status).toBe(404);
    expect(await res!.text()).toContain("No report has been generated");
  });

  test("lower-case URLs redirect to the canonical symbol", async () => {
    const res = await route("/stocks/aaa");
    expect(res!.status).toBe(301);
    expect(res!.headers.get("location")).toBe("https://advis0r.com/stocks/AAA");
  });

  test("the old /ticker/ URLs still resolve", async () => {
    // These are in sitemaps, digest emails, and anywhere a report was already
    // shared. A shareable page that stops resolving is worse than an extra hop.
    const res = await route("/ticker/AAA");
    expect(res!.status).toBe(301);
    expect(res!.headers.get("location")).toBe("https://advis0r.com/stocks/AAA");
  });

  test("the old URLs redirect before validating, so a bad one still lands somewhere real", async () => {
    const res = await route("/ticker/aaa");
    expect(res!.status).toBe(301);
    // Case is canonicalized by the /stocks/ handler on the next hop.
    expect(res!.headers.get("location")).toBe("https://advis0r.com/stocks/aaa");
  });

  test("a path that is not a ticker cannot reach the store", async () => {
    const res = await route("/stocks/..%2F..%2Fetc%2Fpasswd");
    expect(res!.status).toBe(404);
  });

  test("serves the index, the JSON index, the sitemap and robots", async () => {
    expect((await route("/reports"))!.status).toBe(200);
    expect(await (await route("/api/reports"))!.json()).toHaveProperty("reports");
    expect(await (await route("/sitemap.xml"))!.text()).toContain("<urlset");
    expect(await (await route("/robots.txt"))!.text()).toContain("Sitemap: https://advis0r.com/sitemap.xml");
  });

  test("unrelated paths fall through to the rest of the router", async () => {
    expect(await route("/api/stats")).toBeNull();
    expect(await route("/")).toBeNull();
  });

  test("reading a report never rebuilds it", async () => {
    const before = built;
    await route("/stocks/AAA");
    await route("/api/reports");
    expect(built).toBe(before);
  });
});

describe("regeneration authorization", () => {
  const built: string[] = [];
  const deps = () => ({
    db,
    appUrl: APP_URL,
    buildReport: async (symbol: string) => {
      built.push(symbol);
      return payload(symbol, { lastPrice: 77 });
    },
  });
  const post = (body: unknown, cookie?: string) =>
    handleReportRoute(
      new Request(`${APP_URL}/api/report/regenerate`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
      "/api/report/regenerate",
      deps(),
    );

  test("anonymous callers are refused", async () => {
    const res = await post({ ticker: "AAA" });
    expect(res!.status).toBe(401);
    expect(await res!.json()).toMatchObject({ authRequired: true });
  });

  test("a signed-in user cannot regenerate a ticker they do not watch", async () => {
    const id = await createUser("nowatch@example.com", ["BBB"]);
    const res = await post({ ticker: "AAA" }, await sessionCookieFor(id));
    expect(res!.status).toBe(403);
    expect(await res!.json()).toMatchObject({ watchlistRequired: true, ticker: "AAA" });
    expect(built).not.toContain("AAA");
  });

  test("a watchlist member can, and gets the fresh report back", async () => {
    const id = await createUser("watcher@example.com", ["AAA"]);
    expect(await isWatching(db, id, "AAA")).toBe(true);
    const res = await post({ ticker: "aaa" }, await sessionCookieFor(id));
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as Record<string, any>;
    expect(body.ok).toBe(true);
    expect(body.ticker).toBe("AAA");
    expect(body.lastPrice).toBe(77);
    expect(body.cached).toBe(false);
    expect(body.reportGeneratedAt).toBeTruthy();
    // The stored snapshot really was replaced.
    expect((await loadReport(db, "AAA"))!.payload.lastPrice).toBe(77);
  });

  test("an invalid symbol is rejected before any work happens", async () => {
    const id = await createUser("bad@example.com", ["AAA"]);
    const res = await post({ ticker: "<script>" }, await sessionCookieFor(id));
    expect(res!.status).toBe(400);
  });

  test("GET is not a way to trigger a rebuild", async () => {
    const res = await handleReportRoute(
      new Request(`${APP_URL}/api/report/regenerate`),
      "/api/report/regenerate",
      deps(),
    );
    expect(res!.status).toBe(405);
  });
});
