/**
 * Retroactive boilerplate classification (PRD v3 §4.1).
 *
 * Signals indexed before the boilerplate model existed are still in the
 * database. Re-running ingestion would mean re-downloading every source
 * document; instead this pass rebuilds the corpus model and re-classifies the
 * stored signals in place.
 *
 * Nothing is deleted — rows are *flagged* (`is_boilerplate`) with the reasons
 * that fired, so a suppression decision stays auditable and reversible
 * (PRD §26, §27: show what was filtered rather than silently dropping it).
 */
import type { Client } from "@libsql/client";
import { classifySentence } from "../signals/boilerplate.ts";
import {
  buildCorpusBoilerplate,
  loadBoilerplateShingles,
  makeRepeatTest,
} from "../signals/corpus.ts";
import {
  isMultiCompany,
  loadTickerVocabulary,
  makeSubjectMentionTest,
  subjectTerms,
} from "../signals/subject.ts";

export interface ReclassifyResult {
  scanned: number;
  flagged: number;
  cleared: number;
  byReason: Record<string, number>;
  corpusShingles: number;
  /** Signals removed as misattributed from a multi-company document. */
  misattributed: number;
}

/**
 * Remove signals attributed to a company by a document that also covers other
 * companies but whose sentence never names the subject (PRD §8.4).
 *
 * These are deleted rather than flagged: a boilerplate signal is a real
 * sentence of low value, but a misattributed one asserts something false about
 * the company and must not survive in the evidence base at all.
 */
async function purgeMisattributed(
  db: Client,
  onProgress?: (msg: string) => void,
): Promise<number> {
  const knownRs = await db.execute(
    `SELECT DISTINCT ticker AS t FROM signals WHERE ticker IS NOT NULL AND ticker <> ''`,
  );
  const known = new Set([
    ...(await loadTickerVocabulary()),
    ...knownRs.rows.map((r) => String(r.t).toUpperCase()),
  ]);

  // Only multi-source (news/media) documents are at risk; SEC filings are
  // single-issuer by construction.
  const docs = await db.execute(
    `SELECT d.id, d.meta_json, t.primary_ticker AS ticker,
            GROUP_CONCAT(s.text, ' ') AS text
     FROM documents d
     JOIN transcripts t ON t.document_id = d.id
     JOIN transcript_segments s ON s.transcript_id = t.id
     WHERE COALESCE(d.source_tier, 0) > 0 AND t.primary_ticker IS NOT NULL
     GROUP BY d.id`,
  );

  const doomed: string[] = [];
  for (const row of docs.rows) {
    const ticker = String(row.ticker ?? "").toUpperCase();
    const text = String(row.text ?? "");
    if (!ticker || !text) continue;
    if (!isMultiCompany(text, ticker, known)) continue;

    let companyName: string | undefined;
    try {
      companyName = JSON.parse(String(row.meta_json ?? "{}")).companyName;
    } catch {
      /* meta is optional */
    }
    const mentions = makeSubjectMentionTest(subjectTerms(ticker, companyName));

    const sigs = await db.execute({
      sql: `SELECT s.id, s.quote FROM signals s
            JOIN documents d ON d.url = s.source_url
            WHERE d.id = ? AND s.ticker = ?`,
      args: [String(row.id), ticker],
    });
    for (const sig of sigs.rows) {
      if (!mentions(String(sig.quote ?? ""))) doomed.push(String(sig.id));
    }
  }

  const CHUNK = 400;
  for (let i = 0; i < doomed.length; i += CHUNK) {
    await db.batch(
      doomed.slice(i, i + CHUNK).map((id) => ({
        sql: "DELETE FROM signals WHERE id = ?",
        args: [id],
      })),
      "write",
    );
  }
  if (doomed.length) {
    onProgress?.(`removed ${doomed.length} misattributed signal(s) from multi-company documents`);
  }
  return doomed.length;
}

export async function reclassifySignals(
  db: Client,
  opts: { rebuildCorpus?: boolean; minIssuers?: number } = {},
  onProgress?: (msg: string) => void,
): Promise<ReclassifyResult> {
  if (opts.rebuildCorpus !== false) {
    const built = await buildCorpusBoilerplate(db, { minIssuers: opts.minIssuers });
    onProgress?.(
      `corpus model: scanned ${built.sentencesScanned} quote(s), stored ${built.shinglesStored} shingle(s) seen under >= ${built.minIssuers} issuers`,
    );
  }

  // Misattribution is purged first so the boilerplate pass does not waste work
  // classifying rows that should not exist.
  const misattributed = await purgeMisattributed(db, onProgress);

  const shingleSet = await loadBoilerplateShingles(db);
  const isRepeatedAcrossIssuers = makeRepeatTest(shingleSet);

  const rs = await db.execute(
    "SELECT id, quote, context_before, context_after FROM signals",
  );

  const result: ReclassifyResult = {
    scanned: rs.rows.length,
    flagged: 0,
    cleared: 0,
    byReason: {},
    corpusShingles: shingleSet.size,
    misattributed,
  };

  const updates: { sql: string; args: (string | number | null)[] }[] = [];
  for (const row of rs.rows) {
    const verdict = classifySentence({
      sentence: String(row.quote ?? ""),
      contextBefore: String(row.context_before ?? ""),
      contextAfter: String(row.context_after ?? ""),
      isRepeatedAcrossIssuers,
    });
    if (verdict.isBoilerplate) {
      result.flagged++;
      for (const r of verdict.reasons) result.byReason[r] = (result.byReason[r] ?? 0) + 1;
    } else {
      result.cleared++;
    }
    updates.push({
      sql: "UPDATE signals SET is_boilerplate = ?, boilerplate_reasons = ? WHERE id = ?",
      args: [
        verdict.isBoilerplate ? 1 : 0,
        verdict.reasons.length ? verdict.reasons.join(",") : null,
        String(row.id),
      ],
    });
  }

  const CHUNK = 500;
  for (let i = 0; i < updates.length; i += CHUNK) {
    await db.batch(updates.slice(i, i + CHUNK), "write");
    onProgress?.(`reclassified ${Math.min(i + CHUNK, updates.length)}/${updates.length}`);
  }

  return result;
}
