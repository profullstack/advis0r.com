/**
 * Caption parsing: WebVTT / SRT -> timestamped segments (PRD v3 §2.3).
 *
 * Timestamps are the point of this module. `transcript_segments` has carried
 * unused `start_ms`/`end_ms` columns since the initial schema; populating them
 * is what turns a quote into a play-at-the-exact-second evidence link.
 *
 * YouTube's auto-generated captions are awkward input: cues overlap, each cue
 * repeats the tail of the previous one, and words carry inline timing tags
 * (`<00:00:01.000><c> word</c>`). All of that is normalized here.
 *
 * Pure and deterministic — no network, no LLM.
 */
import type { TranscriptSegment } from "../../types.ts";

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

const TIMING = /(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}|\d{1,2}:\d{2}[.,]\d{1,3})/;

/** Parse a timestamp like `00:01:02.345` or `01:02.345` into milliseconds. */
export function parseTimestamp(ts: string): number {
  const parts = ts.replace(",", ".").split(":");
  let seconds = 0;
  for (const part of parts) seconds = seconds * 60 + Number(part);
  return Math.round(seconds * 1000);
}

export function formatTimestamp(ms: number): string {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(h > 0 ? 2 : 1, "0");
  return h > 0 ? `${h}:${mm}:${String(s).padStart(2, "0")}` : `${mm}:${String(s).padStart(2, "0")}`;
}

/** Parse WebVTT or SRT into cues, dropping YouTube's duplicated rolling text. */
export function parseCaptions(input: string): Cue[] {
  const lines = input.replace(/\r/g, "").split("\n");
  const cues: Cue[] = [];
  let current: { startMs: number; endMs: number; parts: string[] } | null = null;

  const flush = () => {
    if (!current) return;
    const text = cleanCueText(current.parts.join(" "));
    if (text) cues.push({ startMs: current.startMs, endMs: current.endMs, text });
    current = null;
  };

  for (const raw of lines) {
    const line = raw.trim();
    const m = line.match(TIMING);
    if (m) {
      flush();
      current = { startMs: parseTimestamp(m[1]!), endMs: parseTimestamp(m[2]!), parts: [] };
      continue;
    }
    if (!current) continue;
    if (!line) {
      flush();
      continue;
    }
    // Skip WEBVTT headers, NOTE blocks and bare SRT sequence numbers.
    if (/^(WEBVTT|NOTE|STYLE|REGION)\b/.test(line)) continue;
    if (/^\d+$/.test(line)) continue;
    current.parts.push(line);
  }
  flush();

  return dedupeRolling(cues);
}

/** Strip caption markup and speaker-position cruft. */
function cleanCueText(text: string): string {
  return text
    .replace(/<\d{1,2}:\d{2}:\d{2}[.,]\d{1,3}>/g, " ") // inline word timings
    .replace(/<\/?c[^>]*>/g, " ") // <c> colour spans
    .replace(/<[^>]+>/g, " ") // any other tags
    .replace(/^-\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * YouTube auto-captions repeat the previous cue's tail at the head of the next
 * one so text scrolls smoothly. Keep only the newly added portion.
 */
function dedupeRolling(cues: Cue[]): Cue[] {
  const out: Cue[] = [];
  for (const cue of cues) {
    const prev = out[out.length - 1];
    if (!prev) {
      out.push(cue);
      continue;
    }
    if (cue.text === prev.text) {
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      continue;
    }
    if (cue.text.startsWith(prev.text)) {
      // Superset of the previous cue: replace it, keeping the earlier start.
      prev.text = cue.text;
      prev.endMs = Math.max(prev.endMs, cue.endMs);
      continue;
    }
    const trimmed = stripSharedPrefix(prev.text, cue.text);
    if (trimmed) out.push({ ...cue, text: trimmed });
  }
  return out;
}

/** Remove the longest word-aligned prefix of `next` that ends `prev`. */
function stripSharedPrefix(prev: string, next: string): string {
  const prevWords = prev.split(" ");
  const nextWords = next.split(" ");
  const max = Math.min(prevWords.length, nextWords.length);
  for (let n = max; n > 0; n--) {
    const tail = prevWords.slice(prevWords.length - n).join(" ");
    const head = nextWords.slice(0, n).join(" ");
    if (tail === head) return nextWords.slice(n).join(" ").trim();
  }
  return next;
}

/**
 * Group cues into paragraph-sized segments, preserving the start offset of the
 * first cue so every resulting segment is still seekable in the source media.
 */
export function cuesToSegments(cues: Cue[], maxChars = 600): TranscriptSegment[] {
  const segments: TranscriptSegment[] = [];
  let buffer: Cue[] = [];
  let length = 0;

  const flush = () => {
    if (buffer.length === 0) return;
    segments.push({
      index: segments.length,
      text: buffer.map((c) => c.text).join(" ").replace(/\s+/g, " ").trim(),
      startMs: buffer[0]!.startMs,
      endMs: buffer[buffer.length - 1]!.endMs,
    });
    buffer = [];
    length = 0;
  };

  for (const cue of cues) {
    buffer.push(cue);
    length += cue.text.length + 1;
    // Break on sentence boundaries once the buffer is big enough, so segments
    // stay readable and quotes do not start mid-clause.
    if (length >= maxChars && /[.!?]$/.test(cue.text)) flush();
    else if (length >= maxChars * 1.8) flush();
  }
  flush();
  return segments.filter((s) => s.text.length > 0);
}

export function parseCaptionsToSegments(input: string, maxChars = 600): TranscriptSegment[] {
  return cuesToSegments(parseCaptions(input), maxChars);
}
