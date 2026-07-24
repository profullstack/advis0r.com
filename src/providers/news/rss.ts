/**
 * Keyless RSS news discovery (PRD v3 §3.2).
 *
 * Complements the metered ValueSERP path with free per-ticker and wire feeds,
 * so routine coverage does not burn search credits. All three were verified
 * live on 2026-07-24:
 *
 *   Yahoo per-ticker headline feed  200
 *   Google News search feed         200
 *   PR Newswire wire feed           200
 *
 * GlobeNewswire timed out and Nasdaq's feed returned an HTTP/2 error at the
 * time of writing; both are included but treated as best-effort, and a failing
 * feed degrades the run rather than failing it.
 */
import type { SourceTier } from "../../types.ts";
import { normalizeHost, tierFor } from "./tiers.ts";

export interface RssItem {
  title: string;
  url: string;
  publisher: string;
  host: string;
  tier: SourceTier;
  publishedAt?: string;
  snippet?: string;
}

const UA =
  process.env.SEC_USER_AGENT?.replace(/^"|"$/g, "") ??
  "advis0r.com research (anthony@profullstack.com)";

/** Per-ticker headline feed — the cheapest broad coverage available. */
export function yahooTickerFeed(ticker: string): string {
  return `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(ticker)}&region=US&lang=en-US`;
}

/** Google News query feed. `when:7d` style windows keep results recent. */
export function googleNewsFeed(query: string, window = "7d"): string {
  const q = `${query} when:${window}`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;
}

/** Newswire feeds — tier 0 primary sources (issuers speaking directly). */
export const WIRE_FEEDS: { publisher: string; url: string }[] = [
  {
    publisher: "PR Newswire",
    url: "https://www.prnewswire.com/rss/financial-services-latest-news/financial-services-latest-news-list.rss",
  },
  {
    publisher: "GlobeNewswire",
    url: "https://www.globenewswire.com/RssFeed/orgclass/1/feedTitle/GlobeNewswire%20-%20News%20about%20Public%20Companies",
  },
];

export async function fetchFeed(url: string, timeoutMs = 20_000): Promise<RssItem[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`feed ${url} -> ${res.status}`);
    return parseRss(await res.text());
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Minimal RSS/Atom item parser.
 *
 * Deliberately dependency-free: feeds are small, the shape is stable, and the
 * text is untrusted anyway (PRD §26) so it gets sanitized downstream.
 */
export function parseRss(xml: string): RssItem[] {
  const out: RssItem[] = [];
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) ?? [];
  for (const block of blocks) {
    const title = decodeXml(pick(block, "title") ?? "");
    const link = extractLink(block);
    if (!link) continue;
    const host = normalizeHost(link);
    const pub =
      pick(block, "pubDate") ?? pick(block, "published") ?? pick(block, "updated") ?? undefined;
    const parsed = pub ? Date.parse(pub) : Number.NaN;
    // Google News wraps the real publisher in <source>; wires do not.
    const publisher = decodeXml(pick(block, "source") ?? "") || host;
    out.push({
      title,
      url: link,
      publisher,
      host,
      tier: tierFor(link),
      publishedAt: Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10),
      snippet: stripTags(decodeXml(pick(block, "description") ?? "")).slice(0, 400) || undefined,
    });
  }
  return out;
}

function pick(block: string, tag: string): string | undefined {
  const m = block.match(new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
  return m ? m[1]!.trim() : undefined;
}

function extractLink(block: string): string | undefined {
  // Atom: <link href="..."/>. RSS: <link>...</link>.
  const atom = block.match(/<link\b[^>]*href="([^"]+)"/i);
  if (atom) return decodeXml(atom[1]!);
  const rss = pick(block, "link");
  if (rss) {
    const cleaned = stripTags(decodeXml(rss)).trim();
    if (cleaned.startsWith("http")) return cleaned;
  }
  return undefined;
}

function stripTags(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function decodeXml(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .trim();
}
