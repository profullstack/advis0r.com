/**
 * Media transcript provider — audio & video appearances (PRD v3 §2).
 *
 * Covers the sources the product name always implied but never indexed:
 * earnings-call replays, keynotes, conference talks, fireside chats,
 * interviews and podcasts.
 *
 * Retrieval order is deliberate, cheapest and most faithful first:
 *   1. Author-provided captions  — verbatim, free, already timestamped.
 *   2. Auto-generated captions   — derived, free, already timestamped.
 *   3. ASR (Groq Whisper)        — derived, ~$0.04/hr, for audio with no captions.
 *
 * Media itself is never retained. We keep the source URL, a checksum, the
 * duration and the transcript; a single podcast episode is ~77 MB where its
 * transcript is ~60 KB.
 */
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type {
  DownloadedDocument,
  EventType,
  ParsedTranscript,
  SourceDocument,
  TranscriptQuery,
  TranscriptSegment,
} from "../../types.ts";
import { BaseTranscriptProvider } from "../transcripts/base.ts";
import { attributeSegments } from "../../signals/speakers.ts";
import { AsrClient } from "./asr.ts";
import { parseCaptionsToSegments } from "./captions.ts";
import { episodeMentions, fetchEpisodes, searchItunes, searchPodcastIndex } from "./podcast.ts";
import {
  channelVideos,
  downloadAudio,
  fetchCaptions,
  searchVideos,
  videoId,
  ytDlpAvailable,
} from "./youtube.ts";

export interface MediaProviderOptions {
  downloadsDir: string;
  /** Preferred ASR backend — adds speaker diarization (PRD v3 §2.2). */
  elevenLabsApiKey?: string;
  groqApiKey?: string;
  openaiApiKey?: string;
  podcastIndexKey?: string;
  podcastIndexSecret?: string;
  /** Max media items per ticker per run — ASR is cheap but not free. */
  perTicker?: number;
  /** Allow ASR fallback when no captions exist. */
  allowAsr?: boolean;
  /** Extra channel/playlist URLs to sweep (e.g. company IR channels). */
  channels?: string[];
}

/** Query templates that surface executive speech rather than commentary. */
const VIDEO_QUERIES = [
  (name: string) => `${name} earnings call`,
  (name: string) => `${name} investor day presentation`,
  (name: string) => `${name} CEO interview`,
];

export class MediaProvider extends BaseTranscriptProvider {
  id = "media";
  private asr: AsrClient;
  private companyNames = new Map<string, string>();
  /** Parsed transcripts keyed by document id, produced during download(). */
  private prepared = new Map<string, ParsedTranscript>();

  constructor(private options: MediaProviderOptions) {
    super(options.downloadsDir);
    this.asr = new AsrClient({
      elevenLabsApiKey: options.elevenLabsApiKey,
      groqApiKey: options.groqApiKey,
      openaiApiKey: options.openaiApiKey,
    });
  }

  setCompanyNames(names: Map<string, string>): void {
    this.companyNames = names;
  }

  get asrConfigured(): boolean {
    return this.asr.configured;
  }

  /** Which ASR backend was selected, or null when none is configured. */
  get asrBackend(): string | null {
    return this.asr.backend;
  }

  async search(query: TranscriptQuery): Promise<SourceDocument[]> {
    const tickers = (query.tickers ?? [])
      .filter((t) => !t.includes("http"))
      .map((t) => t.toUpperCase());
    if (tickers.length === 0) return [];

    const perTicker = this.options.perTicker ?? 4;
    const hasYtDlp = await ytDlpAvailable();
    const out = new Map<string, SourceDocument>();

    for (const ticker of tickers) {
      const name = this.companyNames.get(ticker) ?? ticker;
      let kept = 0;

      if (hasYtDlp) {
        for (const build of VIDEO_QUERIES) {
          if (kept >= perTicker) break;
          let videos: Awaited<ReturnType<typeof searchVideos>> = [];
          try {
            videos = await searchVideos(build(name), 3);
          } catch {
            continue; // a failed search degrades the run
          }
          for (const video of videos) {
            if (kept >= perTicker) break;
            if (out.has(video.url)) continue;
            if (query.from && video.uploadDate && video.uploadDate < query.from.slice(0, 10)) continue;
            out.set(video.url, {
              id: `yt:${video.id}`,
              providerId: this.id,
              title: video.title,
              url: video.url,
              eventType: classifyVideo(video.title),
              publishedAt: video.uploadDate,
              tickers: [ticker],
              publisher: video.channel ?? "YouTube",
              // Video of an executive speaking is a primary record.
              sourceTier: 0,
              mediaUrl: video.url,
              mediaType: "video",
              durationMs: video.durationMs,
              meta: { channel: video.channel, source: "youtube" },
            });
            kept++;
          }
        }

        for (const channel of this.options.channels ?? []) {
          try {
            for (const video of await channelVideos(channel, 5)) {
              if (out.has(video.url)) continue;
              out.set(video.url, {
                id: `yt:${video.id}`,
                providerId: this.id,
                title: video.title,
                url: video.url,
                eventType: classifyVideo(video.title),
                publishedAt: video.uploadDate,
                tickers: [ticker],
                publisher: video.channel ?? "YouTube",
                sourceTier: 0,
                mediaUrl: video.url,
                mediaType: "video",
                durationMs: video.durationMs,
                meta: { channel: video.channel, source: "youtube-channel" },
              });
            }
          } catch {
            /* best effort */
          }
        }
      }

      // Podcasts: only worth fetching when ASR is available, since episodes
      // rarely ship transcripts.
      if (this.asr.configured && kept < perTicker) {
        try {
          const feeds = [
            ...(await searchItunes(name, 3)),
            ...(await searchPodcastIndex(name, {
              key: this.options.podcastIndexKey,
              secret: this.options.podcastIndexSecret,
            })),
          ];
          for (const feed of feeds) {
            if (kept >= perTicker) break;
            let episodes: Awaited<ReturnType<typeof fetchEpisodes>> = [];
            try {
              episodes = await fetchEpisodes(feed, 20);
            } catch {
              continue;
            }
            for (const ep of episodes) {
              if (kept >= perTicker) break;
              if (!episodeMentions(ep, ticker, this.companyNames.get(ticker))) continue;
              if (out.has(ep.audioUrl)) continue;
              if (query.from && ep.publishedAt && ep.publishedAt < query.from.slice(0, 10)) continue;
              out.set(ep.audioUrl, {
                id: `pod:${createHash("sha256").update(ep.audioUrl).digest("hex").slice(0, 24)}`,
                providerId: this.id,
                title: `${ep.feedName}: ${ep.title}`,
                url: ep.pageUrl ?? ep.audioUrl,
                eventType: "podcast",
                publishedAt: ep.publishedAt,
                tickers: [ticker],
                publisher: feed.publisher ?? feed.name,
                // Third-party podcast: reputable, but not the issuer speaking
                // on its own record.
                sourceTier: 1,
                mediaUrl: ep.audioUrl,
                mediaType: "audio",
                durationMs: ep.durationMs,
                meta: { feed: feed.name, source: feed.source },
              });
              kept++;
            }
          }
        } catch {
          /* best effort */
        }
      }
    }

    return [...out.values()];
  }

  /**
   * Resolve the document to a transcript and persist a checksummed artifact.
   *
   * The transcript (not the media) is what gets written to disk: it is the
   * auditable record, and retaining hours of source audio has no analytical
   * value (PRD §26, PRD v3 §2.2).
   */
  async download(document: SourceDocument): Promise<DownloadedDocument> {
    let segments: TranscriptSegment[] = [];
    let provenance: ParsedTranscript["provenance"] = "captions";
    let asrModel: string | undefined;
    let durationMs = document.durationMs;
    let note = "";

    if (document.mediaType === "video") {
      const caps = await fetchCaptions(document.url);
      if (caps.vtt) {
        segments = parseCaptionsToSegments(caps.vtt);
        provenance = "captions";
        note = caps.manual ? "author-provided captions" : "auto-generated captions";
      } else if (this.options.allowAsr !== false && this.asr.configured) {
        const dir = await mkdtemp(join(tmpdir(), "advis0r-media-"));
        try {
          const audio = await downloadAudio(document.url, dir);
          if (audio) {
            const result = await this.asr.transcribeFile(audio);
            segments = result.segments;
            provenance = "asr";
            asrModel = result.model;
            durationMs = result.durationMs;
            note = `ASR ${this.asr.backend}:${result.model}, ~$${this.asr.estimateCostUsd(result.durationMs)}`;
          }
        } finally {
          await rm(dir, { recursive: true, force: true }).catch(() => {});
        }
      }
    } else if (document.mediaType === "audio" && document.mediaUrl) {
      if (this.options.allowAsr === false || !this.asr.configured) {
        throw new Error(
          "audio source requires an ASR key: ELEVENLABS_API_KEY (preferred), GROQ_API_KEY, or OPENAI_API_KEY (PRD v3 §2.2)",
        );
      }
      const local = await this.fetchMedia(document.mediaUrl);
      try {
        const result = await this.asr.transcribeFile(local);
        segments = result.segments;
        provenance = "asr";
        asrModel = result.model;
        durationMs = result.durationMs;
        note = `ASR ${this.asr.backend}:${result.model}, ~$${this.asr.estimateCostUsd(result.durationMs)}`;
      } finally {
        await unlink(local).catch(() => {});
      }
    }

    if (segments.length === 0) {
      throw new Error(`no transcript available for ${document.url}${note ? ` (${note})` : ""}`);
    }

    // Attribute speakers before persisting so signals inherit them.
    segments = attributeSegments(segments);

    const payload = JSON.stringify({ segments, provenance, asrModel, note });
    const checksum = createHash("sha256").update(payload).digest("hex");
    await mkdir(this.downloadsDir, { recursive: true });
    const localPath = join(this.downloadsDir, `${checksum.slice(0, 16)}.transcript.json`);
    await Bun.write(localPath, payload);

    this.prepared.set(document.id, {
      ...document,
      localPath,
      contentType: "application/json",
      checksum,
      fetchedAt: new Date().toISOString(),
      segments,
      provenance,
      asrModel,
      asrVersion: asrModel ? "groq-v1" : undefined,
    });

    return {
      ...document,
      durationMs,
      localPath,
      contentType: "application/json",
      checksum,
      fetchedAt: new Date().toISOString(),
      meta: { ...(document.meta ?? {}), transcriptSource: note },
    };
  }

  async parse(document: DownloadedDocument): Promise<ParsedTranscript> {
    const prepared = this.prepared.get(document.id);
    if (prepared) return { ...prepared, ...document, segments: prepared.segments };

    // Re-read from the persisted artifact (e.g. a re-parse without re-fetch).
    const raw = JSON.parse(await Bun.file(document.localPath).text());
    return {
      ...document,
      segments: (raw.segments ?? []) as TranscriptSegment[],
      provenance: raw.provenance ?? "captions",
      asrModel: raw.asrModel,
    };
  }

  /** Download media to a temp file for transcription; never retained. */
  private async fetchMedia(url: string): Promise<string> {
    const res = await fetch(url, {
      headers: { "User-Agent": "advis0r.com research (anthony@profullstack.com)" },
      redirect: "follow",
      signal: AbortSignal.timeout(300_000),
    });
    if (!res.ok) throw new Error(`media download ${url} -> ${res.status}`);
    const dir = await mkdtemp(join(tmpdir(), "advis0r-audio-"));
    const path = join(dir, "media.bin");
    await Bun.write(path, await res.arrayBuffer());
    return path;
  }
}

/** Map a video title onto the event taxonomy. */
export function classifyVideo(title: string): EventType {
  const t = title.toLowerCase();
  if (/earnings call|q[1-4]\s+20\d\d|quarterly results/.test(t)) return "earnings_call";
  if (/investor day|analyst day|capital markets day/.test(t)) return "investor_day";
  if (/keynote/.test(t)) return "keynote";
  if (/fireside/.test(t)) return "fireside_chat";
  if (/interview|sits down|in conversation/.test(t)) return "interview";
  if (/conference|summit|symposium/.test(t)) return "conference_talk";
  if (/podcast|episode/.test(t)) return "podcast";
  return "video";
}

export { videoId };
