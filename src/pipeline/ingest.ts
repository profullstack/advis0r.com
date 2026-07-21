/**
 * Ingestion pipeline (PRD §21): search → download → parse → normalize →
 * persist (documents / transcripts / segments / FTS) → extract & persist
 * signals. Deduplicates documents and segments (PRD §26).
 */
import type { Client } from "@libsql/client";
import type { AppConfig } from "../config.ts";
import type { BaseTranscriptProvider } from "../providers/transcripts/base.ts";
import { extractSignals } from "../signals/extract.ts";
import type { TranscriptQuery } from "../types.ts";

export interface IngestResult {
  documents: number;
  segments: number;
  signals: number;
  errors: string[];
}

export async function ingest(
  db: Client,
  _config: AppConfig,
  providers: BaseTranscriptProvider[],
  query: TranscriptQuery,
  onProgress?: (msg: string) => void,
): Promise<IngestResult> {
  const result: IngestResult = { documents: 0, segments: 0, signals: 0, errors: [] };
  const now = new Date().toISOString();

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
        const signals = extractSignals(normalized);

        // One atomic batch per document: documents + transcripts + segments +
        // FTS + signals. Prevents orphaned rows on partial failure (PRD §26).
        const statements = [
          {
            sql: `INSERT OR IGNORE INTO documents
              (id, provider_id, title, url, event_type, published_at, content_type,
               local_path, checksum, fetched_at, meta_json, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
            args: [
              doc.id, provider.id, doc.title, doc.url, doc.eventType, doc.publishedAt ?? null,
              downloaded.contentType, downloaded.localPath, downloaded.checksum,
              downloaded.fetchedAt, JSON.stringify(doc.meta ?? {}), now,
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
              (id, transcript_id, seg_index, speaker, speaker_title, text) VALUES (?,?,?,?,?,?)`,
            args: [`${transcriptId}:${seg.index}`, transcriptId, seg.index, seg.speaker ?? null, seg.speakerTitle ?? null, seg.text],
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
               context_after, source_url, evidence_hash, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            args: [
              s.id, s.ticker, s.speaker, s.speakerTitle ?? null, s.eventDate, s.eventType,
              s.signalType, s.direction, s.strength, s.novelty, s.specificity, s.quote,
              s.contextBefore, s.contextAfter, s.sourceUrl, s.evidenceHash, now,
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
