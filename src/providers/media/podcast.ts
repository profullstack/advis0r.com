/**
 * Podcast discovery (PRD v3 §2.1).
 *
 * Verified end-to-end on 2026-07-24 against BG2Pod:
 *   iTunes Search API (keyless) -> feedUrl -> RSS -> <enclosure ...mp3>
 *
 * The iTunes path needs no credentials at all, which makes it the default.
 * Podcast Index (~4M feeds, free for any use) is supported as a second index
 * when a key is configured.
 */
const ITUNES_SEARCH = "https://itunes.apple.com/search";
const PODCASTINDEX_SEARCH = "https://api.podcastindex.org/api/1.0/search/byterm";

const UA =
  process.env.SEC_USER_AGENT?.replace(/^"|"$/g, "") ??
  "advis0r.com research (anthony@profullstack.com)";

export interface PodcastFeed {
  name: string;
  feedUrl: string;
  publisher?: string;
  source: "itunes" | "podcastindex";
}

export interface PodcastEpisode {
  title: string;
  audioUrl: string;
  pageUrl?: string;
  publishedAt?: string;
  durationMs?: number;
  bytes?: number;
  feedName: string;
}

/** Keyless podcast search. */
export async function searchItunes(term: string, limit = 5): Promise<PodcastFeed[]> {
  const url = `${ITUNES_SEARCH}?term=${encodeURIComponent(term)}&entity=podcast&limit=${limit}`;
  const res = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`iTunes search ${res.status}`);
  const body = (await res.json()) as any;
  return (body?.results ?? [])
    .filter((r: any) => r?.feedUrl)
    .map((r: any) => ({
      name: String(r.collectionName ?? r.trackName ?? "podcast"),
      feedUrl: String(r.feedUrl),
      publisher: r.artistName ? String(r.artistName) : undefined,
      source: "itunes" as const,
    }));
}

/**
 * Podcast Index search. Auth is a SHA-1 of key + secret + unix time, per their
 * spec; returns [] rather than throwing when unconfigured so callers can treat
 * it as an optional enrichment.
 */
export async function searchPodcastIndex(
  term: string,
  creds: { key?: string; secret?: string },
  limit = 5,
): Promise<PodcastFeed[]> {
  if (!creds.key || !creds.secret) return [];
  const now = Math.floor(Date.now() / 1000);
  const hasher = new Bun.CryptoHasher("sha1");
  hasher.update(`${creds.key}${creds.secret}${now}`);
  const res = await fetch(`${PODCASTINDEX_SEARCH}?q=${encodeURIComponent(term)}&max=${limit}`, {
    headers: {
      "User-Agent": UA,
      "X-Auth-Key": creds.key,
      "X-Auth-Date": String(now),
      Authorization: hasher.digest("hex"),
    },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) return [];
  const body = (await res.json()) as any;
  return (body?.feeds ?? [])
    .filter((f: any) => f?.url)
    .map((f: any) => ({
      name: String(f.title ?? "podcast"),
      feedUrl: String(f.url),
      publisher: f.author ? String(f.author) : undefined,
      source: "podcastindex" as const,
    }));
}

/** Fetch a podcast feed and extract episodes with their audio enclosures. */
export async function fetchEpisodes(
  feed: PodcastFeed,
  limit = 20,
): Promise<PodcastEpisode[]> {
  const res = await fetch(feed.feedUrl, {
    headers: { "User-Agent": UA, Accept: "application/rss+xml, application/xml, text/xml, */*" },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`podcast feed ${feed.feedUrl} -> ${res.status}`);
  return parseEpisodes(await res.text(), feed.name).slice(0, limit);
}

/** Parse `<item>` blocks into episodes. Only items with audio are returned. */
export function parseEpisodes(xml: string, feedName: string): PodcastEpisode[] {
  const out: PodcastEpisode[] = [];
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  for (const item of items) {
    const enclosure = item.match(/<enclosure\b[^>]*>/i)?.[0];
    if (!enclosure) continue;
    const audioUrl = enclosure.match(/url="([^"]+)"/i)?.[1];
    const type = enclosure.match(/type="([^"]+)"/i)?.[1] ?? "";
    if (!audioUrl || !/audio|video|mpeg|mp4|mp3/i.test(type)) continue;

    const pub = tag(item, "pubDate");
    const parsed = pub ? Date.parse(pub) : Number.NaN;
    out.push({
      title: decode(tag(item, "title") ?? "episode"),
      audioUrl: decode(audioUrl),
      pageUrl: tag(item, "link") ? decode(tag(item, "link")!) : undefined,
      publishedAt: Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10),
      durationMs: parseDuration(tag(item, "itunes:duration")),
      bytes: Number(enclosure.match(/length="(\d+)"/i)?.[1] ?? 0) || undefined,
      feedName,
    });
  }
  return out;
}

function tag(block: string, name: string): string | undefined {
  const m = block.match(new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  return m ? m[1]!.trim() : undefined;
}

/** `itunes:duration` is either seconds or `HH:MM:SS`. */
export function parseDuration(raw?: string): number | undefined {
  if (!raw) return undefined;
  const text = raw.replace(/<[^>]+>/g, "").trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  if (/^\d{1,2}(:\d{2}){1,2}$/.test(text)) {
    let seconds = 0;
    for (const part of text.split(":")) seconds = seconds * 60 + Number(part);
    return seconds * 1000;
  }
  return undefined;
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .trim();
}

/**
 * Does an episode plausibly concern this company?
 *
 * Deliberately conservative: podcast feeds are broad, and a false match would
 * attribute another company's statements to this ticker — a grounding failure
 * far worse than missing an episode.
 */
export function episodeMentions(
  episode: { title: string },
  ticker: string,
  companyName?: string,
): boolean {
  const title = episode.title;
  if (new RegExp(`\\b\\$?${ticker}\\b`).test(title)) return true;
  if (!companyName) return false;
  const core = companyName
    .replace(/\b(inc|corp|corporation|company|co|ltd|plc|holdings|group)\b\.?/gi, "")
    .replace(/[^A-Za-z0-9 ]/g, "")
    .trim();
  return core.length > 3 && title.toLowerCase().includes(core.toLowerCase());
}
