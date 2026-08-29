/**
 * General web and news search over ValueSERP.
 *
 * `providers/news/valueserp.ts` is the ingestion-side client: news only, wired
 * into the analysis pipeline, spending credits on a schedule. This is the
 * interactive one behind the Search tab — web *or* news, one page by default,
 * and it returns the things a person searching wants rather than the things
 * the ranker wants: titles, publishers, related searches and the questions
 * Google thinks the query implies.
 *
 * Three measured facts about the API shape this client (all verified against
 * the live account, see docs/PRD-v3-media-news.md §3.1):
 *
 *  - **`num` is the pagination stride, not the page size.** The offset sent
 *    upstream is `(page - 1) * num`, and a request returns 8-10 organic
 *    results whatever `num` says. Asking for `num=100` therefore puts page 2
 *    at result 101 — past the end of a truncated result set — so pagination
 *    dies after one page and the query caps at ~8 results. Always `num=10`,
 *    always walk `page`.
 *  - **A page takes 3-34 seconds.** Any timeout under ~45s randomly kills
 *    slow queries, so the default here is deliberately generous.
 *  - **Pages must be fetched concurrently.** Sequentially, three pages is a
 *    minute and a half of a person staring at a spinner. The account allows
 *    250 requests/minute, so a handful in parallel is well inside it.
 *
 * Every request costs a credit from a monthly bucket shared with other
 * Profullstack properties, so callers are expected to cache. When the bucket
 * empties the API answers HTTP 402, which is raised as `SerpCreditsError` so
 * the route can say "out of credits" rather than "search failed".
 */
import { normalizeHost, tierFor, tierLabel } from "../providers/news/tiers.ts";
import { parseNewsResults, resolveDate } from "../providers/news/valueserp.ts";
import type { SourceTier } from "../types.ts";

const ENDPOINT = "https://api.valueserp.com/search";

/** The stride that keeps pagination alive. Not a preference — see above. */
const PAGE_STRIDE = 10;

export type SerpKind = "web" | "news";

export interface SerpHit {
  title: string;
  url: string;
  host: string;
  /** Source reputation, reused from the news tiering so both agree. */
  tier: SourceTier;
  tierLabel: string;
  publisher?: string;
  snippet?: string;
  /** ISO date when the result carried a resolvable one. */
  publishedAt?: string;
}

export interface SerpSearch {
  kind: SerpKind;
  query: string;
  hits: SerpHit[];
  /** Google's "related searches" — what else people search around this. */
  relatedSearches: string[];
  /** People-also-ask questions, the query's implied sub-topics. */
  questions: string[];
  /** Credits left in the monthly bucket, when the response reported it. */
  creditsRemaining?: number;
  pagesFetched: number;
}

/** Raised on HTTP 402: the monthly bucket is empty, the query never ran. */
export class SerpCreditsError extends Error {
  constructor(message = "ValueSERP monthly credits are exhausted") {
    super(message);
    this.name = "SerpCreditsError";
  }
}

/** Raised when no API key is configured, so the caller can degrade honestly. */
export class SerpNotConfiguredError extends Error {
  constructor(message = "Web search is not configured (VALUESERP_API_KEY)") {
    super(message);
    this.name = "SerpNotConfiguredError";
  }
}

export interface SerpClientOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Hard ceiling on pages per call, so one request cannot spend 20 credits. */
  maxPages?: number;
}

export interface SerpQueryOptions {
  kind?: SerpKind;
  /** Pages to walk, 1 credit each. Clamped to `maxPages`. */
  pages?: number;
  /** Google `time_period`: last_hour / last_day / last_week / last_month / last_year. */
  timePeriod?: string;
  /** Anchors relative dates ("2 days ago") so a replay cannot shift them. */
  asOf?: Date;
}

export class SerpClient {
  constructor(private opts: SerpClientOptions) {}

  get configured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  async search(query: string, opts: SerpQueryOptions = {}): Promise<SerpSearch> {
    if (!this.configured) throw new SerpNotConfiguredError();
    const q = query.trim();
    if (!q) throw new Error("empty query");

    const kind: SerpKind = opts.kind === "news" ? "news" : "web";
    const asOf = opts.asOf ?? new Date();
    const maxPages = Math.max(1, this.opts.maxPages ?? 3);
    const pages = Math.min(maxPages, Math.max(1, opts.pages ?? 1));

    const bodies = await Promise.all(
      Array.from({ length: pages }, (_, i) => this.fetchPage(q, kind, i + 1, opts.timePeriod)),
    );

    const hits: SerpHit[] = [];
    const seen = new Set<string>();
    const related = new Set<string>();
    const questions = new Set<string>();
    let creditsRemaining: number | undefined;

    for (const body of bodies) {
      for (const hit of kind === "news" ? newsHits(body, asOf) : webHits(body, asOf)) {
        // The same URL can surface on two pages when the result set shifts
        // between concurrent requests.
        if (seen.has(hit.url)) continue;
        seen.add(hit.url);
        hits.push(hit);
      }
      for (const s of parseRelatedSearches(body)) related.add(s);
      for (const question of parseQuestions(body)) questions.add(question);
      const credits = creditsFrom(body);
      if (credits !== undefined) {
        creditsRemaining = creditsRemaining === undefined ? credits : Math.min(creditsRemaining, credits);
      }
    }

    return {
      kind,
      query: q,
      hits,
      relatedSearches: [...related],
      questions: [...questions],
      creditsRemaining,
      pagesFetched: pages,
    };
  }

  /** Remaining monthly credits, for a budget read that costs nothing. */
  async credits(): Promise<{ remaining: number; limit: number } | null> {
    if (!this.configured) return null;
    try {
      const res = await fetch(
        `https://api.valueserp.com/account?api_key=${encodeURIComponent(this.opts.apiKey)}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (!res.ok) return null;
      const j = (await res.json()) as any;
      return {
        remaining: Number(j?.account_info?.monthly_credits_remaining ?? 0),
        limit: Number(j?.account_info?.monthly_credits_limit ?? 0),
      };
    } catch {
      return null;
    }
  }

  private async fetchPage(
    q: string,
    kind: SerpKind,
    page: number,
    timePeriod?: string,
  ): Promise<unknown> {
    const params = new URLSearchParams({
      api_key: this.opts.apiKey,
      q,
      num: String(PAGE_STRIDE),
      page: String(page),
    });
    if (kind === "news") params.set("search_type", "news");
    if (timePeriod) params.set("time_period", timePeriod);

    const res = await fetch(`${ENDPOINT}?${params}`, {
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
    });
    if (res.status === 402) throw new SerpCreditsError();
    if (!res.ok) {
      throw new Error(`ValueSERP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    }
    return res.json();
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Organic web results. */
export function webHits(body: any, asOf: Date = new Date()): SerpHit[] {
  const rows: any[] = body?.organic_results ?? [];
  const out: SerpHit[] = [];
  for (const r of rows) {
    const url = String(r?.link ?? "");
    if (!url) continue;
    const host = normalizeHost(url);
    const tier = tierFor(url);
    out.push({
      title: String(r?.title ?? "").trim(),
      url,
      host,
      tier,
      tierLabel: tierLabel(tier),
      publisher: r?.domain ? String(r.domain) : host,
      snippet: r?.snippet ? String(r.snippet) : undefined,
      // `date_utc` is an exact timestamp when the result carries one; `date`
      // is the human string ("2 days ago") that has to be resolved against a
      // reference point. Prefer the exact one.
      publishedAt: resolveDate(r?.date_utc ?? r?.date, asOf),
    });
  }
  return out;
}

/** News results, reusing the ingestion parser so both paths tier identically. */
export function newsHits(body: any, asOf: Date = new Date()): SerpHit[] {
  return parseNewsResults(body, asOf).map((n) => ({
    title: n.title,
    url: n.url,
    host: n.host,
    tier: n.tier,
    tierLabel: tierLabel(n.tier),
    publisher: n.publisher,
    snippet: n.snippet,
    publishedAt: n.publishedAt,
  }));
}

/**
 * Related searches. The field has carried both `{ query }` and `{ q }` across
 * result types, so both are read rather than assuming one.
 */
export function parseRelatedSearches(body: any): string[] {
  const rows: any[] = body?.related_searches ?? [];
  return rows
    .map((r) => String(r?.query ?? r?.q ?? r ?? "").trim())
    .filter((s) => s.length > 0 && s.length < 120);
}

/** People-also-ask questions. */
export function parseQuestions(body: any): string[] {
  const rows: any[] = body?.related_questions ?? body?.people_also_ask ?? [];
  return rows
    .map((r) => String(r?.question ?? r ?? "").trim())
    .filter((s) => s.length > 0 && s.length < 200);
}

/**
 * Credits left, as reported on the response itself. Free: it saves the extra
 * `/account` round trip that would otherwise be needed to show a budget.
 */
export function creditsFrom(body: any): number | undefined {
  const n = body?.request_info?.credits_remaining;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
}
