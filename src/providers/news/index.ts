/**
 * News transcript provider (PRD v3 §3).
 *
 * Discovers per-ticker coverage via keyless RSS plus metered ValueSERP search,
 * fetches and parses the article body itself, and emits documents carrying
 * publisher + reputation tier so downstream scoring can weight (or discard)
 * them appropriately.
 *
 * Tier 3 documents are ingested deliberately rather than dropped: they carry
 * zero evidentiary weight, but their *presence* is the input to promotion
 * detection (PRD v3 §3.5).
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  DownloadedDocument,
  EventType,
  ParsedTranscript,
  SourceDocument,
  SourceTier,
  TranscriptQuery,
} from "../../types.ts";
import { BaseTranscriptProvider, segmentText } from "../transcripts/base.ts";
import { fetchArticle } from "./article.ts";
import { fetchFeed, googleNewsFeed, yahooTickerFeed, WIRE_FEEDS } from "./rss.ts";
import { isPromotionalHost, tierFor } from "./tiers.ts";
import { ValueSerpNewsClient, type NewsHit } from "./valueserp.ts";

export interface NewsProviderOptions {
  downloadsDir: string;
  valueSerpKey?: string;
  /** Include newswire firehose feeds in addition to per-ticker queries. */
  includeWires?: boolean;
  /** Max articles per ticker per run. */
  perTicker?: number;
  /** Skip tier-3 sources entirely (they are ingested by default, weight 0). */
  excludeTier3?: boolean;
}

export class NewsProvider extends BaseTranscriptProvider {
  id = "news";
  private serp: ValueSerpNewsClient;
  /** ticker -> company name, improves query precision when known. */
  private companyNames = new Map<string, string>();

  constructor(private options: NewsProviderOptions) {
    super(options.downloadsDir);
    this.serp = new ValueSerpNewsClient({ apiKey: options.valueSerpKey ?? "", num: 10 });
  }

  setCompanyNames(names: Map<string, string>): void {
    this.companyNames = names;
  }

  get serpConfigured(): boolean {
    return this.serp.configured;
  }

  async search(query: TranscriptQuery): Promise<SourceDocument[]> {
    // Seed URLs (TICKER=https://...) belong to GenericHtmlProvider.
    const tickers = (query.tickers ?? [])
      .filter((t) => !t.includes("http"))
      .map((t) => t.toUpperCase());
    if (tickers.length === 0) return [];

    const perTicker = this.options.perTicker ?? 12;
    const asOf = query.to ? new Date(query.to) : new Date();
    const byUrl = new Map<string, SourceDocument>();

    for (const ticker of tickers) {
      const hits: NewsHit[] = [];

      // 1. Keyless per-ticker headline feed — cheapest broad coverage.
      try {
        const items = await fetchFeed(yahooTickerFeed(ticker));
        hits.push(...items.map((i) => ({ ...i, tier: tierFor(i.url) })));
      } catch {
        /* a dead feed degrades the run, it does not fail it */
      }

      // 2. Keyless Google News query.
      const name = this.companyNames.get(ticker);
      const q = name ? `"${name}" ${ticker}` : `${ticker} stock`;
      try {
        const items = await fetchFeed(googleNewsFeed(q));
        hits.push(...items.map((i) => ({ ...i, tier: tierFor(i.url) })));
      } catch {
        /* best effort */
      }

      // 3. Metered ValueSERP — richer, dated, and already paid for.
      if (this.serp.configured) {
        try {
          hits.push(...(await this.serp.search(q, asOf)));
        } catch {
          /* credits exhausted or upstream error: RSS results still stand */
        }
      }

      let kept = 0;
      for (const hit of hits) {
        if (kept >= perTicker) break;
        if (!hit.url || byUrl.has(hit.url)) continue;
        const tier = hit.tier;
        if (this.options.excludeTier3 && tier === 3) continue;
        if (query.from && hit.publishedAt && hit.publishedAt < query.from.slice(0, 10)) continue;

        byUrl.set(hit.url, this.toDocument(hit, ticker, tier));
        kept++;
      }
    }

    if (this.options.includeWires) {
      for (const feed of WIRE_FEEDS) {
        try {
          const items = await fetchFeed(feed.url);
          for (const item of items) {
            // Wire items only matter when they name a ticker we are tracking.
            const match = tickers.find((t) => mentionsTicker(item.title, t, this.companyNames.get(t)));
            if (!match || byUrl.has(item.url)) continue;
            byUrl.set(item.url, this.toDocument({ ...item, publisher: feed.publisher }, match, 0));
          }
        } catch {
          /* best effort */
        }
      }
    }

    return [...byUrl.values()];
  }

  private toDocument(hit: NewsHit, ticker: string, tier: SourceTier): SourceDocument {
    const eventType: EventType = tier === 0 ? "press_release" : "news_article";
    return {
      id: `news:${createHash("sha256").update(hit.url).digest("hex").slice(0, 24)}`,
      providerId: this.id,
      title: hit.title || hit.url,
      url: hit.url,
      eventType,
      publishedAt: hit.publishedAt,
      tickers: [ticker],
      publisher: hit.publisher,
      sourceTier: tier,
      mediaType: "article",
      meta: {
        host: hit.host,
        snippet: hit.snippet,
        promotional: isPromotionalHost(hit.url),
        // Carried so the ingest subject guard can recognise the company by
        // name as well as by ticker in multi-company articles.
        companyName: this.companyNames.get(ticker),
      },
    };
  }

  /**
   * Fetch the article body ourselves. Overrides the base implementation because
   * news needs robots/blocked-publisher handling and body extraction, and must
   * still produce a checksummed local artifact for audit (PRD §26).
   */
  async download(document: SourceDocument): Promise<DownloadedDocument> {
    const result = await fetchArticle(document.url);

    // When a publisher blocks us we keep only what search already gave us —
    // headline plus snippet — and mark the document paywalled. We never
    // synthesize body text (PRD v3 §3.7).
    const snippet = (document.meta?.snippet as string | undefined) ?? "";
    const body = result.ok && result.text ? result.text : [document.title, snippet].filter(Boolean).join(". ");

    const bytes = new TextEncoder().encode(body);
    const checksum = createHash("sha256").update(bytes).digest("hex");
    await mkdir(this.downloadsDir, { recursive: true });
    const localPath = join(this.downloadsDir, `${checksum.slice(0, 16)}.txt`);
    await Bun.write(localPath, body);

    return {
      ...document,
      paywalled: !result.ok,
      localPath,
      contentType: result.contentType ?? "text/plain",
      checksum,
      fetchedAt: new Date().toISOString(),
      meta: { ...(document.meta ?? {}), fetchReason: result.reason, httpStatus: result.status },
    };
  }

  async parse(document: DownloadedDocument): Promise<ParsedTranscript> {
    const text = await Bun.file(document.localPath).text();
    const segments = segmentText(text);
    return {
      ...document,
      segments: segments.length ? segments : [{ index: 0, text }],
      provenance: "published",
    };
  }
}

/** Loose containment test for wire headlines: ticker symbol or company name. */
export function mentionsTicker(title: string, ticker: string, companyName?: string): boolean {
  if (new RegExp(`\\b${ticker}\\b`).test(title)) return true;
  if (!companyName) return false;
  const core = companyName
    .replace(/\b(inc|corp|corporation|company|co|ltd|plc|holdings|group)\b\.?/gi, "")
    .trim();
  return core.length > 3 && title.toLowerCase().includes(core.toLowerCase());
}
