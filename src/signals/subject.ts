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

/** Build the sentence-level predicate used by `extractSignals`. */
export function makeSubjectMentionTest(terms: string[]): (sentence: string) => boolean {
  const lowered = terms.map((t) => t.toLowerCase()).filter((t) => t.length >= 2);
  if (lowered.length === 0) return () => true;
  return (sentence: string) => {
    const s = sentence.toLowerCase();
    return lowered.some((t) => s.includes(t));
  };
}
