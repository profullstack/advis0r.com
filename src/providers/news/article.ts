/**
 * Article retrieval and body extraction (PRD v3 §3.2, §3.7).
 *
 * We fetch and parse the article ourselves rather than relying on a vendor's
 * summary, which is the point of the news feature. Three rules govern this:
 *
 *  - `robots.txt` is honoured. A disallowed path is not fetched.
 *  - Publishers that block automated access (verified: Reuters 401) are not
 *    routed around. We degrade to the headline + snippet already obtained from
 *    search, marked `paywalled`, and never fabricate body text.
 *  - Bodies are stored as internal evidence only, never republished; the UI
 *    shows a short quote with attribution and a link to the original.
 */
import { isFetchBlocked, normalizeHost } from "./tiers.ts";

const UA =
  process.env.SEC_USER_AGENT?.replace(/^"|"$/g, "") ??
  "advis0r.com research (anthony@profullstack.com)";

export interface ArticleFetchResult {
  url: string;
  ok: boolean;
  /** Extracted body text; empty when blocked or unparseable. */
  text: string;
  /** True when only headline/snippet is available. */
  paywalled: boolean;
  status?: number;
  reason?: string;
  contentType?: string;
  raw?: string;
}

/** robots.txt decisions, cached per host for the life of the process. */
const robotsCache = new Map<string, Promise<RobotsRules>>();

interface RobotsRules {
  disallow: string[];
  crawlDelayMs: number;
}

async function getRobots(host: string): Promise<RobotsRules> {
  let cached = robotsCache.get(host);
  if (!cached) {
    cached = (async () => {
      try {
        const res = await fetch(`https://${host}/robots.txt`, {
          headers: { "User-Agent": UA },
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return { disallow: [], crawlDelayMs: 0 };
        return parseRobots(await res.text());
      } catch {
        // Unreachable robots.txt is treated as "no stated restrictions"; the
        // fetch itself will still fail loudly if the host is blocking us.
        return { disallow: [], crawlDelayMs: 0 };
      }
    })();
    robotsCache.set(host, cached);
  }
  return cached;
}

/** Parse the `*` (and our own) user-agent groups out of a robots.txt. */
export function parseRobots(txt: string): RobotsRules {
  const lines = txt.split(/\r?\n/).map((l) => l.replace(/#.*$/, "").trim());
  const disallow: string[] = [];
  let crawlDelayMs = 0;
  let applies = false;
  for (const line of lines) {
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      applies = value === "*" || /advis0r/i.test(value);
    } else if (applies && key === "disallow" && value) {
      disallow.push(value);
    } else if (applies && key === "crawl-delay") {
      const n = Number(value);
      if (Number.isFinite(n)) crawlDelayMs = Math.min(n * 1000, 10_000);
    }
  }
  return { disallow, crawlDelayMs };
}

export function isAllowedByRobots(rules: RobotsRules, pathname: string): boolean {
  return !rules.disallow.some((rule) => rule !== "/" && pathname.startsWith(rule))
    && !rules.disallow.includes("/");
}

export async function fetchArticle(
  url: string,
  opts: { timeoutMs?: number; respectRobots?: boolean } = {},
): Promise<ArticleFetchResult> {
  const host = normalizeHost(url);

  // Known blockers: do not attempt, do not route around (PRD v3 §3.7).
  if (isFetchBlocked(url)) {
    return { url, ok: false, text: "", paywalled: true, reason: "publisher blocks automated access" };
  }

  if (opts.respectRobots !== false) {
    try {
      const rules = await getRobots(host);
      const pathname = new URL(url).pathname;
      if (!isAllowedByRobots(rules, pathname)) {
        return { url, ok: false, text: "", paywalled: true, reason: "disallowed by robots.txt" };
      }
    } catch {
      /* URL parse failure falls through to the fetch, which will report it */
    }
  }

  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,*/*" },
      redirect: "follow",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
    });
    const contentType = res.headers.get("content-type") ?? "";
    if (!res.ok) {
      return {
        url,
        ok: false,
        text: "",
        paywalled: true,
        status: res.status,
        reason: `HTTP ${res.status}`,
        contentType,
      };
    }
    const raw = await res.text();
    const text = extractArticleText(raw);
    return {
      url,
      ok: text.length > 0,
      text,
      paywalled: text.length === 0,
      status: res.status,
      contentType,
      raw,
      reason: text.length === 0 ? "no extractable body" : undefined,
    };
  } catch (err) {
    return { url, ok: false, text: "", paywalled: true, reason: String(err).slice(0, 200) };
  }
}

/**
 * Extract the article body from an HTML page.
 *
 * Strategy in priority order, cheapest and most reliable first:
 *   1. JSON-LD `articleBody` — publisher-declared, no heuristics involved.
 *   2. The `<article>` element.
 *   3. The densest run of `<p>` tags on the page.
 *
 * Dependency-free by design: adding a headless browser or readability port for
 * this would be a large dependency for a job that three regexes do well enough.
 */
export function extractArticleText(html: string): string {
  const fromLd = extractJsonLdBody(html);
  if (fromLd && fromLd.length > 400) return fromLd;

  const article = html.match(/<article\b[\s\S]*?<\/article>/i)?.[0];
  const fromArticle = article ? paragraphText(article) : "";
  if (fromArticle.length > 400) return fromArticle;

  const fromPage = paragraphText(html);
  return fromPage.length > 250 ? fromPage : fromLd || fromArticle || "";
}

function extractJsonLdBody(html: string): string {
  const blocks =
    html.match(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) ?? [];
  for (const block of blocks) {
    const json = block.replace(/^[\s\S]*?>/, "").replace(/<\/script>$/i, "");
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      continue;
    }
    const body = findArticleBody(parsed);
    if (body) return cleanText(body);
  }
  return "";
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function findArticleBody(node: any, depth = 0): string | undefined {
  if (!node || depth > 6) return undefined;
  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findArticleBody(item, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  if (typeof node !== "object") return undefined;
  if (typeof node.articleBody === "string" && node.articleBody.length > 200) {
    return node.articleBody;
  }
  for (const value of Object.values(node)) {
    const found = findArticleBody(value, depth + 1);
    if (found) return found;
  }
  return undefined;
}

/** Concatenate <p> content, dropping short boilerplate lines. */
function paragraphText(html: string): string {
  const stripped = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const paras = stripped.match(/<p\b[^>]*>([\s\S]*?)<\/p>/gi) ?? [];
  const texts = paras
    .map((p) => cleanText(p.replace(/<[^>]+>/g, " ")))
    // Short fragments are almost always nav/caption/disclaimer furniture.
    .filter((t) => t.length > 60);
  return texts.join("\n\n");
}

function cleanText(s: string): string {
  return decodeEntities(s).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
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
