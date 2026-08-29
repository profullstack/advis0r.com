/**
 * Pasted-URL parsing: turn a link into the same shape a search result has.
 *
 * Someone reading about a company does not want to retype what it is called —
 * they want to paste the article. This module fetches that page and extracts
 * what the Search tab shows: title, publisher, date, the phrases it keeps
 * using, and any tickers it names. Body retrieval is `providers/news/article.ts`,
 * unchanged, so a pasted URL obeys exactly the same rules as an ingested one:
 * robots.txt is honoured, publishers that block us are reported as blocked,
 * and no body text is ever invented.
 *
 * **This endpoint fetches a URL chosen by an anonymous caller**, which makes it
 * a server-side request forgery vector unless the target is checked first.
 * `assertFetchableUrl` is that check: http(s) only, standard ports only, and
 * the hostname must resolve exclusively to public addresses. A DNS name that
 * resolves to 169.254.169.254 or 10.0.0.5 is refused before any fetch happens.
 */
import { lookup as dnsLookup } from "node:dns/promises";
import { fetchArticle } from "../providers/news/article.ts";
import { normalizeHost, tierFor, tierLabel } from "../providers/news/tiers.ts";
import type { SourceTier } from "../types.ts";
import { topPhrases, type Phrase } from "./phrases.ts";

/** Refused target: not a URL we will fetch on a stranger's behalf. */
export class UnfetchableUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnfetchableUrlError";
  }
}

/**
 * Does this input look like a link rather than a search phrase?
 *
 * Deliberately generous — "nvidia.com/newsroom" is a paste, not a query — but
 * it must not swallow ordinary searches. A bare word with a dot in it only
 * counts when the last label is a plausible TLD, so "rivian earnings" stays a
 * query and "3.5% yield" does not become a URL.
 */
export function looksLikeUrl(input: string): boolean {
  const s = String(input ?? "").trim();
  if (!s || /\s/.test(s)) return false;
  if (/^https?:\/\//i.test(s)) return true;
  // Reject other schemes outright rather than letting them reach the parser.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
  return /^[\w-]+(\.[\w-]+)*\.[a-z]{2,24}(:\d+)?([/?#]|$)/i.test(s);
}

/**
 * Add the scheme a pasted `example.com/x` is missing — and only then.
 *
 * Prefixing unconditionally turned `ftp://host/x` into `https://ftp://host/x`,
 * a URL that parses, has host `ftp`, and so failed later as "does not resolve"
 * instead of "we only fetch http and https". An input that already names a
 * scheme is left alone so the protocol check is the thing that rejects it.
 */
export function normalizeUrlInput(input: string): string {
  const s = String(input ?? "").trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s; // any scheme with an authority
  // A bare `word:` scheme (mailto:, javascript:). Dots are excluded from the
  // scheme name and digits from what follows, so `example.com:8080` and
  // `host:8080` stay hostnames rather than becoming schemes.
  if (/^[a-z][a-z0-9+-]*:(?!\d)/i.test(s)) return s;
  return `https://${s}`;
}

/**
 * IPv4/IPv6 ranges that are not the public internet: loopback, link-local
 * (which is where cloud metadata services live), the RFC1918 blocks, CGNAT,
 * benchmarking, multicast and reserved space.
 */
export function isPrivateAddress(address: string, family: number): boolean {
  if (family === 4) return isPrivateV4(address);

  const ip = address.toLowerCase().replace(/%.*$/, "");
  // IPv4-mapped (::ffff:10.0.0.1) is an IPv4 address wearing a costume.
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateV4(mapped[1]!);
  if (ip === "::" || ip === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(ip)) return true; // fc00::/7 unique-local
  if (/^fe[89ab][0-9a-f]:/.test(ip)) return true; // fe80::/10 link-local
  if (/^ff[0-9a-f]{2}:/.test(ip)) return true; // multicast
  return false;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // unparseable: refuse rather than guess
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

/**
 * Validate a pasted URL and prove its host is on the public internet.
 *
 * Returns the normalized URL. Throws `UnfetchableUrlError` with a reason the
 * UI can show, because "we won't fetch a private address" is a better answer
 * than a generic failure.
 */
export async function assertFetchableUrl(input: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(normalizeUrlInput(input));
  } catch {
    throw new UnfetchableUrlError("That does not parse as a URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnfetchableUrlError("Only http and https URLs can be fetched.");
  }
  // Non-standard ports are almost never articles and often internal services.
  if (url.port && url.port !== "80" && url.port !== "443") {
    throw new UnfetchableUrlError("Only the standard web ports (80, 443) are fetched.");
  }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")
      || host.endsWith(".internal") || host.endsWith(".home.arpa")) {
    throw new UnfetchableUrlError("That host is not on the public internet.");
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await dnsLookup(host, { all: true });
  } catch {
    throw new UnfetchableUrlError("That host does not resolve.");
  }
  if (addresses.length === 0) throw new UnfetchableUrlError("That host does not resolve.");
  // Every address must be public: one private answer is enough to make the
  // fetch a request into someone's network.
  for (const { address, family } of addresses) {
    if (isPrivateAddress(address, family)) {
      throw new UnfetchableUrlError("That host resolves to a private address.");
    }
  }
  return url;
}

export interface PageMeta {
  title?: string;
  description?: string;
  siteName?: string;
  author?: string;
  publishedAt?: string;
  canonical?: string;
  image?: string;
  type?: string;
  lang?: string;
  /** The publisher's own declared keywords, when it declares any. */
  keywords: string[];
  /** Section headings, in document order — the page's own outline. */
  headings: string[];
  /** RSS/Atom feeds the page advertises. */
  feeds: string[];
}

/**
 * Read a page's declared metadata.
 *
 * Preference order is publisher-declared before inferred: OpenGraph and
 * JSON-LD are what the publisher tells syndicators the page is, while
 * `<title>` is decorated for the tab bar ("Story — Section | Publisher").
 */
export function extractPageMeta(html: string): PageMeta {
  const meta: PageMeta = { keywords: [], headings: [], feeds: [] };
  const props = metaMap(html);
  const ld = jsonLdNodes(html);

  const ldPick = (key: string): string | undefined => {
    for (const node of ld) {
      const v = node?.[key];
      if (typeof v === "string" && v.trim()) return v.trim();
    }
    return undefined;
  };

  meta.title = clean(
    props["og:title"] ?? props["twitter:title"] ?? ldPick("headline") ?? titleTag(html) ?? firstHeading(html),
  );
  meta.description = clean(
    props["og:description"] ?? props["description"] ?? props["twitter:description"] ?? ldPick("description"),
  );
  meta.siteName = clean(props["og:site_name"] ?? props["application-name"]);
  meta.author = clean(props["author"] ?? props["article:author"] ?? ldAuthor(ld));
  meta.publishedAt = isoDate(
    props["article:published_time"] ?? props["datePublished"] ?? props["date"]
      ?? ldPick("datePublished") ?? props["article:modified_time"],
  );
  meta.canonical = clean(linkHref(html, "canonical") ?? props["og:url"]);
  meta.image = clean(props["og:image"] ?? props["twitter:image"]);
  meta.type = clean(props["og:type"] ?? ldType(ld));
  meta.lang = clean(html.match(/<html[^>]*\blang=["']([^"']{2,10})["']/i)?.[1]);
  meta.keywords = (props["keywords"] ?? props["news_keywords"] ?? "")
    .split(",")
    .map((k) => clean(k) ?? "")
    .filter((k) => k.length > 1 && k.length < 60)
    .slice(0, 20);
  meta.headings = headings(html);
  meta.feeds = feedLinks(html);
  return meta;
}

/**
 * Tickers a page names, read only from the two forms that are unambiguous:
 * a cashtag ($NVDA) and an exchange-qualified mention (NASDAQ: NVDA).
 *
 * Bare capitals are not read. "CEO said the AI and EV markets" would otherwise
 * produce three tickers, and a confidently wrong ticker on a research page is
 * worse than no ticker at all.
 */
export function extractTickerMentions(text: string): string[] {
  const found = new Map<string, number>();
  const add = (raw: string) => {
    const sym = raw.toUpperCase();
    if (!/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(sym)) return;
    found.set(sym, (found.get(sym) ?? 0) + 1);
  };
  const body = String(text ?? "");
  for (const m of body.matchAll(/\$([A-Za-z]{1,5}(?:\.[A-Za-z]{1,2})?)\b/g)) add(m[1]!);
  const exchange =
    /\b(?:NASDAQ|NYSE(?:\s+(?:American|Arca))?|AMEX|NYSEAMERICAN|OTCQB|OTCQX|OTC(?:\s+Markets)?|CBOE|TSX(?:V)?|LSE)\s*[:：]\s*([A-Za-z]{1,5}(?:\.[A-Za-z]{1,2})?)\b/gi;
  for (const m of body.matchAll(exchange)) add(m[1]!);
  return [...found.entries()].sort((a, b) => b[1] - a[1]).map(([sym]) => sym);
}

export interface ParsedPage {
  url: string;
  host: string;
  tier: SourceTier;
  tierLabel: string;
  ok: boolean;
  meta: PageMeta;
  /** Recurring phrases in the page's own text — its niche, in its own words. */
  phrases: Phrase[];
  tickers: string[];
  /** Extracted body length in characters; 0 when blocked or unparseable. */
  textLength: number;
  wordCount: number;
  /** A short attributed quote. Never the whole body — that is never republished. */
  excerpt?: string;
  /** Set when the body could not be read: paywall, robots, or a hard block. */
  blockedReason?: string;
}

/**
 * Fetch and describe one page.
 *
 * The caller is expected to have run `assertFetchableUrl` already (the route
 * does), but it is run again here so no future caller can skip it.
 */
export async function parsePage(
  input: string,
  opts: { timeoutMs?: number } = {},
): Promise<ParsedPage> {
  const url = await assertFetchableUrl(input);
  const target = url.toString();
  const host = normalizeHost(target);
  const tier = tierFor(target);

  const article = await fetchArticle(target, { timeoutMs: opts.timeoutMs ?? 20_000 });
  const meta = extractPageMeta(article.raw ?? "");
  const text = article.text ?? "";

  // Phrases come from the page's own sections rather than one blob, so
  // document frequency means "recurs through the piece", not "appears".
  const documents = [
    meta.title ?? "",
    meta.description ?? "",
    ...meta.headings,
    ...paragraphs(text),
  ].filter((d) => d.trim().length > 0);

  const tickerSource = `${meta.title ?? ""} ${meta.description ?? ""} ${text}`;

  return {
    url: target,
    host,
    tier,
    tierLabel: tierLabel(tier),
    ok: article.ok,
    meta,
    phrases: topPhrases(documents, { limit: 12, maxWords: 3 }),
    tickers: extractTickerMentions(tickerSource).slice(0, 8),
    textLength: text.length,
    wordCount: text ? text.split(/\s+/).filter(Boolean).length : 0,
    excerpt: text ? `${text.slice(0, 320).trim()}${text.length > 320 ? "…" : ""}` : undefined,
    blockedReason: article.ok ? undefined : article.reason,
  };
}

/* ---------------- HTML helpers ---------------- */

/** Every `<meta>` on the page, keyed by name/property, lowercased. */
function metaMap(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const key = (
      attr(tag, "property") ?? attr(tag, "name") ?? attr(tag, "itemprop") ?? ""
    ).toLowerCase();
    const value = attr(tag, "content");
    if (key && value && !(key in out)) out[key] = value;
  }
  return out;
}

function attr(tag: string, name: string): string | undefined {
  const m =
    tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i")) ??
    tag.match(new RegExp(`\\b${name}\\s*=\\s*'([^']*)'`, "i")) ??
    tag.match(new RegExp(`\\b${name}\\s*=\\s*([^\\s>]+)`, "i"));
  return m?.[1];
}

function titleTag(html: string): string | undefined {
  return html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
}

function firstHeading(html: string): string | undefined {
  return html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
}

function headings(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<h([12345])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = clean(m[2]);
    if (text && text.length > 2 && text.length < 200 && !out.includes(text)) out.push(text);
    if (out.length >= 25) break;
  }
  return out;
}

function linkHref(html: string, rel: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if ((attr(tag, "rel") ?? "").toLowerCase().split(/\s+/).includes(rel)) return attr(tag, "href");
  }
  return undefined;
}

function feedLinks(html: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    const rel = (attr(tag, "rel") ?? "").toLowerCase();
    const type = (attr(tag, "type") ?? "").toLowerCase();
    const href = attr(tag, "href");
    if (!href || !rel.includes("alternate")) continue;
    if (!/rss|atom|feed\+json/.test(type)) continue;
    if (!out.includes(href)) out.push(href);
    if (out.length >= 5) break;
  }
  return out;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Flattened JSON-LD objects, so `@graph` entries are reachable. */
function jsonLdNodes(html: string): any[] {
  const nodes: any[] = [];
  const blocks =
    html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const json = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
    try {
      flatten(JSON.parse(json), nodes);
    } catch {
      /* one malformed block must not lose the others */
    }
  }
  return nodes;
}

function flatten(node: any, out: any[], depth = 0): void {
  if (!node || depth > 5) return;
  if (Array.isArray(node)) {
    for (const item of node) flatten(item, out, depth + 1);
    return;
  }
  if (typeof node !== "object") return;
  out.push(node);
  if (node["@graph"]) flatten(node["@graph"], out, depth + 1);
}

function ldAuthor(nodes: any[]): string | undefined {
  for (const node of nodes) {
    const a = node?.author;
    if (typeof a === "string" && a.trim()) return a;
    if (Array.isArray(a) && typeof a[0]?.name === "string") return a[0].name;
    if (typeof a?.name === "string") return a.name;
  }
  return undefined;
}

function ldType(nodes: any[]): string | undefined {
  for (const node of nodes) {
    const t = node?.["@type"];
    if (typeof t === "string") return t;
    if (Array.isArray(t) && typeof t[0] === "string") return t[0];
  }
  return undefined;
}

/** Split extracted body text back into the paragraphs `article.ts` joined. */
function paragraphs(text: string): string[] {
  return text.split(/\n{2,}/).map((p) => p.trim()).filter((p) => p.length > 40).slice(0, 60);
}

function clean(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  const out = decodeEntities(String(s).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  return out.length > 0 ? out.slice(0, 400) : undefined;
}

function isoDate(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const t = Date.parse(raw.trim());
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;|&rsquo;|&#8217;/g, "'")
    .replace(/&ldquo;|&rdquo;|&#8220;|&#8221;/g, '"')
    .replace(/&ndash;|&mdash;|&#8211;|&#8212;/g, "-")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 31 && code < 0x10ffff ? String.fromCodePoint(code) : " ";
    });
}
