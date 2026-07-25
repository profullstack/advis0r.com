/**
 * Re-run signal extraction over already-stored documents.
 *
 * `reclassify` re-judges the signals that exist; it cannot create ones that
 * never existed. When the taxonomy gains a rule — `acquisition` was added after
 * a WCC run indexed "Aims to Acquire Newark Engineering" and extracted nothing
 * — every document already in the index is blind to it, and re-ingesting would
 * mean re-downloading sources we already hold.
 *
 * This pass rebuilds each transcript from stored segments and extracts again.
 * It is safe to run repeatedly: signal ids are deterministic (ticker, date,
 * type, quote hash), so `INSERT OR IGNORE` writes only what is genuinely new
 * and nothing is ever deleted or rewritten here.
 *
 * The same guards as ingestion apply — corpus boilerplate model and the
 * multi-company subject test — so a re-extraction cannot admit sentences that a
 * fresh ingest would have rejected.
 */
import type { Client } from "@libsql/client";
import { extractSignals } from "../signals/extract.ts";
import { loadBoilerplateShingles, makeRepeatTest } from "../signals/corpus.ts";
import {
  isMultiCompany,
  loadTickerVocabulary,
  makeSubjectAttributionTest,
  subjectTerms,
} from "../signals/subject.ts";
import type { EventType, SourceTier } from "../types.ts";

export interface ReextractOptions {
  /** Restrict to one provider ("news", "sec-exhibits", …). */
  providerId?: string;
  /** Restrict to these tickers. */
  tickers?: string[];
  /** Report what would be written without writing it. */
  dryRun?: boolean;
}

export interface ReextractResult {
  documents: number;
  signalsFound: number;
  signalsInserted: number;
  /** New signals by type — the point of the run, so it is reported. */
  byType: Record<string, number>;
  errors: string[];
}

export async function reextractSignals(
  db: Client,
  opts: ReextractOptions = {},
  onProgress?: (message: string) => void,
): Promise<ReextractResult> {
  const result: ReextractResult = {
    documents: 0,
    signalsFound: 0,
    signalsInserted: 0,
    byType: {},
    errors: [],
  };
  const now = new Date().toISOString();

  const shingles = await loadBoilerplateShingles(db);
  const isRepeatedAcrossIssuers = makeRepeatTest(shingles);
  const knownTickers = new Set(await loadTickerVocabulary());
  onProgress?.(`boilerplate model: ${shingles.size} shingle(s)`);

  const filters: string[] = ["t.primary_ticker IS NOT NULL"];
  const args: unknown[] = [];
  if (opts.providerId) {
    filters.push("d.provider_id = ?");
    args.push(opts.providerId);
  }
  if (opts.tickers?.length) {
    filters.push(`t.primary_ticker IN (${opts.tickers.map(() => "?").join(",")})`);
    args.push(...opts.tickers.map((x) => x.toUpperCase()));
  }

  const docs = await db.execute({
    sql: `SELECT d.id, d.url, d.event_type, d.source_tier, d.meta_json, d.provenance,
                 t.id AS transcript_id, t.primary_ticker, t.event_date
          FROM documents d JOIN transcripts t ON t.document_id = d.id
          WHERE ${filters.join(" AND ")}
          ORDER BY d.created_at ASC`,
    args: args as never,
  });
  onProgress?.(`${docs.rows.length} document(s) to re-extract`);

  // Existing signal ids, so "inserted" counts what is actually new rather than
  // what INSERT OR IGNORE quietly dropped.
  const existing = new Set<string>();
  const idRs = await db.execute("SELECT id FROM signals");
  for (const r of idRs.rows) existing.add(String(r.id));

  for (const doc of docs.rows) {
    const ticker = String(doc.primary_ticker ?? "").toUpperCase();
    if (!ticker) continue;
    try {
      const segRs = await db.execute({
        sql: `SELECT seg_index, speaker, speaker_title, text, start_ms
              FROM transcript_segments WHERE transcript_id = ? ORDER BY seg_index ASC`,
        args: [String(doc.transcript_id)],
      });
      const segments = segRs.rows
        .map((s) => ({
          index: Number(s.seg_index),
          text: String(s.text ?? ""),
          speaker: s.speaker ? String(s.speaker) : undefined,
          speakerTitle: s.speaker_title ? String(s.speaker_title) : undefined,
          startMs: s.start_ms == null ? undefined : Number(s.start_ms),
        }))
        .filter((s) => s.text.trim().length > 0);
      if (!segments.length) continue;

      let companyName: string | undefined;
      try {
        companyName = JSON.parse(String(doc.meta_json ?? "{}")).companyName;
      } catch {
        /* malformed meta is not fatal */
      }

      const fullText = segments.map((s) => s.text).join(" ");
      const multiCompany = isMultiCompany(fullText, ticker, knownTickers);
      const mentionsSubject = multiCompany
        ? makeSubjectAttributionTest(subjectTerms(ticker, companyName), ticker, knownTickers)
        : undefined;
      const sourceTier = (doc.source_tier == null ? 0 : Number(doc.source_tier)) as SourceTier;

      const signals = extractSignals(
        {
          id: String(doc.id),
          providerId: "reextract",
          title: "",
          url: String(doc.url ?? ""),
          eventType: String(doc.event_type ?? "document") as EventType,
          tickers: [ticker],
          localPath: "",
          contentType: "text/plain",
          checksum: "",
          fetchedAt: now,
          segments,
          provenance: (doc.provenance as never) ?? undefined,
          eventDate: String(doc.event_date ?? now).slice(0, 10),
          primaryTicker: ticker,
          language: "en",
        } as never,
        { isRepeatedAcrossIssuers, sourceTier, mentionsSubject },
      );

      result.documents += 1;
      result.signalsFound += signals.length;
      const fresh = signals.filter((s) => !existing.has(s.id));
      if (!fresh.length) continue;

      for (const s of fresh) {
        result.byType[s.signalType] = (result.byType[s.signalType] ?? 0) + 1;
        existing.add(s.id);
      }
      if (opts.dryRun) {
        result.signalsInserted += fresh.length;
        continue;
      }

      await db.batch(
        fresh.map((s) => ({
          sql: `INSERT OR IGNORE INTO signals
              (id, ticker, speaker, speaker_title, event_date, event_type, signal_type,
               direction, strength, novelty, specificity, quote, context_before,
               context_after, source_url, evidence_hash, created_at,
               source_tier, is_boilerplate, boilerplate_reasons, speaker_confidence,
               start_ms, provenance)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          args: [
            s.id, s.ticker, s.speaker, s.speakerTitle ?? null, s.eventDate, s.eventType,
            s.signalType, s.direction, s.strength, s.novelty, s.specificity, s.quote,
            s.contextBefore, s.contextAfter, s.sourceUrl, s.evidenceHash, now,
            s.sourceTier ?? sourceTier, s.isBoilerplate ? 1 : 0,
            s.boilerplateReasons?.length ? s.boilerplateReasons.join(",") : null,
            s.speakerConfidence ?? null, s.startMs ?? null, s.provenance ?? null,
          ],
        })),
        "write",
      );
      result.signalsInserted += fresh.length;
    } catch (err) {
      result.errors.push(`${String(doc.id)}: ${String(err).slice(0, 200)}`);
    }
  }

  return result;
}
