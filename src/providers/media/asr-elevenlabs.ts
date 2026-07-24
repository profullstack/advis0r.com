/**
 * ElevenLabs Scribe speech-to-text (PRD v3 §2.2).
 *
 * Scribe is the preferred ASR backend for this project because it returns the
 * two things the product actually needs, in one call:
 *
 *   - **word-level timestamps** — powering play-at-the-exact-second evidence
 *     links, at ~0.02s resolution rather than Whisper's ~segment resolution;
 *   - **speaker diarization** — which solves speaker attribution for podcasts
 *     and interviews, where the regex approach in `signals/speakers.ts` has
 *     nothing structural to match on.
 *
 * Verified against a real podcast episode on 2026-07-24: 45s of audio
 * transcribed in ~7s, 333 word tokens, diarized.
 *
 * Note that Anthropic offers no speech-to-text endpoint — Claude's input
 * modalities are text, images and documents — so ASR is necessarily a
 * third-party call regardless of which LLM does the downstream analysis.
 */
import type { TranscriptSegment } from "../../types.ts";

const ENDPOINT = "https://api.elevenlabs.io/v1/speech-to-text";
export const SCRIBE_MODEL = "scribe_v1";

/** One token from Scribe's `words` array. */
export interface ScribeWord {
  text: string;
  start?: number; // seconds
  end?: number;
  /** `word` | `spacing` | `audio_event` — only `word` carries content. */
  type?: string;
  speaker_id?: string;
}

export interface ScribeResponse {
  text?: string;
  language_code?: string;
  language_probability?: number;
  words?: ScribeWord[];
}

export interface ScribeOptions {
  apiKey: string;
  model?: string;
  /** Request speaker labels. On by default — attribution is the point. */
  diarize?: boolean;
  timeoutMs?: number;
}

export class ElevenLabsScribeClient {
  constructor(private opts: ScribeOptions) {}

  get configured(): boolean {
    return Boolean(this.opts.apiKey);
  }

  get model(): string {
    return this.opts.model ?? SCRIBE_MODEL;
  }

  /** Transcribe one prepared audio file. Offsets are relative to that file. */
  async transcribe(path: string): Promise<TranscriptSegment[]> {
    if (!this.configured) throw new Error("ElevenLabs ASR requires ELEVENLABS_API_KEY");

    const form = new FormData();
    form.append("file", new Blob([await Bun.file(path).arrayBuffer()]), "audio.flac");
    form.append("model_id", this.model);
    form.append("diarize", String(this.opts.diarize !== false));
    form.append("timestamps_granularity", "word");

    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "xi-api-key": this.opts.apiKey },
      body: form,
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 600_000),
    });
    if (!res.ok) {
      throw new Error(`ElevenLabs Scribe ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    return wordsToSegments((await res.json()) as ScribeResponse);
  }
}

/**
 * Group Scribe's word stream into paragraph-sized segments.
 *
 * A segment break is forced whenever the speaker changes, so every segment has
 * exactly one speaker and a quote can never be attributed to the wrong person —
 * the same grounding rule the multi-company news guard enforces (PRD §8.4).
 */
export function wordsToSegments(
  response: ScribeResponse,
  maxChars = 600,
): TranscriptSegment[] {
  const words = (response.words ?? []).filter(
    (w) => (w.type ?? "word") === "word" && w.text?.trim(),
  );
  if (words.length === 0) {
    const text = (response.text ?? "").trim();
    return text ? [{ index: 0, text, startMs: 0 }] : [];
  }

  const segments: TranscriptSegment[] = [];
  let buffer: ScribeWord[] = [];
  let speaker: string | undefined;

  const flush = () => {
    if (buffer.length === 0) return;
    const first = buffer[0]!;
    const last = buffer[buffer.length - 1]!;
    segments.push({
      index: segments.length,
      text: buffer.map((w) => w.text.trim()).join(" ").replace(/\s+/g, " ").trim(),
      startMs: Math.round((first.start ?? 0) * 1000),
      endMs: Math.round((last.end ?? last.start ?? 0) * 1000),
      speaker: speaker ? labelSpeaker(speaker) : undefined,
    });
    buffer = [];
  };

  for (const word of words) {
    const wordSpeaker = word.speaker_id;
    if (buffer.length > 0 && wordSpeaker && wordSpeaker !== speaker) {
      flush(); // speaker turn boundary
    }
    if (buffer.length === 0) speaker = wordSpeaker;

    buffer.push(word);
    const length = buffer.reduce((n, w) => n + w.text.length + 1, 0);
    if (length >= maxChars && /[.!?]$/.test(word.text)) flush();
    else if (length >= maxChars * 1.8) flush();
  }
  flush();

  return segments.filter((s) => s.text.length > 0);
}

/**
 * Diarized speakers are anonymous (`speaker_0`). Present them as such rather
 * than inventing a name — a guessed identity is worse than an honest label
 * (PRD §8.4). Resolving these to real executives is a later step.
 */
export function labelSpeaker(speakerId: string): string {
  const m = speakerId.match(/(\d+)\s*$/);
  return m ? `Speaker ${Number(m[1]) + 1}` : speakerId;
}

/** Scribe pricing is per hour of audio; used for budget reporting only. */
export function scribeCostUsd(durationMs: number, usdPerHour = 0.4): number {
  return Math.round((durationMs / 3_600_000) * usdPerHour * 10_000) / 10_000;
}
