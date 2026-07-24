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

export interface ReclassifyResult {
  scanned: number;
  flagged: number;
  cleared: number;
  byReason: Record<string, number>;
  corpusShingles: number;
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
