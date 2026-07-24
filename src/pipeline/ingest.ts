/**
 * Ingestion pipeline (PRD §21): search → download → parse → normalize →
 * persist (documents / transcripts / segments / FTS) → extract & persist
 * signals. Deduplicates documents and segments (PRD §26).
 *
 * PRD v3: documents now carry publisher / source tier / media provenance, and
 * extraction is filtered by the corpus boilerplate model before anything is
 * written (deterministic, pre-LLM — PRD §12/§13).
 */
import type { Client } from "@libsql/client";
import type { AppConfig } from "../config.ts";
import type { BaseTranscriptProvider } from "../providers/transcripts/base.ts";
import { extractSignals } from "../signals/extract.ts";
import { loadBoilerplateShingles, makeRepeatTest } from "../signals/corpus.ts";
import {
  isMultiCompany,
  loadTickerVocabulary,
  makeSubjectMentionTest,
  subjectTerms,
} from "../signals/subject.ts";
import type { SourceTier, TranscriptQuery } from "../types.ts";

export interface IngestResult {
  documents: number;
  segments: number;
  signals: number;
  /** Signals discarded as filing boilerplate (PRD v3 §4.1). */
  boilerplateSuppressed: number;
  /** Documents that covered several companies and got the subject guard. */
  multiCompanyGuarded: number;
  errors: string[];
}

export interface IngestOptions {
  /** Keep boilerplate signals, flagged rather than dropped (audit mode). */
  keepBoilerplate?: boolean;
}

export async function ingest(
  db: Client,
  _config: AppConfig,
  providers: BaseTranscriptProvider[],
  query: TranscriptQuery,
  onProgress?: (msg: string) => void,
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const result: IngestResult = {
    documents: 0,
    segments: 0,
    signals: 0,
    boilerplateSuppressed: 0,
    multiCompanyGuarded: 0,
    errors: [],
  };
  const now = new Date().toISOString();

  // Corpus boilerplate model is loaded once per run and reused for every
  // document — it is a pure function of already-indexed text.
  const shingleSet = await loadBoilerplateShingles(db);
  const isRepeatedAcrossIssuers = makeRepeatTest(shingleSet);
  if (shingleSet.size) {
    onProgress?.(`boilerplate model: ${shingleSet.size} shingle(s) loaded`);
  }

  // Vocabulary for detecting when a document covers more than one company.
  // The SEC list is authoritative; indexed tickers are unioned in so the guard
  // still works offline with a cold cache.
  const knownTickers = new Set([
    ...(await loadTickerVocabulary()),
    ...(await loadKnownTickers(db)),
  ]);

  for (const provider of providers) {
    let docs;
    try {
      docs = await provider.search(query);
    } catch (err) {
      result.errors.push(`${provider.id} search: ${String(err)}`);
      continue;
    }
    onProgress?.(`${provider.id}: found ${docs.length} document(s)`);

    for (const doc of docs) {
      // Skip already-ingested documents (dedup, PRD §26).
      const existing = await db.execute({
        sql: "SELECT id FROM documents WHERE id = ?",
        args: [doc.id],
      });
      if (existing.rows.length) continue;

      try {
        const downloaded = await provider.download(doc);
        const parsed = await provider.parse(downloaded);
        const normalized = await provider.normalize(parsed);
        const transcriptId = `t:${doc.id}`;
        const ticker = normalized.primaryTicker ?? doc.tickers[0] ?? "";
        const segs = normalized.segments.filter((s) => s.text.trim().length > 0);
        const sourceTier = (doc.sourceTier ?? 0) as SourceTier;

        // A document covering several companies (e.g. "IONQ or QBTS: which
        // should you buy?") must not lend one company's figures to the other,
        // so sentences there have to name the subject (PRD §8.4).
        const fullText = segs.map((s) => s.text).join(" ");
        const multiCompany =
          ticker.length > 0 && isMultiCompany(fullText, ticker, knownTickers);
        if (multiCompany) result.multiCompanyGuarded += 1;
        const mentionsSubject = multiCompany
          ? makeSubjectMentionTest(
              subjectTerms(ticker, (doc.meta?.companyName as string | undefined) ?? undefined),
            )
          : undefined;

        // Extract once with everything flagged, then partition — this keeps the
        // suppression count honest without paying for a second pass.
        const all = extractSignals(normalized, {
          isRepeatedAcrossIssuers,
          sourceTier,
          keepBoilerplate: true,
          mentionsSubject,
        });
        const signals = opts.keepBoilerplate ? all : all.filter((s) => !s.isBoilerplate);
        result.boilerplateSuppressed += all.length - signals.length;

        // One atomic batch per document: documents + transcripts + segments +
        // FTS + signals. Prevents orphaned rows on partial failure (PRD §26).
        const statements = [
          {
            sql: `INSERT OR IGNORE INTO documents
              (id, provider_id, title, url, event_type, published_at, content_type,
               local_path, checksum, fetched_at, meta_json, created_at,
               publisher, source_tier, paywalled, media_url, media_type, duration_ms,
               provenance, asr_model, asr_version)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            args: [
              doc.id, provider.id, doc.title, doc.url, doc.eventType, doc.publishedAt ?? null,
              downloaded.contentType, downloaded.localPath, downloaded.checksum,
              downloaded.fetchedAt, JSON.stringify(doc.meta ?? {}), now,
              // `paywalled` is only known after the fetch attempt, so prefer the
              // downloaded document's verdict over the pre-fetch guess.
              doc.publisher ?? null, sourceTier,
              (downloaded.paywalled ?? doc.paywalled) ? 1 : 0,
              downloaded.mediaUrl ?? doc.mediaUrl ?? null,
              downloaded.mediaType ?? doc.mediaType ?? null,
              downloaded.durationMs ?? doc.durationMs ?? null,
              parsed.provenance ?? "filing", parsed.asrModel ?? null, parsed.asrVersion ?? null,
            ],
          },
          {
            sql: `INSERT OR IGNORE INTO transcripts
              (id, document_id, primary_ticker, event_date, language, created_at)
              VALUES (?,?,?,?,?,?)`,
            args: [transcriptId, doc.id, normalized.primaryTicker ?? null, normalized.eventDate, normalized.language, now],
          },
          ...segs.map((seg) => ({
            sql: `INSERT OR IGNORE INTO transcript_segments
              (id, transcript_id, seg_index, speaker, speaker_title, text, start_ms, end_ms)
              VALUES (?,?,?,?,?,?,?,?)`,
            args: [
              `${transcriptId}:${seg.index}`, transcriptId, seg.index,
              seg.speaker ?? null, seg.speakerTitle ?? null, seg.text,
              seg.startMs ?? null, seg.endMs ?? null,
            ],
          })),
          ...segs.map((seg) => ({
            sql: `INSERT INTO segments_fts (text, speaker, ticker, segment_id, transcript_id, event_date)
                  VALUES (?,?,?,?,?,?)`,
            args: [seg.text, seg.speaker ?? "", ticker, `${transcriptId}:${seg.index}`, transcriptId, normalized.eventDate.slice(0, 10)],
          })),
          ...signals.map((s) => ({
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
        ];
        await db.batch(statements, "write");
        result.segments += segs.length;
        result.signals += signals.length;
        result.documents += 1;
      } catch (err) {
        result.errors.push(`${doc.id}: ${String(err)}`);
      }
    }
  }
  return result;
}

/** Tickers already known to the index — vocabulary for multi-company detection. */
async function loadKnownTickers(db: Client): Promise<Set<string>> {
  try {
    const rs = await db.execute(
      `SELECT DISTINCT primary_ticker AS t FROM transcripts WHERE primary_ticker IS NOT NULL
       UNION SELECT DISTINCT ticker AS t FROM signals WHERE ticker IS NOT NULL`,
    );
    return new Set(rs.rows.map((r) => String(r.t).toUpperCase()).filter(Boolean));
  } catch {
    return new Set();
  }
}
