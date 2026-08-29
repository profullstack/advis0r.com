/**
 * Phrase and niche extraction from search titles, snippets and page text.
 *
 * The Search tab answers three questions about a query or a pasted page: what
 * is being written about (titles), what language recurs across those writers
 * (phrases), and which distinct subjects the results fall into (niches). Only
 * the first is given to us; the other two are computed here.
 *
 * Two decisions shape the output:
 *
 *  - **Document frequency, not term frequency.** A phrase scores by how many
 *    separate results contain it, so one long article repeating its own
 *    keyword twelve times cannot invent a trend. A phrase in one document is
 *    a quirk of that document; a phrase in six is a niche.
 *  - **Longest wins.** "ai" and "ai infrastructure" occurring in the same six
 *    documents are one phrase, not two, so the shorter is dropped when it is
 *    contained in a longer one of equal weight. Without this the chip row is
 *    the same idea at three lengths.
 *
 * Pure and deterministic: no network, no LLM, no model of English beyond a
 * stopword list. That keeps it free to run on every search and testable.
 */

/**
 * Words that carry no topic. Kept deliberately short — a long list starts
 * eating domain vocabulary ("general", "market", "value") that is exactly what
 * distinguishes one niche from another.
 */
const STOPWORDS = new Set([
  "a", "about", "after", "again", "against", "all", "also", "am", "an", "and", "any", "are",
  "as", "at", "be", "because", "been", "before", "being", "below", "between", "both", "but",
  "by", "can", "did", "do", "does", "doing", "down", "during", "each", "few", "for", "from",
  "further", "had", "has", "have", "having", "he", "her", "here", "hers", "him", "his", "how",
  "i", "if", "in", "into", "is", "it", "its", "just", "me", "might", "more", "most", "must",
  "my", "no", "nor", "not", "now", "of", "off", "on", "once", "only", "or", "other", "our",
  "out", "over", "own", "per", "said", "same", "says", "she", "should", "so",
  "some", "such", "than", "that", "the", "their", "them", "then", "there", "these",
  "they", "this", "those", "through", "to", "too", "under", "until", "up", "us", "very",
  "was", "we", "were", "what", "when", "where", "which", "while", "who", "whom", "why",
  "will", "with", "would", "you", "your",
]);

/** Editorial furniture that survives tokenisation but names no subject. */
const NOISE = new Set([
  "read", "reads", "click", "subscribe", "newsletter", "advertisement", "sponsored",
  "continue", "reading", "share", "comments", "min", "mins", "ago", "today", "yesterday",
  "new", "news", "latest", "update", "updates", "best", "top", "guide", "review", "reviews",
  "https", "http", "www", "com",
]);

export interface Phrase {
  phrase: string;
  /** How many separate documents contain it. */
  count: number;
  /** Words in the phrase, 1-3. */
  words: number;
}

export interface PhraseOptions {
  /** Longest n-gram considered. */
  maxWords?: number;
  /** How many phrases to return. */
  limit?: number;
  /**
   * Documents a phrase must appear in to count. Defaults to 2 once there are
   * enough documents to make repetition meaningful, and 1 below that — a
   * single pasted article has only one document, and every phrase in it would
   * otherwise score 1 and be discarded.
   */
  minCount?: number;
}

/** Split text into lowercase word tokens, keeping intra-word hyphens. */
export function tokenize(text: string): string[] {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .split(/[^a-z0-9'&-]+/)
    .map((w) => w.replace(/^[-']+|[-']+$/g, ""))
    .filter((w) => w.length > 1 && w.length < 40 && !/^\d+$/.test(w));
}

function isEdgeWord(word: string): boolean {
  return !STOPWORDS.has(word) && !NOISE.has(word);
}

/**
 * Rank the phrases that recur across a set of documents.
 *
 * `documents` are independent texts — one per search result, or one per
 * section of a parsed page. Passing a single concatenated string is a mistake
 * that turns document frequency back into term frequency.
 */
export function topPhrases(documents: string[], opts: PhraseOptions = {}): Phrase[] {
  const maxWords = Math.min(4, Math.max(1, opts.maxWords ?? 3));
  const limit = Math.max(1, opts.limit ?? 12);
  const docs = documents.map(tokenize).filter((t) => t.length > 0);
  if (docs.length === 0) return [];
  const minCount = opts.minCount ?? (docs.length >= 4 ? 2 : 1);

  // Document frequency: a phrase counted once per document however often it
  // appears inside that one.
  const df = new Map<string, number>();
  for (const tokens of docs) {
    const seen = new Set<string>();
    for (let n = 1; n <= maxWords; n++) {
      for (let i = 0; i + n <= tokens.length; i++) {
        const words = tokens.slice(i, i + n);
        if (!isEdgeWord(words[0]!) || !isEdgeWord(words[n - 1]!)) continue;
        // A stopword may sit inside a phrase ("state of the art") but a phrase
        // made only of them is not a subject.
        if (words.every((w) => STOPWORDS.has(w))) continue;
        seen.add(words.join(" "));
      }
    }
    for (const phrase of seen) df.set(phrase, (df.get(phrase) ?? 0) + 1);
  }

  const candidates = [...df.entries()]
    .map(([phrase, count]) => ({ phrase, count, words: phrase.split(" ").length }))
    .filter((p) => p.count >= minCount)
    // Longer phrases first at equal weight so containment dedupe keeps the
    // specific one ("ai infrastructure") over the generic one ("ai").
    .sort((a, b) => b.count - a.count || b.words - a.words || a.phrase.localeCompare(b.phrase));

  const chosen: Phrase[] = [];
  for (const cand of candidates) {
    if (chosen.length >= limit) break;
    // Drop a phrase already represented by a kept one of equal or greater
    // weight — either direction of containment, since "ai infrastructure"
    // makes "ai" redundant and vice versa.
    const redundant = chosen.some(
      (kept) =>
        kept.count >= cand.count &&
        (contains(kept.phrase, cand.phrase) || contains(cand.phrase, kept.phrase)),
    );
    if (!redundant) chosen.push(cand);
  }
  return chosen;
}

/** Whole-word containment: "ai infrastructure" contains "ai", not "rai". */
function contains(haystack: string, needle: string): boolean {
  if (haystack === needle) return true;
  return ` ${haystack} `.includes(` ${needle} `);
}

export interface NicheItem {
  title: string;
  snippet?: string;
  host?: string;
}

export interface Niche {
  /** The recurring phrase that defines the cluster. */
  label: string;
  /** Results containing it. */
  count: number;
  /** Distinct publishers writing about it, most frequent first. */
  hosts: string[];
  /** Indices into the input array, so the UI can filter to the cluster. */
  members: number[];
}

/**
 * Group results into niches: one cluster per recurring phrase, holding the
 * results that mention it.
 *
 * Clusters overlap by design — an article about "ai infrastructure spending"
 * belongs to both niches, and forcing a single assignment would misreport the
 * size of each. A niche of one is not a niche, so singletons are dropped.
 */
export function deriveNiches(items: NicheItem[], opts: { limit?: number } = {}): Niche[] {
  const limit = Math.max(1, opts.limit ?? 6);
  const docs = items.map((it) => `${it.title ?? ""} ${it.snippet ?? ""}`);
  // Ask for more phrases than niches wanted: many will cluster to one member
  // and be discarded below.
  const phrases = topPhrases(docs, { limit: limit * 4, maxWords: 3, minCount: 2 });

  const niches: Niche[] = [];
  for (const { phrase } of phrases) {
    const members: number[] = [];
    const hostCounts = new Map<string, number>();
    docs.forEach((doc, i) => {
      if (!containsPhrase(doc, phrase)) return;
      members.push(i);
      const host = items[i]?.host;
      if (host) hostCounts.set(host, (hostCounts.get(host) ?? 0) + 1);
    });
    if (members.length < 2) continue;
    niches.push({
      label: phrase,
      count: members.length,
      hosts: [...hostCounts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h),
      members,
    });
    if (niches.length >= limit) break;
  }
  return niches;
}

/** Phrase membership test over raw text, matching `tokenize`'s word boundaries. */
function containsPhrase(text: string, phrase: string): boolean {
  return contains(tokenize(text).join(" "), phrase);
}
