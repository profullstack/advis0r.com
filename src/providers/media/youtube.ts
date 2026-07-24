/**
 * YouTube ingestion for keynotes, conference talks, interviews and IR channels
 * (PRD v3 §2.1).
 *
 * Captions are strongly preferred over ASR: they are free, already timestamped,
 * and when a channel uploads its own captions they are verbatim rather than
 * machine-derived. `yt-dlp` is invoked as a subprocess for both caption
 * retrieval and audio extraction.
 *
 * Everything here degrades rather than throws — a video without captions falls
 * back to audio + ASR, and an unavailable `yt-dlp` disables the provider
 * instead of failing a run.
 */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface YouTubeVideo {
  id: string;
  title: string;
  url: string;
  channel?: string;
  uploadDate?: string; // ISO date
  durationMs?: number;
}

export interface CaptionResult {
  /** Raw VTT text, empty when the video has no usable captions. */
  vtt: string;
  /** True when captions were author-provided rather than auto-generated. */
  manual: boolean;
}

/** Is `yt-dlp` available on PATH? */
export async function ytDlpAvailable(): Promise<boolean> {
  try {
    const proc = Bun.spawn(["yt-dlp", "--version"], { stdout: "pipe", stderr: "pipe" });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

/**
 * Authentication arguments for yt-dlp.
 *
 * YouTube bot-blocks datacenter IPs ("Sign in to confirm you're not a bot"),
 * so a server-side run needs cookies. Both supported forms are opt-in via env:
 *
 *   YTDLP_COOKIES=/path/to/cookies.txt     exported cookies file
 *   YTDLP_COOKIES_FROM_BROWSER=firefox     read from a local browser profile
 *
 * With neither set the extractor still runs; it simply fails on videos that
 * require authentication, which `isBotBlocked` reports explicitly rather than
 * letting it look like "this video has no captions".
 */
export function authArgs(): string[] {
  const file = process.env.YTDLP_COOKIES;
  if (file) return ["--cookies", file];
  const browser = process.env.YTDLP_COOKIES_FROM_BROWSER;
  if (browser) return ["--cookies-from-browser", browser];
  return [];
}

/** Distinguish "blocked" from "genuinely has no captions". */
export function isBotBlocked(stderr: string): boolean {
  return /confirm you.?re not a bot|Sign in to confirm|cookies are no longer valid|HTTP Error 429/i.test(
    stderr,
  );
}

export class YouTubeBlockedError extends Error {
  constructor(url: string) {
    super(
      `YouTube requires authentication for ${url}. Set YTDLP_COOKIES=/path/to/cookies.txt or ` +
        `YTDLP_COOKIES_FROM_BROWSER=<browser> (PRD v3 §2.1).`,
    );
    this.name = "YouTubeBlockedError";
  }
}

async function runJson(args: string[], timeoutMs = 120_000): Promise<any[]> {
  const proc = Bun.spawn([...args, ...authArgs()], { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  try {
    const [text, err] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    if (!text.trim() && isBotBlocked(err)) throw new YouTubeBlockedError(args[1] ?? "youtube");
    return text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Search YouTube without an API key via yt-dlp's `ytsearch` pseudo-extractor.
 * Metadata only — nothing is downloaded here.
 */
export async function searchVideos(query: string, limit = 5): Promise<YouTubeVideo[]> {
  const rows = await runJson([
    "yt-dlp",
    `ytsearch${limit}:${query}`,
    "--dump-json",
    "--flat-playlist",
    "--no-warnings",
    "--ignore-errors",
  ]);
  return rows.filter((r) => r?.id).map(toVideo);
}

/** Latest uploads from a channel or playlist URL. */
export async function channelVideos(url: string, limit = 10): Promise<YouTubeVideo[]> {
  const rows = await runJson([
    "yt-dlp",
    url,
    "--dump-json",
    "--flat-playlist",
    "--playlist-end",
    String(limit),
    "--no-warnings",
    "--ignore-errors",
  ]);
  return rows.filter((r) => r?.id).map(toVideo);
}

function toVideo(r: any): YouTubeVideo {
  const upload = typeof r.upload_date === "string" && /^\d{8}$/.test(r.upload_date)
    ? `${r.upload_date.slice(0, 4)}-${r.upload_date.slice(4, 6)}-${r.upload_date.slice(6, 8)}`
    : undefined;
  return {
    id: String(r.id),
    title: String(r.title ?? r.id),
    url: String(r.webpage_url ?? r.url ?? `https://www.youtube.com/watch?v=${r.id}`),
    channel: r.channel ?? r.uploader ?? undefined,
    uploadDate: upload,
    durationMs: Number.isFinite(r.duration) ? Math.round(Number(r.duration) * 1000) : undefined,
  };
}

/**
 * Fetch captions for a video, preferring author-provided tracks over
 * auto-generated ones. Returns empty VTT when neither exists.
 */
export async function fetchCaptions(url: string, lang = "en"): Promise<CaptionResult> {
  const dir = await mkdtemp(join(tmpdir(), "advis0r-yt-"));
  let blocked = false;
  try {
    for (const manual of [true, false]) {
      const args = [
        "yt-dlp", url,
        "--skip-download",
        manual ? "--write-subs" : "--write-auto-subs",
        "--sub-langs", `${lang}.*,${lang}`,
        "--sub-format", "vtt",
        "--no-warnings",
        "--ignore-errors",
        "-o", join(dir, "cap.%(ext)s"),
      ];
      const proc = Bun.spawn([...args, ...authArgs()], { stdout: "pipe", stderr: "pipe" });
      const timer = setTimeout(() => proc.kill(), 180_000);
      const stderr = await new Response(proc.stderr).text();
      await proc.exited;
      clearTimeout(timer);
      if (isBotBlocked(stderr)) blocked = true;

      const files = (await readdir(dir)).filter((f) => f.endsWith(".vtt"));
      if (files.length > 0) {
        const vtt = await readFile(join(dir, files[0]!), "utf8");
        if (vtt.trim().length > 0) return { vtt, manual };
      }
    }
    // An authentication block is reported, never silently returned as "no
    // captions" — the two need very different operator responses.
    if (blocked) throw new YouTubeBlockedError(url);
    return { vtt: "", manual: false };
  } catch (err) {
    if (err instanceof YouTubeBlockedError) throw err;
    return { vtt: "", manual: false };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Download audio only, for videos with no captions. Returns the local path.
 *
 * Audio-only keeps the download small; the file is transient and deleted by the
 * caller once transcribed (we retain the transcript, never the media).
 */
export async function downloadAudio(url: string, destDir: string): Promise<string | null> {
  const template = join(destDir, "%(id)s.%(ext)s");
  const proc = Bun.spawn(
    [
      "yt-dlp", url,
      "-f", "bestaudio/best",
      "--extract-audio",
      "--audio-format", "flac",
      "--postprocessor-args", "ffmpeg:-ar 16000 -ac 1",
      "--no-warnings",
      "--ignore-errors",
      "-o", template,
      ...authArgs(),
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const timer = setTimeout(() => proc.kill(), 600_000);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code !== 0) return null;

  const id = videoId(url);
  const files = await readdir(destDir).catch(() => [] as string[]);
  const match = files.find((f) => (id ? f.startsWith(id) : false) && f.endsWith(".flac"));
  return match ? join(destDir, match) : null;
}

export function videoId(url: string): string | null {
  const m =
    url.match(/[?&]v=([A-Za-z0-9_-]{6,})/) ??
    url.match(/youtu\.be\/([A-Za-z0-9_-]{6,})/) ??
    url.match(/\/shorts\/([A-Za-z0-9_-]{6,})/);
  return m ? m[1]! : null;
}

/** Deep link to a timestamp — the "hear the CEO say it" evidence link. */
export function timestampUrl(url: string, startMs: number): string {
  const seconds = Math.max(0, Math.floor(startMs / 1000));
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}t=${seconds}`;
}
