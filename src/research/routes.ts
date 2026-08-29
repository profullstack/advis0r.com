/**
 * Web/news search and URL parsing for the Search tab.
 *
 *   GET /api/web?q=&kind=web|news&pages=&time=  -> ranked results + phrases + niches
 *   GET /api/parse?url=                          -> one pasted page, described
 *
 * Public and unauthenticated, like the rest of the research API — but unlike
 * the rest of it, `/api/web` spends real money: every page is a ValueSERP
 * credit out of a monthly bucket shared with other properties. Two guards keep
 * an open endpoint from draining it:
 *
 *  - **Cache first.** Identical queries inside the TTL are answered from
 *    memory and cost nothing. Search traffic is repetitive (a shared link, a
 *    reload, a back button), so this absorbs most of it.
 *  - **Then throttle.** Only a cache miss — an actual credit — counts against
 *    the per-IP limit.
 *
 * A cache miss that finds the bucket empty answers 402 with a plain message
 * rather than a generic failure, because "out of credits until the bucket
 * resets" is something the operator needs to see and a user can understand.
 */
import type { Client } from "@libsql/client";
import { searchSymbols } from "../symbols/directory.ts";
import { rateLimit } from "../auth/service.ts";
import { deriveNiches, topPhrases } from "./phrases.ts";
import {
  SerpClient,
  SerpCreditsError,
  SerpNotConfiguredError,
  type SerpHit,
  type SerpKind,
} from "./serp.ts";
import { UnfetchableUrlError, assertFetchableUrl, looksLikeUrl, parsePage } from "./page.ts";

const json = (body: unknown, status = 200, cacheSeconds = 0) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
    },
  });

/**
 * Throttles. Web search is capped hard because each miss is a credit; parsing
 * costs only our own bandwidth, so it is capped loosely and mostly to stop the
 * endpoint being used as an open proxy.
 */
export const RESEARCH_LIMITS = {
  web: { max: 20, windowMinutes: 60 },
  parse: { max: 60, windowMinutes: 60 },
} as const;

/** Pages one request may buy. Three is ~25 results; more is a crawl, not a search. */
const MAX_PAGES = 3;

const SERP_TTL_MS = 30 * 60_000;
/** Pages change far more slowly than rankings, and re-fetching one is rude. */
const PARSE_TTL_MS = 6 * 60 * 60_000;
const CACHE_MAX_ENTRIES = 500;

interface CacheEntry {
  at: number;
  value: unknown;
}

const cache = new Map<string, CacheEntry>();

function cacheGet(key: string, ttlMs: number): unknown | undefined {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (Date.now() - hit.at > ttlMs) {
    cache.delete(key);
    return undefined;
  }
  return hit.value;
}

function cacheSet(key: string, value: unknown): void {
  // Insertion-ordered Map: the first key is the oldest write.
  if (cache.size >= CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { at: Date.now(), value });
}

/** Exposed for tests, and for a future admin endpoint that needs to flush. */
export function clearResearchCache(): void {
  cache.clear();
}

function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return (fwd.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
}

export interface ResearchRouteDeps {
  db: Client;
  serp: SerpClient;
}

export async function handleResearchRoute(
  req: Request,
  path: string,
  deps: ResearchRouteDeps,
): Promise<Response | null> {
  if (path !== "/api/web" && path !== "/api/parse") return null;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  const ip = clientIp(req);

  if (path === "/api/parse") return handleParse(url, ip, deps);
  return handleWeb(url, ip, deps);
}

/* ---------------- /api/web ---------------- */

async function handleWeb(url: URL, ip: string, deps: ResearchRouteDeps): Promise<Response> {
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 300);
  if (!q) return json({ error: "missing ?q=" }, 400);

  const kind: SerpKind = url.searchParams.get("kind") === "news" ? "news" : "web";
  const pages = Math.min(MAX_PAGES, Math.max(1, Number(url.searchParams.get("pages") ?? 1) || 1));
  const timePeriod = normalizeTimePeriod(url.searchParams.get("time"));

  if (!deps.serp.configured) {
    return json(
      {
        error: "Web search is not configured on this deployment (VALUESERP_API_KEY).",
        configured: false,
      },
      503,
    );
  }

  const key = `web:${kind}:${pages}:${timePeriod ?? ""}:${q.toLowerCase()}`;
  const cached = cacheGet(key, SERP_TTL_MS);
  if (cached) return json({ ...(cached as object), cached: true }, 200, 300);

  // Only a real credit is throttled — a cache hit above never reaches here.
  const limit = await rateLimit(deps.db, `websearch:${ip}`, RESEARCH_LIMITS.web);
  if (!limit.allowed) {
    return json(
      { error: `Too many web searches. Try again in ${limit.retryAfterMinutes} minutes.` },
      429,
    );
  }

  let search;
  try {
    search = await deps.serp.search(q, { kind, pages, timePeriod });
  } catch (err) {
    if (err instanceof SerpCreditsError) {
      return json({ error: "Web search credits are exhausted for this month.", credits: 0 }, 402);
    }
    if (err instanceof SerpNotConfiguredError) {
      return json({ error: err.message, configured: false }, 503);
    }
    return json({ error: `Web search failed: ${String(err).slice(0, 200)}` }, 502);
  }

  const body = summarize(search.hits, {
    kind,
    query: q,
    pages,
    trending: search.relatedSearches,
    questions: search.questions,
    creditsRemaining: search.creditsRemaining,
  });
  cacheSet(key, body);
  return json({ ...body, cached: false }, 200, 300);
}

interface SummaryMeta {
  kind: SerpKind;
  query: string;
  pages: number;
  trending: string[];
  questions: string[];
  creditsRemaining?: number;
}

/**
 * Turn raw hits into what the tab renders: the results themselves, the
 * language recurring across them, the niches they fall into, and who is
 * publishing.
 */
function summarize(hits: SerpHit[], meta: SummaryMeta) {
  const items = hits.map((h) => ({ title: h.title, snippet: h.snippet, host: h.host }));
  const documents = items.map((i) => `${i.title} ${i.snippet ?? ""}`);

  const hostCounts = new Map<string, { count: number; tier: number; tierLabel: string }>();
  for (const h of hits) {
    const cur = hostCounts.get(h.host);
    if (cur) cur.count++;
    else hostCounts.set(h.host, { count: 1, tier: h.tier, tierLabel: h.tierLabel });
  }

  return {
    kind: meta.kind,
    query: meta.query,
    pages: meta.pages,
    results: hits,
    /** Google's own related searches and questions: what else is being asked. */
    trending: meta.trending,
    questions: meta.questions,
    /** Phrases recurring across the titles we got back. */
    phrases: topPhrases(documents, { limit: 14, maxWords: 3 }),
    niches: deriveNiches(items, { limit: 6 }),
    sources: [...hostCounts.entries()]
      .map(([host, v]) => ({ host, ...v }))
      .sort((a, b) => b.count - a.count || a.host.localeCompare(b.host)),
    creditsRemaining: meta.creditsRemaining,
  };
}

/** Only Google's own vocabulary is passed through; anything else is dropped. */
function normalizeTimePeriod(raw: string | null): string | undefined {
  const allowed = ["last_hour", "last_day", "last_week", "last_month", "last_year"];
  const v = (raw ?? "").trim().toLowerCase();
  return allowed.includes(v) ? v : undefined;
}

/* ---------------- /api/parse ---------------- */

async function handleParse(url: URL, ip: string, deps: ResearchRouteDeps): Promise<Response> {
  const raw = (url.searchParams.get("url") ?? "").trim().slice(0, 2000);
  if (!raw) return json({ error: "missing ?url=" }, 400);
  if (!looksLikeUrl(raw)) return json({ error: "That does not look like a URL." }, 400);

  // Validate before the cache lookup so a refused target is refused
  // consistently, and before the throttle so a typo does not cost a slot.
  let target: URL;
  try {
    target = await assertFetchableUrl(raw);
  } catch (err) {
    if (err instanceof UnfetchableUrlError) return json({ error: err.message }, 400);
    return json({ error: "That URL could not be checked." }, 400);
  }

  const key = `parse:${target.toString()}`;
  const cached = cacheGet(key, PARSE_TTL_MS);
  if (cached) return json({ ...(cached as object), cached: true }, 200, 600);

  const limit = await rateLimit(deps.db, `webparse:${ip}`, RESEARCH_LIMITS.parse);
  if (!limit.allowed) {
    return json({ error: `Too many page fetches. Try again in ${limit.retryAfterMinutes} minutes.` }, 429);
  }

  let page;
  try {
    page = await parsePage(target.toString());
  } catch (err) {
    if (err instanceof UnfetchableUrlError) return json({ error: err.message }, 400);
    return json({ error: `Could not read that page: ${String(err).slice(0, 200)}` }, 502);
  }

  const body = { ...page, tickers: await annotateTickers(deps.db, page.tickers) };
  cacheSet(key, body);
  return json({ ...body, cached: false }, 200, 600);
}

export interface AnnotatedTicker {
  symbol: string;
  name?: string;
  hasReport: boolean;
}

/**
 * Attach the company name and whether a stored report exists, so a ticker
 * found in an article is one click from the research already done on it.
 *
 * Directory misses are kept rather than dropped: a symbol the page states
 * explicitly is worth showing even when our directory has not synced it.
 */
async function annotateTickers(db: Client, symbols: string[]): Promise<AnnotatedTicker[]> {
  if (symbols.length === 0) return [];
  const reports = await reportedTickers(db, symbols);
  const out: AnnotatedTicker[] = [];
  for (const symbol of symbols) {
    let name: string | undefined;
    try {
      const matches = await searchSymbols(db, symbol, 3);
      name = matches.find((m) => m.symbol.toUpperCase() === symbol)?.name;
    } catch {
      /* the directory is an enrichment, never the answer */
    }
    out.push({ symbol, name, hasReport: reports.has(symbol) });
  }
  return out;
}

async function reportedTickers(db: Client, symbols: string[]): Promise<Set<string>> {
  try {
    const ph = symbols.map(() => "?").join(",");
    const rs = await db.execute({
      sql: `SELECT ticker FROM reports WHERE ticker IN (${ph})`,
      args: symbols,
    });
    return new Set(rs.rows.map((r) => String(r.ticker)));
  } catch {
    return new Set();
  }
}
