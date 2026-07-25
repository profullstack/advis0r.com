/**
 * Subject-company guard for multi-company documents (PRD §8.4 grounding).
 *
 * Financial news is full of comparison pieces — "IONQ or QBTS: Which Quantum
 * Stock Should You Buy?" — and a document-level ticker association will happily
 * attribute one company's figures to the other. That is a grounding failure,
 * not a ranking nuisance: production briefly recorded IonQ's "$470 million RPO"
 * as a QBTS backlog signal.
 *
 * The rule implemented here:
 *   - Single-company document  -> every sentence may be attributed to it, since
 *     "the company raised guidance" is unambiguous.
 *   - Multi-company document   -> a sentence must name the subject to be
 *     attributed to it.
 *
 * Conservative by design. A missed signal costs coverage; a misattributed one
 * corrupts the evidence base.
 */

/** Tokens that look like tickers but are ordinary words or common acronyms. */
const NOT_TICKERS = new Set([
  "A", "I", "AI", "US", "USA", "UK", "EU", "CEO", "CFO", "COO", "CTO", "IPO", "SEC", "FDA",
  "GAAP", "EPS", "ARR", "RPO", "EBITDA", "ETF", "NYSE", "IT", "PR", "Q1", "Q2", "Q3", "Q4",
  "FY", "YOY", "QOQ", "AND", "THE", "FOR", "NEW", "ALL", "NOW", "TOP", "CEOS", "API", "GPU",
  "CPU", "SAAS", "IOT", "EV", "ESG", "IRS", "GDP", "CPI", "AGI", "LLM", "ML",
]);

/** Terms that identify the subject company in text. */
export function subjectTerms(ticker: string, companyName?: string): string[] {
  const terms = [ticker.toUpperCase()];
  if (companyName) {
    const core = companyName
      .replace(/\b(inc|corp|corporation|company|co|ltd|plc|holdings|group|the)\b\.?/gi, "")
      .replace(/[^A-Za-z0-9 &-]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    if (core.length >= 3) {
      terms.push(core);
      // First word is usually the distinctive brand ("Vistra Corp" -> "Vistra"),
      // but only when it is distinctive enough to not collide with prose.
      const first = core.split(" ")[0]!;
      if (first.length >= 4 && first.toLowerCase() !== core.toLowerCase()) terms.push(first);
    }
  }
  return [...new Set(terms.filter(Boolean))];
}

/** Ticker-like symbols appearing in text, excluding common false positives. */
export function candidateTickers(text: string): Set<string> {
  const found = new Set<string>();
  for (const m of text.matchAll(/\$?\b([A-Z]{2,5})\b/g)) {
    const t = m[1]!;
    if (!NOT_TICKERS.has(t)) found.add(t);
  }
  return found;
}

/**
 * Does this document discuss companies other than the subject?
 *
 * Uses the set of tickers already known to the index as the vocabulary, so a
 * stray acronym cannot make a document look multi-company.
 */
export function isMultiCompany(
  text: string,
  subject: string,
  knownTickers: Set<string>,
): boolean {
  const subjectUpper = subject.toUpperCase();
  for (const t of candidateTickers(text)) {
    if (t !== subjectUpper && knownTickers.has(t)) return true;
  }
  return false;
}

/**
 * Ticker vocabulary for multi-company detection.
 *
 * Using only tickers already in our index is not enough: the production defect
 * involved IONQ, which had never been indexed, so the comparison article looked
 * single-company and the guard never engaged. SEC's `company_tickers.json` is
 * the authoritative list, keyless, and ~800 KB — fetched once and cached.
 */
const TICKER_SOURCE = "https://www.sec.gov/files/company_tickers.json";
const CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

let cachedVocabulary: Set<string> | null = null;

export async function loadTickerVocabulary(
  cachePath = "./data/company_tickers.json",
): Promise<Set<string>> {
  if (cachedVocabulary) return cachedVocabulary;

  const file = Bun.file(cachePath);
  let raw: string | null = null;
  try {
    if ((await file.exists()) && Date.now() - file.lastModified < CACHE_MAX_AGE_MS) {
      raw = await file.text();
    }
  } catch {
    /* cache miss falls through to the network */
  }

  if (!raw) {
    try {
      const res = await fetch(TICKER_SOURCE, {
        headers: {
          "User-Agent":
            process.env.SEC_USER_AGENT?.replace(/^"|"$/g, "") ??
            "advis0r.com research (anthony@profullstack.com)",
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        raw = await res.text();
        await Bun.write(cachePath, raw).catch(() => {});
      }
    } catch {
      /* offline: fall back to a stale cache, then to empty */
    }
    if (!raw) {
      try {
        raw = await file.text();
      } catch {
        raw = null;
      }
    }
  }

  const set = new Set<string>();
  if (raw) {
    try {
      for (const entry of Object.values(JSON.parse(raw) as Record<string, { ticker?: string }>)) {
        const t = entry?.ticker?.toUpperCase();
        // Single-letter tickers ("F", "T") collide with ordinary prose.
        if (t && t.length >= 2 && !NOT_TICKERS.has(t)) set.add(t);
      }
    } catch {
      /* malformed cache is treated as no vocabulary */
    }
  }
  cachedVocabulary = set;
  return set;
}

/** Reset the memoized vocabulary (tests). */
export function resetTickerVocabulary(): void {
  cachedVocabulary = null;
}

/**
 * Capitalized tokens that are not company names. Sentence-initial words are
 * excluded separately, so this only needs to cover words that appear mid-
 * sentence: calendar terms, market vocabulary, and the regulator/exchange names
 * that show up in almost every article.
 */
const NOT_COMPANY_WORDS = new Set(
  [
    "january", "february", "march", "april", "may", "june", "july", "august",
    "september", "october", "november", "december", "monday", "tuesday",
    "wednesday", "thursday", "friday", "saturday", "sunday",
    "wall", "street", "nasdaq", "nyse", "sec", "fda", "ceo", "cfo", "coo", "cto",
    "u.s.", "us", "america", "american", "european", "china", "chinese", "india",
    "ai", "the", "a", "an", "it", "its", "they", "their", "he", "she", "this",
    "that", "these", "those", "we", "our", "but", "and", "however", "meanwhile",
    "q1", "q2", "q3", "q4", "fy", "gaap", "ebitda", "eps", "arr", "rpo",
    "shares", "stock", "revenue", "earnings", "guidance", "results", "analysts",
    "investors", "both", "according", "while", "after", "before", "meanwhile",
  ].map((w) => w.toLowerCase()),
);

/**
 * Verbs that mark the word before them as a speaking subject — "IonQ said",
 * "Rigetti reported". Used to judge a sentence-initial capital, where
 * capitalization alone carries no information.
 */
const REPORTING_VERBS =
  /^(said|says|reported|reports|announced|announces|posted|guided|expects?|expected|plans?|raised|cut|added|noted|warned|filed|launched|acquired|agreed|declined|rose|fell)$/i;

/** Anaphoric references that stand in for a company already named. */
const ANAPHORA =
  /\b(the company|the firm|the business|the stock|the shares|shares|management|it|its|they|their)\b/i;

/**
 * Proper nouns in a sentence that are not the subject and not ordinary
 * vocabulary — i.e. probable other companies or people.
 *
 * The first token needs its own rule: every sentence capitalizes it, so a
 * capital there proves nothing, but the most common way to name a rival is to
 * open with it ("IonQ said…"). It counts only when the word is distinctive on
 * its own — an internal capital or hyphenated capital, as in "IonQ", "D-Wave",
 * "PayPal" — or when a reporting verb follows it.
 */
export function otherProperNouns(sentence: string, allowedTerms: string[]): string[] {
  const allowed = allowedTerms.map((t) => t.toLowerCase()).filter(Boolean);
  const trimmed = sentence.trimStart();
  const tokens = [...trimmed.matchAll(/\b[A-Z][A-Za-z0-9&.'-]+\b/g)];
  const out: string[] = [];
  for (const m of tokens) {
    const raw = m[0]!;
    const lower = raw.toLowerCase();
    if (NOT_COMPANY_WORDS.has(lower)) continue;
    if (allowed.some((t) => t.includes(lower) || lower.includes(t))) continue;
    if ((m.index ?? 0) === 0) {
      const distinctive = /[A-Z]/.test(raw.slice(1)) || /-[A-Z]/.test(raw);
      const next = trimmed.slice(raw.length).trimStart().split(/\s+/)[0] ?? "";
      if (!distinctive && !REPORTING_VERBS.test(next.replace(/[^A-Za-z]/g, ""))) continue;
    }
    out.push(raw);
  }
  return out;
}

/**
 * Sentence-stream attribution test for multi-company documents.
 *
 * `makeSubjectMentionTest` is stateless and per-sentence, which is right for
 * filings but discards most of a news article: reporting names the company once
 * and then writes "the company", "it", "shares" — and those sentences are the
 * ones carrying the signal. Production shows the cost: 18 ingested articles
 * yielded 2 signals.
 *
 * This variant walks the sentences in order and carries one bit of state —
 * whether the subject is the company currently under discussion:
 *
 *   - a sentence naming the subject is attributed to it, and opens a run;
 *   - a sentence naming another known issuer closes the run;
 *   - an unnamed sentence continues the run only if it is anaphoric ("it
 *     raised its outlook") *and* introduces no other proper noun.
 *
 * The bias stays conservative in the same direction as before: any doubt about
 * who a sentence is about ends the run rather than attributing it. A missed
 * signal costs coverage; a misattributed one corrupts the evidence base.
 */
export function makeSubjectAttributionTest(
  terms: string[],
  subject: string,
  knownTickers: Set<string>,
): (sentence: string) => boolean {
  const namesSubject = makeSubjectMentionTest(terms);
  const subjectUpper = subject.toUpperCase();
  const allowed = [...terms, subject];
  let onSubject = false;

  return (sentence: string) => {
    if (namesSubject(sentence)) {
      onSubject = true;
      return true;
    }
    const namesOtherTicker = [...candidateTickers(sentence)].some(
      (t) => t !== subjectUpper && knownTickers.has(t),
    );
    if (namesOtherTicker) {
      onSubject = false;
      return false;
    }
    // Another company spelled out ("IonQ", "Quantinuum") never reaches the
    // ticker vocabulary, so an unrecognized proper noun also ends the run.
    if (otherProperNouns(sentence, allowed).length > 0) {
      onSubject = false;
      return false;
    }
    return onSubject && ANAPHORA.test(sentence);
  };
}

/** Build the sentence-level predicate used by `extractSignals`. */
export function makeSubjectMentionTest(terms: string[]): (sentence: string) => boolean {
  const lowered = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
  if (lowered.length === 0) return () => true;
  return (sentence: string) => {
    const s = sentence.toLowerCase();
    return lowered.some((t) => s.includes(t));
  };
}
