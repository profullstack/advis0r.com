/**
 * ValueSERP news discovery (PRD v3 §3.1).
 *
 * Discovery only: this returns article URLs, publishers and dates. Fetching and
 * parsing the article body is done by `article.ts` so that what we analyze is
 * text we retrieved ourselves, not a vendor's summary.
 *
 * Verified live 2026-07-24: `search_type=news` returns dated, sourced results;
 * a request takes ~10s, so timeouts here are deliberately generous.
 */
import type { SourceTier } from "../../types.ts";
import { normalizeHost, tierFor } from "./tiers.ts";

const ENDPOINT = "https://api.valueserp.com/search";

export interface NewsHit {
  title: string;
  url: string;
  publisher: string;
  host: string;
  tier: SourceTier;
  /** ISO date when resolvable; undefined when the API gave nothing usable. */
  publishedAt?: string;
  snippet?: string;
}

export interface ValueSerpOptions {
  apiKey: string;
  timeoutMs?: number;
  /** Google `time_period` value, e.g. last_week / last_month / last_year. */
  timePeriod?: string;
  num?: number;
}

export class ValueSerpNewsClient {
  constructor(private opts: ValueSerpOptions) {}

  get configured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  /**
   * Run one news query. `asOf` anchors relative dates ("2 days ago") so the
   * result is reproducible when replayed later (PRD §18 point-in-time).
   */
  async search(query: string, asOf: Date = new Date()): Promise<NewsHit[]> {
    if (!this.configured) throw new Error("ValueSERP API key not configured (VALUESERP_API_KEY)");
    const params = new URLSearchParams({
      api_key: this.opts.apiKey,
      search_type: "news",
      q: query,
      num: String(this.opts.num ?? 10),
    });
    if (this.opts.timePeriod) params.set("time_period", this.opts.timePeriod);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 60_000);
    let body: unknown;
    try {
      const res = await fetch(`${ENDPOINT}?${params}`, { signal: controller.signal });
      if (!res.ok) throw new Error(`ValueSERP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      body = await res.json();
    } finally {
      clearTimeout(timer);
    }
    return parseNewsResults(body, asOf);
  }

  /** Remaining monthly credits, for budget-aware scheduling. */
  async credits(): Promise<{ remaining: number; limit: number } | null> {
    if (!this.configured) return null;
    const res = await fetch(
      `https://api.valueserp.com/account?api_key=${encodeURIComponent(this.opts.apiKey)}`,
    );
    if (!res.ok) return null;
    const j = (await res.json()) as any;
    return {
      remaining: Number(j?.account_info?.monthly_credits_remaining ?? 0),
      limit: Number(j?.account_info?.monthly_credits_limit ?? 0),
    };
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export function parseNewsResults(body: any, asOf: Date): NewsHit[] {
  const rows: any[] = body?.news_results ?? [];
  const out: NewsHit[] = [];
  for (const r of rows) {
    const url = String(r?.link ?? "");
    if (!url) continue;
    const host = normalizeHost(url);
    out.push({
      title: String(r?.title ?? "").trim(),
      url,
      publisher: String(r?.source ?? host),
      host,
      tier: tierFor(url),
      publishedAt: resolveDate(r?.date, asOf),
      snippet: r?.snippet ? String(r.snippet) : undefined,
    });
  }
  return out;
}

/**
 * Google news dates arrive either absolute ("Jul 14, 2026") or relative
 * ("2 days ago"). Relative values are resolved against `asOf` so replaying a
 * stored query cannot silently shift an article's date.
 */
export function resolveDate(raw: unknown, asOf: Date): string | undefined {
  if (raw == null) return undefined;
  const s = String(raw).trim();
  if (!s) return undefined;

  const rel = s.match(/^(\d+)\s+(minute|hour|day|week|month|year)s?\s+ago$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    const ms: Record<string, number> = {
      minute: 60_000,
      hour: 3_600_000,
      day: 86_400_000,
      week: 604_800_000,
      month: 2_592_000_000, // 30d
      year: 31_536_000_000,
    };
    return new Date(asOf.getTime() - n * (ms[unit] ?? 0)).toISOString().slice(0, 10);
  }

  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString().slice(0, 10);
  return undefined;
}
