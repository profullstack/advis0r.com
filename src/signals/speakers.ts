/**
 * Speaker attribution (PRD v3 §2.4).
 *
 * Production stored 42,193 transcript segments with a speaker on exactly zero
 * of them, so every signal was attributed to the string "Company" — in a
 * product whose premise is executive speech. Earnings-call and interview
 * transcripts are highly structured, so most attribution is a regex problem.
 *
 * Deterministic and LLM-free. Confidence is reported rather than assumed:
 * anything inferred rather than read off the transcript is marked below 1 so
 * the UI and the model can treat it accordingly (PRD §8.4).
 */
import type { TranscriptSegment } from "../types.ts";

export interface SpeakerAttribution {
  speaker: string;
  speakerTitle?: string;
  confidence: number;
}

/** Executive/analyst title vocabulary used to validate a parsed attribution. */
const TITLE_WORDS =
  /(chief\s+\w+\s+officer|ceo|cfo|coo|cto|president|chair(?:man|woman|person)?|founder|director|vice\s+president|evp|svp|head\s+of\s+[\w\s]+|analyst|managing\s+director|partner|host|moderator|operator)/i;

/**
 * Patterns for a speaker label at the start of a line, most specific first.
 *
 *   "Jensen Huang -- Chief Executive Officer"
 *   "Jensen Huang, CEO:"
 *   "Operator:"
 *   "JENSEN HUANG:"
 */
const NAME = String.raw`[A-Z][\w.'-]+(?:\s+[A-Z][\w.'-]+){0,3}`;

// Title groups are greedy up to the delimiter: a lazy quantifier here captures
// one or two characters ("Ch" of "Chief Executive Officer") and loses the title.
const PATTERNS: { re: RegExp; confidence: number }[] = [
  // "Jensen Huang -- Chief Executive Officer: ..."
  { re: new RegExp(String.raw`^(${NAME})\s*(?:--|—|–)\s*([^:\n]{2,60}):\s*`), confidence: 1 },
  // "Jensen Huang -- Chief Executive Officer" as a standalone label line.
  { re: new RegExp(String.raw`^(${NAME})\s*(?:--|—|–)\s*([^:\n]{2,60})\s*$`), confidence: 1 },
  // "Colette Kress, CFO: ..."
  { re: new RegExp(String.raw`^(${NAME}),\s*([^:\n]{2,60}):\s*`), confidence: 1 },
  // "JENSEN HUANG: ..." / "Jensen Huang: ..."
  { re: new RegExp(String.raw`^(${NAME}):\s+`), confidence: 0.9 },
  // Operator: / Moderator:
  { re: /^(Operator|Moderator|Host)\b\s*[:.]\s*/i, confidence: 1 },
];

/**
 * Attribute one segment. Returns the attribution and the text with the speaker
 * label removed, so the label never becomes part of a quote.
 */
export function attributeSegment(
  text: string,
): { attribution?: SpeakerAttribution; text: string } {
  const trimmed = text.trimStart();
  for (const { re, confidence } of PATTERNS) {
    const m = trimmed.match(re);
    if (!m) continue;
    const name = (m[1] ?? "").trim();
    const rawTitle = (m[2] ?? "").trim();
    if (!isPlausibleName(name)) continue;
    // A two-part match is only trusted when part two actually looks like a title.
    if (rawTitle && !TITLE_WORDS.test(rawTitle) && rawTitle.split(/\s+/).length > 6) continue;

    return {
      attribution: {
        speaker: normalizeName(name),
        speakerTitle: rawTitle && TITLE_WORDS.test(rawTitle) ? rawTitle : undefined,
        confidence,
      },
      text: trimmed.slice(m[0].length).trim(),
    };
  }
  return { text };
}

function isPlausibleName(name: string): boolean {
  if (name.length < 2 || name.length > 60) return false;
  // Reject sentence openers that merely look like a label ("Revenue:", "Note:").
  if (/^(revenue|note|however|therefore|the|this|that|our|we|in|on|at|for|and|but)$/i.test(name)) {
    return false;
  }
  return /^[A-Z]/.test(name);
}

/** "JENSEN HUANG" -> "Jensen Huang"; leaves mixed-case names untouched. */
export function normalizeName(name: string): string {
  if (name !== name.toUpperCase()) return name;
  return name
    .toLowerCase()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/**
 * Attribute a whole transcript. Speaker labels appear once at the start of a
 * turn, so attribution carries forward to following segments until the next
 * label — with reduced confidence, since it is inferred rather than read.
 */
export function attributeSegments(segments: TranscriptSegment[]): TranscriptSegment[] {
  let current: SpeakerAttribution | undefined;
  return segments.map((segment) => {
    const { attribution, text } = attributeSegment(segment.text);
    if (attribution) current = attribution;
    if (!current) return segment;
    return {
      ...segment,
      text: attribution ? text || segment.text : segment.text,
      speaker: current.speaker,
      speakerTitle: current.speakerTitle,
    };
  });
}

/** Fraction of segments that ended up attributed — a coverage metric. */
export function attributionRate(segments: TranscriptSegment[]): number {
  if (segments.length === 0) return 0;
  const named = segments.filter((s) => s.speaker).length;
  return Math.round((named / segments.length) * 100) / 100;
}
