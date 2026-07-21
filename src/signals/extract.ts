/**
 * Deterministic transcript signal extraction (PRD §10).
 *
 * Rule-based, reproducible extraction of the §10.1/§10.2 signal taxonomy from
 * normalized transcript text. Deterministic by design: the same input always
 * yields the same signals, independent of any LLM. The LLM later interprets
 * these signals but does not create the ground-truth extraction.
 */
import { createHash } from "node:crypto";
import type {
  NormalizedTranscript,
  TranscriptSignal,
} from "../types.ts";

type Dir = "positive" | "negative" | "mixed" | "neutral";
interface Rule {
  signalType: string;
  direction: Dir;
  weight: number; // base strength 0-1
  patterns: RegExp[];
}

// PRD §10.1 (positive) and §10.2 (negative) taxonomies.
const RULES: Rule[] = [
  { signalType: "raised_guidance", direction: "positive", weight: 0.9, patterns: [/rais(?:e|ed|ing) (?:our |full[- ]year |fy)?guidance/i, /increas(?:e|ed|ing) (?:our )?outlook/i, /guidance (?:up|higher|to)/i] },
  { signalType: "demand_acceleration", direction: "positive", weight: 0.85, patterns: [/demand (?:is )?(?:accelerat|strengthen|surg)/i, /accelerating demand/i, /record demand/i] },
  { signalType: "backlog_growth", direction: "positive", weight: 0.85, patterns: [/backlog (?:grew|increased|of|up|record)/i, /remaining performance obligation/i, /\bRPO\b/, /order (?:book|backlog)/i] },
  { signalType: "capacity_expansion", direction: "positive", weight: 0.7, patterns: [/expand(?:ing)? (?:our )?capacity/i, /new (?:facility|plant|data ?center|fab)/i, /(?:bringing|adding) .{0,20}capacity online/i, /\b\d+\s?MW\b/i] },
  { signalType: "customer_win", direction: "positive", weight: 0.8, patterns: [/(?:new|major|large|key) (?:customer|client) (?:win|won|deal|contract)/i, /landed (?:a )?(?:new )?customer/i, /signed (?:a )?(?:new |major )?(?:agreement|contract|deal)/i] },
  { signalType: "commercial_launch", direction: "positive", weight: 0.8, patterns: [/commercial (?:launch|availability|production)/i, /general(?:ly)? available/i, /moving (?:from pilot )?to (?:commercial|production)/i, /entered (?:full )?production/i] },
  { signalType: "regulatory_milestone", direction: "positive", weight: 0.85, patterns: [/(?:FDA|regulatory) (?:approval|clearance|authorization)/i, /received (?:approval|clearance)/i, /510\(k\)/i, /CE mark/i] },
  { signalType: "margin_expansion", direction: "positive", weight: 0.75, patterns: [/(?:gross|operating) margin (?:expan|improv|increas|up)/i, /margin(?:s)? (?:expanded|improved)/i] },
  { signalType: "cashflow_improvement", direction: "positive", weight: 0.8, patterns: [/positive (?:free )?cash flow/i, /cash flow (?:positive|breakeven|improv)/i, /reduc(?:e|ed|ing) (?:cash )?burn/i, /profitab(?:le|ility)/i] },
  { signalType: "strategic_partnership", direction: "positive", weight: 0.7, patterns: [/strategic (?:partnership|alliance|agreement)/i, /partner(?:ed|ship) with/i, /collaboration with/i] },
  { signalType: "pricing_power", direction: "positive", weight: 0.7, patterns: [/pricing power/i, /(?:raised|increased) prices/i, /price (?:increase|realization)/i] },
  { signalType: "new_recurring_revenue", direction: "positive", weight: 0.75, patterns: [/recurring revenue/i, /\bARR\b/, /subscription (?:revenue|growth)/i] },

  { signalType: "guidance_reduction", direction: "negative", weight: 0.9, patterns: [/(?:lower|reduc|cut)(?:ed|ing)? (?:our )?guidance/i, /guidance (?:down|lower|below)/i, /reduc(?:e|ed|ing) (?:our )?outlook/i] },
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

export function extractSignals(t: NormalizedTranscript): TranscriptSignal[] {
  const ticker = t.primaryTicker ?? t.tickers[0];
  if (!ticker) return [];
  const speaker = t.segments.find((s) => s.speaker)?.speaker ?? "Company";
  const eventType = t.eventType;
  const eventDate = t.eventDate.slice(0, 10);

  const sentences = splitSentences(t.segments.map((s) => s.text).join(" "));
  const out: TranscriptSignal[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < sentences.length; i++) {
    const sentence = sentences[i]!;
    for (const rule of RULES) {
      if (!rule.patterns.some((p) => p.test(sentence))) continue;
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
        speaker,
        eventDate,
        eventType,
        signalType: rule.signalType,
        direction: rule.direction,
        strength: round(strength),
        novelty: 0.5, // refined by language-change detection across periods
        specificity,
        quote,
        contextBefore: (sentences[i - 1] ?? "").trim().slice(0, 200),
        contextAfter: (sentences[i + 1] ?? "").trim().slice(0, 200),
        sourceUrl: t.url,
        evidenceHash,
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
