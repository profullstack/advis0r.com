/**
 * Speech-to-text for audio/video sources (PRD v3 §2.2).
 *
 * Groq `whisper-large-v3-turbo` is ~$0.04 per hour of audio at ~216x realtime —
 * covering 250 tickers x 4 calls/year costs roughly $40/year, so ASR cost is
 * immaterial next to engineering time.
 *
 * Two practical constraints shape this module:
 *   - There is a per-request file-size cap, so audio is downsampled to 16 kHz
 *     mono FLAC and chunked, with overlap so a sentence spanning a chunk edge
 *     is not lost.
 *   - Billing has a 10-second minimum per request, so very short clips are not
 *     worth splitting further.
 *
 * Grounding: ASR output is DERIVED text, not a verbatim record. Callers must
 * carry `provenance: "asr"` plus the model identity through to storage so a
 * mis-transcribed figure is never presented as a quote (PRD §8.4).
 */
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { TranscriptSegment } from "../../types.ts";

export const DEFAULT_ASR_MODEL = "whisper-large-v3-turbo";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

/** Chunk length and overlap, in seconds. */
export const CHUNK_SECONDS = 1200; // 20 minutes
export const OVERLAP_SECONDS = 10;

export interface AsrOptions {
  apiKey: string;
  model?: string;
  /** Skip ffmpeg preprocessing (input is already 16 kHz mono). */
  raw?: boolean;
  timeoutMs?: number;
}

export interface AsrResult {
  model: string;
  segments: TranscriptSegment[];
  durationMs: number;
  chunks: number;
}

export class AsrClient {
  constructor(private opts: AsrOptions) {}

  get configured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  get model(): string {
    return this.opts.model ?? DEFAULT_ASR_MODEL;
  }

  /**
   * Transcribe a local media file into timestamped segments.
   *
   * Chunks are transcribed sequentially and their offsets rebased onto the full
   * timeline, so `startMs` always refers to the original media.
   */
  async transcribeFile(path: string): Promise<AsrResult> {
    if (!this.configured) {
      throw new Error("ASR requires GROQ_API_KEY (PRD v3 §2.2)");
    }
    const durationMs = await probeDurationMs(path);
    const chunkPlan = planChunks(durationMs);
    const segments: TranscriptSegment[] = [];

    for (const chunk of chunkPlan) {
      const prepared = await prepareAudio(path, chunk.startMs, chunk.durationMs, this.opts.raw);
      try {
        const verbose = await this.postChunk(prepared);
        for (const seg of verbose) {
          const startMs = chunk.startMs + seg.startMs;
          // Drop anything landing inside the overlap of a previous chunk.
          if (chunk.startMs > 0 && seg.startMs < OVERLAP_SECONDS * 1000) continue;
          segments.push({
            index: segments.length,
            text: seg.text,
            startMs,
            endMs: chunk.startMs + seg.endMs,
          });
        }
      } finally {
        await unlink(prepared).catch(() => {});
      }
    }

    return { model: this.model, segments, durationMs, chunks: chunkPlan.length };
  }

  private async postChunk(path: string): Promise<Cue[]> {
    const form = new FormData();
    form.append("file", new Blob([await Bun.file(path).arrayBuffer()]), "audio.flac");
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");

    const res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 300_000),
    });
    if (!res.ok) {
      throw new Error(`Groq ASR ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return parseVerboseJson(await res.json());
  }
}

interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Map Whisper `verbose_json` segments to millisecond cues. */
export function parseVerboseJson(body: any): Cue[] {
  const rows: any[] = body?.segments ?? [];
  if (rows.length === 0 && typeof body?.text === "string" && body.text.trim()) {
    return [{ startMs: 0, endMs: 0, text: body.text.trim() }];
  }
  return rows
    .map((r) => ({
      startMs: Math.round(Number(r?.start ?? 0) * 1000),
      endMs: Math.round(Number(r?.end ?? 0) * 1000),
      text: String(r?.text ?? "").trim(),
    }))
    .filter((c) => c.text.length > 0);
}

export interface ChunkPlan {
  startMs: number;
  durationMs: number;
}

/**
 * Split a duration into overlapping chunks. Each chunk after the first starts
 * `OVERLAP_SECONDS` early so a sentence crossing the boundary is transcribed
 * intact; the duplicate portion is discarded on the way back out.
 */
export function planChunks(
  durationMs: number,
  chunkSeconds = CHUNK_SECONDS,
  overlapSeconds = OVERLAP_SECONDS,
): ChunkPlan[] {
  const chunkMs = chunkSeconds * 1000;
  const overlapMs = overlapSeconds * 1000;
  if (durationMs <= 0) return [{ startMs: 0, durationMs: 0 }];
  if (durationMs <= chunkMs) return [{ startMs: 0, durationMs }];

  const plans: ChunkPlan[] = [];
  let cursor = 0;
  while (cursor < durationMs) {
    const startMs = cursor === 0 ? 0 : cursor - overlapMs;
    const remaining = durationMs - startMs;
    plans.push({ startMs, durationMs: Math.min(chunkMs + overlapMs, remaining) });
    cursor += chunkMs;
  }
  return plans;
}

/** Media duration in ms via ffprobe; 0 when it cannot be determined. */
export async function probeDurationMs(path: string): Promise<number> {
  const proc = Bun.spawn(
    [
      "ffprobe", "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      path,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  const seconds = Number(out);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

/**
 * Downsample a slice of media to 16 kHz mono FLAC — the format Whisper expects,
 * and roughly an order of magnitude smaller than the source mp3, which is what
 * keeps chunks inside the upload cap.
 */
export async function prepareAudio(
  input: string,
  startMs: number,
  durationMs: number,
  raw = false,
): Promise<string> {
  const out = join(tmpdir(), `advis0r-asr-${randomBytes(8).toString("hex")}.flac`);
  const args = ["ffmpeg", "-nostdin", "-v", "error", "-y"];
  if (startMs > 0) args.push("-ss", (startMs / 1000).toFixed(3));
  args.push("-i", input);
  if (durationMs > 0) args.push("-t", (durationMs / 1000).toFixed(3));
  if (!raw) args.push("-ar", "16000", "-ac", "1");
  args.push("-c:a", "flac", out);

  const proc = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`ffmpeg failed (${code}): ${err.slice(0, 300)}`);
  }
  return out;
}

/** Estimated ASR cost in USD, for budget reporting. */
export function estimateCostUsd(durationMs: number, usdPerHour = 0.04): number {
  return Math.round((durationMs / 3_600_000) * usdPerHour * 10_000) / 10_000;
}
