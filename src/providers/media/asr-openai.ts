/**
 * OpenAI Whisper speech-to-text (PRD v3 §2.2).
 *
 * A fallback ASR backend. `whisper-1` is used rather than the newer
 * `gpt-4o-transcribe` models because only `whisper-1` supports
 * `response_format=verbose_json`, and therefore only it returns the segment
 * timestamps that play-at-timestamp evidence links depend on. A transcript
 * without offsets would lose the feature that makes media evidence useful.
 *
 * Anthropic is deliberately absent from the ASR provider list: Claude has no
 * speech-to-text endpoint (its input modalities are text, images, PDFs and
 * files), so audio must be transcribed elsewhere before the analysis layer —
 * which may still be Claude — ever sees it.
 */
import type { TranscriptSegment } from "../../types.ts";

const ENDPOINT = "https://api.openai.com/v1/audio/transcriptions";
export const WHISPER_MODEL = "whisper-1";

export interface OpenAiAsrOptions {
  apiKey: string;
  model?: string;
  timeoutMs?: number;
}

export class OpenAiWhisperClient {
  constructor(private opts: OpenAiAsrOptions) {}

  get configured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  get model(): string {
    return this.opts.model ?? WHISPER_MODEL;
  }

  async transcribe(path: string): Promise<TranscriptSegment[]> {
    if (!this.configured) throw new Error("OpenAI ASR requires OPENAI_API_KEY");

    const form = new FormData();
    form.append("file", new Blob([await Bun.file(path).arrayBuffer()]), "audio.flac");
    form.append("model", this.model);
    form.append("response_format", "verbose_json");
    form.append("temperature", "0");

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${this.opts.apiKey}` },
      body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 600_000),
    });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300);
      // `insufficient_quota` is a billing state, not a transient failure —
      // surface it plainly so it is not mistaken for a rate limit and retried.
      if (res.status === 429 && body.includes("insufficient_quota")) {
        throw new Error(
          "OpenAI ASR unavailable: the API key has no remaining quota (insufficient_quota). Add credits or configure ELEVENLABS_API_KEY.",
        );
      }
      throw new Error(`OpenAI Whisper ${res.status}: ${body}`);
    }
    return verboseJsonToSegments(await res.json());
  }
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Map Whisper `verbose_json` segments to timestamped transcript segments. */
export function verboseJsonToSegments(body: any): TranscriptSegment[] {
  const rows: any[] = body?.segments ?? [];
  if (rows.length === 0) {
    const text = String(body?.text ?? "").trim();
    return text ? [{ index: 0, text, startMs: 0 }] : [];
  }
  return rows
    .map((r, index) => ({
      index,
      text: String(r?.text ?? "").trim(),
      startMs: Math.round(Number(r?.start ?? 0) * 1000),
      endMs: Math.round(Number(r?.end ?? 0) * 1000),
    }))
    .filter((s) => s.text.length > 0)
    .map((s, index) => ({ ...s, index }));
}

/** whisper-1 list price is $0.006 per minute of audio. */
export function whisperCostUsd(durationMs: number, usdPerMinute = 0.006): number {
  return Math.round((durationMs / 60_000) * usdPerMinute * 10_000) / 10_000;
}
