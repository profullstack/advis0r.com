/**
 * Deterministic boilerplate & non-assertive-claim detection (PRD v3 §4.1).
 *
 * SEC filings are mostly disclaimer, risk-factor and exhibit-index prose. The
 * signal rules in `extract.ts` are regex matches over sentences, so without
 * section awareness they fire on legalese: measured against production, 20% of
 * stored signals sat in or beside a boilerplate marker and 41.8% were hedged
 * hypotheticals rather than claims of fact.
 *
 * This module is pure, deterministic and LLM-free (PRD §12/§13
 * deterministic-first): the same sentence always yields the same verdict.
 *
 * Three independent layers:
 *   1. `classifySentence`  — disclaimer markers + structural noise + modality.
 *   2. section-run state   — a disclaimer heading suppresses the sentences that
 *                            follow it (handled by the caller via `sectionRun`).
 *   3. corpus shingles     — see `corpus.ts`: text repeated across many distinct
 *                            issuers is boilerplate by definition.
 */

/** Legal/disclaimer language. Presence anywhere in the window is disqualifying. */
const DISCLAIMER_MARKERS: RegExp[] = [
  /forward[-\s]?looking statements?/i,
  /safe harbor/i,
  /risk factors/i,
  /(?:could|may|might) cause (?:our )?actual results/i,
  /differ materially/i,
  /undertakes? no (?:obligation|duty)/i,
  /risks and uncertainties/i,
  /no assurance (?:can be given|that)/i,
  /there can be no assurance/i,
  /incorporated (?:herein )?by reference/i,
  /private securities litigation reform act/i,
  /within the meaning of section 27a/i,
  /this (?:press release|report|presentation) contains/i,
  /reconciliation of (?:non[-\s]?gaap|gaap)/i,
  // "non-GAAP financial measure", "non-GAAP liquidity measure", etc.
  /non[-\s]?gaap\b[^.]{0,40}\bmeasure/i,
];

/** Document furniture: exhibit indexes, tables of contents, signature blocks. */
const STRUCTURAL_NOISE: RegExp[] = [
  /table of contents/i,
  /^\s*(?:exhibit|item)\s+\d+(?:\.\d+)*/i,
  /\bform of\b.{0,60}\b(?:agreement|notice|certificate|plan)\b/i,
  /pursuant to (?:item|rule|regulation|section)\s+\d/i,
  /\b(?:s-1|s-3|s-8|10-k|10-q|8-k|def 14a)\b.{0,30}\bfiled\b/i,
  /notes to (?:the )?(?:consolidated )?financial statements/i,
  /^\s*\d+\s+table of contents/i,
  /\bindex to (?:exhibits|financial statements)\b/i,
  /\bsignature(?:s)?\s*$/i,
];

/**
 * Hypothetical / conditional framing — the grammar of a risk factor, not a
 * claim. "We may be unable to obtain financing" is not a financing event.
 */
const HYPOTHETICAL: RegExp[] = [
  /\b(?:could|may|might|would)\s+(?:not\s+)?(?:be|have|cause|result|adversely|materially|require|need|fail|lose)/i,
  /\bif we (?:are|do|fail|cannot|are unable)/i,
  /\bwe (?:may|could|might) (?:not )?be (?:un)?able to/i,
  /\bwe (?:may|could|might) (?:need|require|be required|have to)/i,
  /\bin the event that\b/i,
  /\bwe cannot (?:assure|guarantee|predict)/i,
  /\bare subject to (?:risks|uncertainties|change)/i,
  /\b(?:any|our) (?:failure|inability) to\b/i,
  /\bwould (?:harm|hurt|adversely affect|materially)/i,
];

/**
 * Assertive, first-person or reported-fact framing. A sentence that is BOTH
 * assertive and numeric is a real claim even when it also trips a hypothetical
 * pattern (guidance legitimately talks about the future: "we expect revenue of
 * $50 million" is a claim; "revenue may decline" is not).
 */
const ASSERTIVE: RegExp[] = [
  /\bwe (?:delivered|generated|achieved|signed|closed|completed|shipped|launched|reported|grew|raised|increased|reduced|added|won|received|secured|entered into|announced|expanded|acquired|repaid|returned)\b/i,
  /\b(?:revenue|revenues|bookings|backlog|arr|rpo|margin|margins|cash flow|net income|eps|earnings|orders|units|subscribers|customers)\b[^.]{0,60}\b(?:was|were|grew|increased|rose|declined|fell|reached|totaled|totalled|came in|of|up|down)\b/i,
  /\bwe (?:are|is) (?:raising|increasing|reiterating|maintaining|lowering)\b/i,
  /\b(?:company|we) (?:announced|reported|declared)\b/i,
  /\bfor the (?:quarter|year|period) ended\b/i,
];

const NUMERIC =
  /(?:\$\s?\d[\d,.]*\s?(?:million|billion|thousand|m\b|bn?\b|k\b)?|\b\d+(?:\.\d+)?\s?%|\b\d[\d,]{2,}\b)/i;

/** How many sentences a disclaimer heading suppresses after it fires. */
export const DISCLAIMER_RUN_LENGTH = 6;

export type BoilerplateReason =
  | "disclaimer_marker"
  | "structural_noise"
  | "hypothetical"
  | "disclaimer_section"
  | "corpus_repeated";

export interface Classification {
  /** True when the sentence should not become a signal. */
  isBoilerplate: boolean;
  /** True when the sentence is hypothetical rather than a claim of fact. */
  hedged: boolean;
  /** True when the sentence opens (or continues) a disclaimer section. */
  opensDisclaimerSection: boolean;
  reasons: BoilerplateReason[];
}

export interface ClassifyInput {
  sentence: string;
  contextBefore?: string;
  contextAfter?: string;
  /** Set by the caller when a previous sentence opened a disclaimer section. */
  inDisclaimerSection?: boolean;
  /** Corpus-level test — see `corpus.ts`. */
  isRepeatedAcrossIssuers?: (sentence: string) => boolean;
}

/**
 * Classify a single sentence. Pure: identical input always yields identical
 * output, so signal extraction stays reproducible (PRD §26).
 */
export function classifySentence(input: ClassifyInput): Classification {
  const { sentence } = input;
  const reasons: BoilerplateReason[] = [];

  // A disclaimer marker in the sentence OR in either adjacent sentence. The
  // extractor works sentence-by-sentence, so a safe-harbor heading frequently
  // sits in the neighbouring sentence rather than the matched one.
  const window = [input.contextBefore ?? "", sentence, input.contextAfter ?? ""].join(" ");
  const opensDisclaimerSection = DISCLAIMER_MARKERS.some((re) => re.test(sentence));
  if (DISCLAIMER_MARKERS.some((re) => re.test(window))) reasons.push("disclaimer_marker");
  if (STRUCTURAL_NOISE.some((re) => re.test(sentence))) reasons.push("structural_noise");
  if (input.inDisclaimerSection) reasons.push("disclaimer_section");

  const assertive = ASSERTIVE.some((re) => re.test(sentence));
  const numeric = NUMERIC.test(sentence);
  const hypothetical = HYPOTHETICAL.some((re) => re.test(sentence));

  // An assertive, numeric sentence is a real claim even if it also reads as
  // conditional — this is what keeps genuine forward guidance from being
  // discarded along with the risk factors.
  const hedged = hypothetical && !(assertive && numeric);
  if (hedged) reasons.push("hypothetical");

  if (input.isRepeatedAcrossIssuers?.(sentence)) reasons.push("corpus_repeated");

  return {
    isBoilerplate: reasons.length > 0,
    hedged,
    opensDisclaimerSection,
    reasons,
  };
}

/**
 * Normalize a sentence for cross-issuer comparison: boilerplate differs between
 * filers only by company name, dates and figures, so those are stripped.
 */
export function normalizeForFingerprint(sentence: string): string {
  return sentence
    .toLowerCase()
    .replace(/[‘’“”]/g, "'")
    .replace(/\d+/g, "#")
    .replace(/[^a-z#\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Overlapping word shingles of a normalized sentence. Shingles (rather than
 * whole-sentence hashes) catch near-duplicate boilerplate where filers have
 * lightly reworded the standard language.
 */
export function shingles(sentence: string, size = 8): string[] {
  const words = normalizeForFingerprint(sentence).split(" ").filter(Boolean);
  if (words.length < size) return words.length ? [words.join(" ")] : [];
  const out: string[] = [];
  for (let i = 0; i + size <= words.length; i++) out.push(words.slice(i, i + size).join(" "));
  return out;
}
