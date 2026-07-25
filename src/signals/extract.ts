/**
 * Deterministic transcript signal extraction (PRD §10, extended by PRD v3 §4.1).
 *
 * Rule-based, reproducible extraction of the §10.1/§10.2 signal taxonomy from
 * normalized transcript text. Deterministic by design: the same input always
 * yields the same signals, independent of any LLM. The LLM later interprets
 * these signals but does not create the ground-truth extraction.
 *
 * v3 adds section awareness. Extraction now runs a small state machine over the
 * sentence stream so a safe-harbor / risk-factor heading suppresses the
 * sentences that follow it, and it carries speaker, media offset and source
 * tier through to each signal.
 */
import { createHash } from "node:crypto";
import type {
  NormalizedTranscript,
  SourceTier,
  TranscriptSignal,
} from "../types.ts";
import { DISCLAIMER_RUN_LENGTH, classifySentence } from "./boilerplate.ts";

type Dir = "positive" | "negative" | "mixed" | "neutral";
interface Rule {
  signalType: string;
  direction: Dir;
  weight: number; // base strength 0-1
  patterns: RegExp[];
  /** Phrases that use the same words for something else (see `acquisition`). */
  exclude?: RegExp[];
}

/**
 * Determiner slot shared by the rules below.
 *
 * The taxonomy was written against executive speech ("we raised our guidance"),
 * so every pattern hard-coded "our". Reporting says "Vistra raised its
 * guidance" or "the company lifted full-year guidance", and news documents were
 * therefore matching almost nothing. Optional and non-capturing, so it changes
 * nothing about how transcripts match.
 */
const DET = String.raw`(?:(?:our|its|their|his|her|the|this)\s+)?`;
const FY = String.raw`(?:(?:full[- ]year|fiscal|fy|annual|quarterly|q[1-4])\s+)?`;
/** `raised its full-year guidance`, `raising guidance`, `raise our outlook`. */
const rule = (verb: string, object: string) =>
  new RegExp(String.raw`\b${verb}\s+${DET}${FY}${object}\b`, "i");

// PRD §10.1 (positive) and §10.2 (negative) taxonomies.
const RULES: Rule[] = [
  { signalType: "raised_guidance", direction: "positive", weight: 0.9, patterns: [rule(String.raw`(?:raise[sd]?|raising)`, String.raw`guidance`), rule(String.raw`(?:increase[sd]?|increasing|raise[sd]?|raising|lift(?:s|ed|ing)?|boost(?:s|ed|ing)?|hike[sd]?|hiking)`, String.raw`(?:outlook|guidance|forecast)`), /guidance (?:up|higher|to)/i, /guidance (?:was|were|has been) (?:raised|increased|lifted)/i] },
  { signalType: "demand_acceleration", direction: "positive", weight: 0.85, patterns: [/demand (?:is )?(?:accelerat|strengthen|surg)/i, /accelerating demand/i, /record demand/i] },
  { signalType: "backlog_growth", direction: "positive", weight: 0.85, patterns: [/backlog (?:grew|increased|of|up|record)/i, /remaining performance obligation/i, /\bRPO\b/, /order (?:book|backlog)/i] },
  { signalType: "capacity_expansion", direction: "positive", weight: 0.7, patterns: [rule(String.raw`expand(?:s|ed|ing)?`, String.raw`capacity`),/new (?:facility|plant|data ?center|fab)/i, /(?:bringing|adding) .{0,20}capacity online/i, /\b\d+\s?MW\b/i] },
  { signalType: "customer_win", direction: "positive", weight: 0.8, patterns: [/(?:new|major|large|key) (?:customer|client) (?:win|won|deal|contract)/i, /landed (?:a )?(?:new )?customer/i, /signed (?:a )?(?:new |major )?(?:agreement|contract|deal)/i, /(?:won|secured|awarded|booked) (?:a |an )?(?:new |major |large |multi[- ]year )*(?:contract|order|deal|customer)/i] },
  { signalType: "commercial_launch", direction: "positive", weight: 0.8, patterns: [/commercial (?:launch|availability|production)/i, /general(?:ly)? available/i, /moving (?:from pilot )?to (?:commercial|production)/i, /entered (?:full )?production/i] },
  { signalType: "regulatory_milestone", direction: "positive", weight: 0.85, patterns: [/(?:FDA|regulatory) (?:approval|clearance|authorization)/i, /received (?:approval|clearance)/i, /510\(k\)/i, /CE mark/i] },
  { signalType: "margin_expansion", direction: "positive", weight: 0.75, patterns: [/(?:gross|operating) margin (?:expan|improv|increas|up)/i, /margin(?:s)? (?:expanded|improved|widened|rose)/i] },
  { signalType: "cashflow_improvement", direction: "positive", weight: 0.8, patterns: [/positive (?:free )?cash flow/i, /cash flow (?:positive|breakeven|improv)/i, /reduc(?:e|ed|ing) (?:cash )?burn/i, /profitab(?:le|ility)/i] },
  { signalType: "strategic_partnership", direction: "positive", weight: 0.7, patterns: [/strategic (?:partnership|alliance|agreement)/i, /partner(?:ed|ship) with/i, /collaboration with/i] },
  { signalType: "pricing_power", direction: "positive", weight: 0.7, patterns: [/pricing power/i, /(?:raised|increased) prices/i, /price (?:increase|realization)/i] },
  { signalType: "new_recurring_revenue", direction: "positive", weight: 0.75, patterns: [/recurring revenue/i, /\bARR\b/, /subscription (?:revenue|growth)/i] },

  // M&A. Deliberately `mixed`: an acquisition is material either way, but its
  // sign depends on price, funding and integration — a debt-funded deal and a
  // premium takeover of the subject are not the same news. Scoring treats mixed
  // as directionless, so this surfaces the event to the model without asserting
  // that it is good or bad. Real coverage this was missing: "WESCO
  // International (WCC) Aims to Acquire Newark Engineering".
  {
    signalType: "acquisition",
    direction: "mixed",
    weight: 0.75,
    patterns: [
      /\b(?:agree[sd]?|aims?|plans?|intends?|moves?|seeks?|offers?)\s+to\s+acquire\b/i,
      /\b(?:will|would|to)\s+acquire\b/i,
      /\bto\s+be\s+acquired\b/i,
      /\bacquisition\s+of\b/i,
      /\b(?:completed|closed|announced|unveiled)\s+(?:the\s+|its\s+)?acquisition\b/i,
      /\b(?:definitive\s+)?merger\s+agreement\b/i,
      /\b(?:takeover|buyout)\s+(?:bid|offer|proposal|deal)\b/i,
      /\ball[- ]cash\s+(?:deal|transaction|offer)\b/i,
      // "acquired Newark Engineering" — a named target, so case matters here.
      /\bacquir(?:e|es|ed|ing)\s+(?:a\s+|the\s+)?[A-Z][\w&.'-]+/,
    ],
    exclude: [
      // The same words priced per customer rather than per company.
      /\b(?:customer|client|user|subscriber|talent|patient|deposit|traffic|member)\s+acquisition\b/i,
      /\bacquisition\s+(?:cost|costs|spend|marketing|channel|strategy for customers)\b/i,
      // Equity-award and warrant boilerplate. "The right to acquire Shares"
      // appears in most option agreements and is not a transaction: it was the
      // single largest false positive when this rule was first run over the
      // stored SEC exhibits.
      /\b(?:right|rights|option|options|warrant|warrants|entitled|eligible|ability)\s+to\s+acquire\b/i,
      /\bto\s+acquire\s+(?:shares?|common stock|securities|equity|stock)\b/i,
      /\b(?:participant|grantee|optionee|award agreement|equity incentive plan|restricted stock)\b/i,
      // Risk-factor prose describes acquisitions in general, not a deal:
      // "The development or acquisition of data center facilities requires…".
      /\b(?:no assurance|we may be unable|if we are unable|requires substantial|risk factors)\b/i,
    ],
  },

  { signalType: "guidance_reduction", direction: "negative", weight: 0.9, patterns: [rule(String.raw`(?:lower(?:s|ed|ing)?|reduce[sd]?|reducing|cuts?|cutting|slash(?:es|ed|ing)?|trim(?:s|med|ming)?)`, String.raw`(?:guidance|outlook|forecast)`), /guidance (?:down|lower|below)/i, /guidance (?:was|were|has been) (?:cut|lowered|reduced)/i] },
  { signalType: "cash_burn", direction: "negative", weight: 0.8, patterns: [/cash burn/i, /burn rate/i, /using cash/i] },
  { signalType: "financing_need", direction: "negative", weight: 0.85, patterns: [/(?:need|require) (?:additional )?(?:capital|financing|funding)/i, /raise (?:additional )?capital/i, /going concern/i] },
  { signalType: "atm_offering", direction: "negative", weight: 0.85, patterns: [/at[- ]the[- ]market (?:offering|program)/i, /\bATM\b (?:offering|program|facility)/i] },
  { signalType: "dilution", direction: "negative", weight: 0.8, patterns: [/(?:share )?dilution/i, /issu(?:e|ed|ing) (?:new )?shares/i, /shelf (?:registration|offering)/i] },
  { signalType: "reverse_split", direction: "negative", weight: 0.9, patterns: [/reverse (?:stock )?split/i] },
  { signalType: "going_concern", direction: "negative", weight: 0.95, patterns: [/going concern/i, /substantial doubt/i] },
  { signalType: "delisting_risk", direction: "negative", weight: 0.9, patterns: [/delist(?:ing|ed)?/i, /minimum bid price/i, /notice of noncompliance/i, /Nasdaq (?:notification|deficiency)/i] },
  { signalType: "demand_slowdown", direction: "negative", weight: 0.8, patterns: [/demand (?:slow|soften|weaken|declin)/i, /softer demand/i, /macro headwind/i] },
  { signalType: "margin_compression", direction: "negative", weight: 0.75, patterns: [/margin (?:compress|contract|declin|pressure)/i] },
  { signalType: "product_delay", direction: "negative", weight: 0.75, patterns: [/(?:product|launch|shipment) (?:delay|pushed|slipped)/i, /delayed (?:launch|shipment|production)/i] },
  { signalType: "management_turnover", direction: "negative", weight: 0.7, patterns: [/(?:CEO|CFO|COO|president) (?:resign|depart|step(?:ping)? down|transition)/i, /appointed (?:interim|new) (?:CEO|CFO)/i] },
  { signalType: "material_weakness", direction: "negative", weight: 0.85, patterns: [/material weakness/i, /restat(?:e|ed|ement)/i, /auditor (?:concern|resign)/i] },
  { signalType: "litigation", direction: "negative", weight: 0.7, patterns: [/(?:lawsuit|litigation|class action|SEC investigation|subpoena)/i] },
];

const NUMERIC = /(\$\s?\d[\d,.]*\s?(?:million|billion|thousand|m|b|k)?|\b\d+(?:\.\d+)?\s?%|\b\d{2,}\b)/i;

export interface ExtractOptions {
  /** Corpus-level repeated-language test (see `corpus.ts`). */
  isRepeatedAcrossIssuers?: (sentence: string) => boolean;
  /** Reputation tier of the source document (PRD v3 §3.3). */
  sourceTier?: SourceTier;
  /**
   * Retain boilerplate signals, flagged rather than dropped. Off by default;
   * useful for auditing what the filter removed.
   */
  keepBoilerplate?: boolean;
  /**
   * Sentence-level subject guard for multi-company documents (see
   * `subject.ts`). When provided, a sentence that does not name the subject
   * company yields no signals — a comparison article must not attribute one
   * company's figures to another (PRD §8.4).
   */
  mentionsSubject?: (sentence: string) => boolean;
}

/** One sentence plus the segment it came from (speaker / media offset). */
interface SourceSentence {
  text: string;
  speaker?: string;
  speakerTitle?: string;
  startMs?: number;
}

export function extractSignals(
  t: NormalizedTranscript,
  opts: ExtractOptions = {},
): TranscriptSignal[] {
  const ticker = t.primaryTicker ?? t.tickers[0];
  if (!ticker) return [];
  const eventType = t.eventType;
  const eventDate = t.eventDate.slice(0, 10);
  const sourceTier = opts.sourceTier ?? 0;

  // Preserve the segment each sentence came from so speaker attribution and
  // media offsets survive extraction. Previously all text was flattened into
  // one string, which is why every stored signal was attributed to "Company".
  const sentences = flattenToSentences(t);

  const out: TranscriptSignal[] = [];
  const seen = new Set<string>();
  let disclaimerRun = 0;

  for (let i = 0; i < sentences.length; i++) {
    const current = sentences[i]!;
    const sentence = current.text;
    const contextBefore = sentences[i - 1]?.text ?? "";
    const contextAfter = sentences[i + 1]?.text ?? "";

    const verdict = classifySentence({
      sentence,
      contextBefore,
      contextAfter,
      inDisclaimerSection: disclaimerRun > 0,
      isRepeatedAcrossIssuers: opts.isRepeatedAcrossIssuers,
    });

    // A disclaimer heading suppresses the run of sentences that follows it.
    if (verdict.opensDisclaimerSection) disclaimerRun = DISCLAIMER_RUN_LENGTH;
    else if (disclaimerRun > 0) disclaimerRun--;

    if (verdict.isBoilerplate && !opts.keepBoilerplate) continue;

    // In a document covering several companies, only sentences naming the
    // subject may be attributed to it.
    if (opts.mentionsSubject && !opts.mentionsSubject(sentence)) continue;

    for (const rule of RULES) {
      if (!rule.patterns.some((p) => p.test(sentence))) continue;
      if (rule.exclude?.some((p) => p.test(sentence))) continue;
      const hasNumber = NUMERIC.test(sentence);
      const specificity = hasNumber ? 0.85 : 0.45;
      const strength = Math.min(1, rule.weight * (hasNumber ? 1 : 0.9));
      const quote = sentence.trim().slice(0, 500);
      const evidenceHash = createHash("sha256")
        .update(`${ticker}|${rule.signalType}|${quote}`)
        .digest("hex")
        .slice(0, 16);
      if (seen.has(evidenceHash)) continue;
      seen.add(evidenceHash);
      out.push({
        id: `${ticker}:${eventDate}:${rule.signalType}:${evidenceHash.slice(0, 8)}`,
        ticker,
        speaker: current.speaker ?? "Company",
        speakerTitle: current.speakerTitle,
        eventDate,
        eventType,
        signalType: rule.signalType,
        direction: rule.direction,
        strength: round(strength),
        novelty: 0.5, // refined by language-change detection across periods
        specificity,
        quote,
        contextBefore: contextBefore.trim().slice(0, 200),
        contextAfter: contextAfter.trim().slice(0, 200),
        sourceUrl: t.url,
        evidenceHash,
        sourceTier,
        isBoilerplate: verdict.isBoilerplate,
        boilerplateReasons: verdict.reasons.length ? verdict.reasons : undefined,
        speakerConfidence: current.speaker ? 1 : 0,
        startMs: current.startMs,
        provenance: t.provenance ?? "filing",
      });
    }
  }
  return out;
}

/** Split every segment into sentences while keeping its speaker/offset. */
function flattenToSentences(t: NormalizedTranscript): SourceSentence[] {
  const out: SourceSentence[] = [];
  for (const segment of t.segments) {
    for (const text of splitSentences(segment.text)) {
      out.push({
        text,
        speaker: segment.speaker,
        speakerTitle: segment.speakerTitle,
        startMs: segment.startMs,
      });
    }
  }
  return out;
}

function splitSentences(text: string): string[] {
  return text
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z0-9$"“])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20);
}
function round(x: number): number {
  return Math.round(x * 100) / 100;
}
