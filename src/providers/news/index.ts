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
import { bingNewsFeed, fetchFeed, googleNewsFeed, yahooTickerFeed, WIRE_FEEDS } from "./rss.ts";
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
  /**
   * Require the headline to name the subject company. On by default: a
   * per-ticker feed carries a lot of syndicated market commentary that merely
   * appears alongside the ticker (see `isAboutSubject`).
   */
  requireSubject?: boolean;
}

/**
 * Is this hit actually about the subject company?
 *
 * Yahoo's per-ticker feed and Google News both return general market pieces
 * next to real coverage — a run for NVDA returned articles about Amazon,
 * Micron, Enphase and the Fed. Ingesting those is worse than useless: the
 * subject guard then has to block nearly every sentence, and any article that
 * happens to look single-company gets its signals attributed to the wrong
 * ticker. Requiring the headline to name the company keeps the corpus on
 * topic.
 */
/**
 * Identity of an article independent of the URL it was found at.
 *
 * The same story reaches us several times over: a regional mirror
 * (`uk.finance.yahoo.com` beside `finance.yahoo.com`), a tracking parameter, an
 * aggregator's copy. URL-hash dedup misses all of those, and a WCC run indexed
 * one acquisition story three times. Normalizing the headline catches them:
 * trailing " - Publisher" (how Google News formats titles) is dropped, then
 * everything but letters and digits.
 */
export function headlineKey(title: string): string {
  return title
    .replace(/\s+[-–—|]\s+[^-–—|]{2,40}$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function isAboutSubject(
  hit: { title?: string; snippet?: string },
  ticker: string,
  companyName?: string,
): boolean {
  // Headline only. Snippets summarize the article and routinely name several
  // companies, so including them re-admitted exactly the pieces this filter
  // exists to reject ("Supermicro Stock Just Jumped 20%…" for NVDA).
  return mentionsTicker(hit.title ?? "", ticker, companyName);
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

  /** Headline keys already indexed, so a re-run cannot add a mirror of them. */
  private knownHeadlines = new Set<string>();

  setCompanyNames(names: Map<string, string>): void {
    this.companyNames = names;
  }

  /** Seed with the titles already stored for these tickers (see `headlineKey`). */
  setKnownHeadlines(titles: Iterable<string>): void {
    this.knownHeadlines = new Set([...titles].map(headlineKey).filter(Boolean));
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
      const name = this.companyNames.get(ticker);

      // 1. Keyless per-ticker headline feed — cheapest broad coverage.
      try {
        const items = await fetchFeed(yahooTickerFeed(ticker));
        hits.push(...items.map((i) => ({ ...i, tier: tierFor(i.url) })));
      } catch {
        /* a dead feed degrades the run, it does not fail it */
      }

      const q = name ? `"${name}" ${ticker}` : `${ticker} stock`;

      // 2. Keyless Bing News query. Ranked ahead of Google News because its
      // links resolve to the publisher: these are the hits that yield article
      // bodies rather than headlines, and the per-ticker cap is spent in order.
      try {
        const items = await fetchFeed(bingNewsFeed(q));
        hits.push(...items.map((i) => ({ ...i, tier: tierFor(i.url) })));
      } catch {
        /* best effort */
      }

      // 3. Keyless Google News query. Broadest recall, but its links are
      // interstitials that serve a JavaScript redirect, so these documents
      // usually land headline-only.
      try {
        const items = await fetchFeed(googleNewsFeed(q));
        hits.push(...items.map((i) => ({ ...i, tier: tierFor(i.url) })));
      } catch {
        /* best effort */
      }

      // 4. Metered ValueSERP — richer, dated, and already paid for.
      if (this.serp.configured) {
        try {
          hits.push(...(await this.serp.search(q, asOf)));
        } catch {
          /* credits exhausted or upstream error: RSS results still stand */
        }
      }

      let kept = 0;
      // Hits arrive best-source-first, so the first copy of a story wins and
      // later mirrors of the same headline are dropped.
      const seenHeadlines = new Set(this.knownHeadlines);
      for (const hit of hits) {
        if (kept >= perTicker) break;
        if (!hit.url || byUrl.has(hit.url)) continue;
        const tier = hit.tier;
        if (this.options.excludeTier3 && tier === 3) continue;
        if (query.from && hit.publishedAt && hit.publishedAt < query.from.slice(0, 10)) continue;
        if (this.options.requireSubject !== false && !isAboutSubject(hit, ticker, name)) continue;
        const key = headlineKey(hit.title ?? "");
        if (key && seenHeadlines.has(key)) continue;
        if (key) seenHeadlines.add(key);

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
