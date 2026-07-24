/**
 * Speech-to-text for audio/video sources (PRD v3 §2.2).
 *
 * Provider-neutral. Three backends are supported, selected by which credential
 * is present (see `selectAsrProvider`):
 *
 *   1. **ElevenLabs Scribe** — preferred. Returns word-level timestamps *and*
 *      speaker diarization in one call, which is what play-at-timestamp
 *      evidence links and speaker attribution both need.
 *   2. **Groq** `whisper-large-v3-turbo` — cheapest (~$0.04/hr, ~216x realtime),
 *      segment-level timestamps, no diarization.
 *   3. **OpenAI** `whisper-1` — fallback; segment timestamps, no diarization.
 *
 * **Anthropic is not an option here.** Claude has no speech-to-text endpoint —
 * its input modalities are text, images, PDFs and files — so audio must be
 * transcribed by a third party before the (possibly Claude-powered) analysis
 * layer ever sees it.
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
import { ElevenLabsScribeClient, scribeCostUsd } from "./asr-elevenlabs.ts";
import { OpenAiWhisperClient, whisperCostUsd } from "./asr-openai.ts";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import type { TranscriptSegment } from "../../types.ts";

export const DEFAULT_ASR_MODEL = "whisper-large-v3-turbo";
const GROQ_ENDPOINT = "https://api.groq.com/openai/v1/audio/transcriptions";

/**
 * A prepared chunk smaller than this is treated as "no audio here" — 16 kHz
 * mono FLAC of even a second of speech is far larger.
 */
export const MIN_CHUNK_BYTES = 2048;

/** Chunk length and overlap, in seconds. */
export const CHUNK_SECONDS = 1200; // 20 minutes
export const OVERLAP_SECONDS = 10;

export type AsrBackend = "elevenlabs" | "groq" | "openai";

export interface AsrOptions {
  /** Groq key (legacy single-key form; kept for backwards compatibility). */
  apiKey?: string;
  groqApiKey?: string;
  elevenLabsApiKey?: string;
  openaiApiKey?: string;
  /** Force a backend instead of auto-selecting by available credential. */
  backend?: AsrBackend;
  model?: string;
  /** Skip ffmpeg preprocessing (input is already 16 kHz mono). */
  raw?: boolean;
  timeoutMs?: number;
}

/**
 * Pick a backend from the credentials available.
 *
 * ElevenLabs first: it is the only one that returns diarization, and speaker
 * attribution is the gap this project actually has. Groq next on cost, then
 * OpenAI. Returns null when nothing is configured, so callers can degrade to
 * captions-only rather than failing a run.
 */
export function selectAsrProvider(opts: AsrOptions): AsrBackend | null {
  const groq = opts.groqApiKey || opts.apiKey;
  if (opts.backend) {
    const key =
      opts.backend === "elevenlabs" ? opts.elevenLabsApiKey
      : opts.backend === "openai" ? opts.openaiApiKey
      : groq;
    return key ? opts.backend : null;
  }
  if (opts.elevenLabsApiKey) return "elevenlabs";
  if (groq) return "groq";
  if (opts.openaiApiKey) return "openai";
  return null;
}

export interface AsrResult {
  model: string;
  segments: TranscriptSegment[];
  durationMs: number;
  chunks: number;
}

export class AsrClient {
  readonly backend: AsrBackend | null;
  private eleven?: ElevenLabsScribeClient;
  private openai?: OpenAiWhisperClient;

  constructor(private opts: AsrOptions) {
    this.backend = selectAsrProvider(opts);
    if (this.backend === "elevenlabs") {
      this.eleven = new ElevenLabsScribeClient({
        apiKey: opts.elevenLabsApiKey!,
        timeoutMs: opts.timeoutMs,
      });
    } else if (this.backend === "openai") {
      this.openai = new OpenAiWhisperClient({
        apiKey: opts.openaiApiKey!,
        timeoutMs: opts.timeoutMs,
      });
    }
  }

  get configured(): boolean {
    return this.backend !== null;
  }

  get model(): string {
    if (this.opts.model) return this.opts.model;
    if (this.backend === "elevenlabs") return this.eleven!.model;
    if (this.backend === "openai") return this.openai!.model;
    return DEFAULT_ASR_MODEL;
  }

  /** Estimated cost for a run, using the selected backend's rate card. */
  estimateCostUsd(durationMs: number): number {
    if (this.backend === "elevenlabs") return scribeCostUsd(durationMs);
    if (this.backend === "openai") return whisperCostUsd(durationMs);
    return estimateCostUsd(durationMs);
  }

  /**
   * Transcribe a local media file into timestamped segments.
   *
   * Chunks are transcribed sequentially and their offsets rebased onto the full
   * timeline, so `startMs` always refers to the original media.
   */
  async transcribeFile(path: string): Promise<AsrResult> {
    if (!this.configured) {
      throw new Error(
        "ASR requires one of ELEVENLABS_API_KEY (preferred — adds diarization), GROQ_API_KEY, or OPENAI_API_KEY (PRD v3 §2.2). Anthropic has no speech-to-text endpoint.",
      );
    }
    const durationMs = await probeDurationMs(path);
    const chunkPlan = planChunks(durationMs);
    const segments: TranscriptSegment[] = [];

    for (const chunk of chunkPlan) {
      const prepared = await prepareAudio(path, chunk.startMs, chunk.durationMs, this.opts.raw);
      try {
        // A container's declared duration can exceed the audio actually present
        // (truncated download, still-streaming file, damaged container). Seeking
        // past the real end yields an empty file, which ASR APIs reject as
        // corrupt — so stop here rather than posting silence.
        if ((await Bun.file(prepared).arrayBuffer()).byteLength < MIN_CHUNK_BYTES) {
          break;
        }
        const parts = await this.transcribeChunk(prepared);
        for (const seg of parts) {
          const segStart = seg.startMs ?? 0;
          // Drop anything landing inside the overlap of a previous chunk.
          if (chunk.startMs > 0 && segStart < OVERLAP_SECONDS * 1000) continue;
          segments.push({
            ...seg,
            index: segments.length,
            startMs: chunk.startMs + segStart,
            endMs: seg.endMs == null ? undefined : chunk.startMs + seg.endMs,
          });
        }
      } finally {
        await unlink(prepared).catch(() => {});
      }
    }

    return { model: this.model, segments, durationMs, chunks: chunkPlan.length };
  }

  /** Dispatch one prepared chunk to the selected backend. */
  private async transcribeChunk(path: string): Promise<TranscriptSegment[]> {
    if (this.backend === "elevenlabs") return this.eleven!.transcribe(path);
    if (this.backend === "openai") return this.openai!.transcribe(path);
    return (await this.postChunkGroq(path)).map((c, index) => ({
      index,
      text: c.text,
      startMs: c.startMs,
      endMs: c.endMs,
    }));
  }

  private async postChunkGroq(path: string): Promise<Cue[]> {
    const form = new FormData();
    form.append("file", new Blob([await Bun.file(path).arrayBuffer()]), "audio.flac");
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");

    const res = await fetch(GROQ_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.groqApiKey || this.opts.apiKey}` },
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
