/**
 * Corpus-level boilerplate statistics (PRD v3 §4.1c).
 *
 * The most robust boilerplate test needs no rules at all: language that appears
 * near-verbatim under many *distinct issuers* is, by definition, standard filing
 * text rather than a company-specific claim. This module derives that set from
 * the corpus itself, so it self-tunes as the index grows.
 *
 * Deterministic and LLM-free. Stored in `boilerplate_shingles` so extraction
 * stays cheap at ingest time.
 */
import type { Client } from "@libsql/client";
import { shingles } from "./boilerplate.ts";

/** A shingle must appear under at least this many distinct tickers to count. */
export const DEFAULT_MIN_ISSUERS = 3;

/** Fraction of a sentence's shingles that must be corpus-boilerplate to flag it. */
export const DEFAULT_MATCH_RATIO = 0.6;

export interface CorpusBuildResult {
  sentencesScanned: number;
  shinglesConsidered: number;
  shinglesStored: number;
  minIssuers: number;
}

/**
 * Rebuild `boilerplate_shingles` from the signal corpus.
 *
 * Signal quotes (rather than every segment) are used deliberately: they are the
 * sentences that actually reach the extractor, which keeps the scan ~5x smaller
 * while covering exactly the population we need to filter.
 */
export async function buildCorpusBoilerplate(
  db: Client,
  opts: { minIssuers?: number } = {},
): Promise<CorpusBuildResult> {
  const minIssuers = opts.minIssuers ?? DEFAULT_MIN_ISSUERS;
  const rs = await db.execute("SELECT ticker, quote FROM signals WHERE quote IS NOT NULL");

  // shingle -> set of tickers it was seen under
  const issuers = new Map<string, Set<string>>();
  let sentencesScanned = 0;
  for (const row of rs.rows) {
    const ticker = String(row.ticker ?? "");
    const quote = String(row.quote ?? "");
    if (!ticker || !quote) continue;
    sentencesScanned++;
    for (const sh of shingles(quote)) {
      let set = issuers.get(sh);
      if (!set) issuers.set(sh, (set = new Set()));
      set.add(ticker);
    }
  }

  const keep: [string, number][] = [];
  for (const [sh, set] of issuers) {
    if (set.size >= minIssuers) keep.push([sh, set.size]);
  }

  const now = new Date().toISOString();
  await db.execute("DELETE FROM boilerplate_shingles");
  // Chunked batches keep individual libSQL requests well inside limits.
  const CHUNK = 500;
  for (let i = 0; i < keep.length; i += CHUNK) {
    await db.batch(
      keep.slice(i, i + CHUNK).map(([shingle, count]) => ({
        sql: "INSERT OR REPLACE INTO boilerplate_shingles (shingle, issuer_count, updated_at) VALUES (?,?,?)",
        args: [shingle, count, now],
      })),
      "write",
    );
  }

  return {
    sentencesScanned,
    shinglesConsidered: issuers.size,
    shinglesStored: keep.length,
    minIssuers,
  };
}

/** Load the stored boilerplate shingle set for use during extraction. */
export async function loadBoilerplateShingles(db: Client): Promise<Set<string>> {
  try {
    const rs = await db.execute("SELECT shingle FROM boilerplate_shingles");
    return new Set(rs.rows.map((r) => String(r.shingle)));
  } catch {
    // Table not yet created (pre-migration DB) — degrade to rule-only filtering.
    return new Set();
  }
}

/**
 * Build the sentence test used by `extractSignals`. A sentence is flagged when
 * a sufficient fraction of its shingles are corpus boilerplate — proportional
 * rather than any-match, so one shared phrase inside an otherwise specific
 * sentence does not discard a real claim.
 */
export function makeRepeatTest(
  set: Set<string>,
  matchRatio = DEFAULT_MATCH_RATIO,
): (sentence: string) => boolean {
  if (set.size === 0) return () => false;
  return (sentence: string) => {
    const sh = shingles(sentence);
    if (sh.length === 0) return false;
    let hits = 0;
    for (const s of sh) if (set.has(s)) hits++;
    return hits / sh.length >= matchRatio;
  };
}
