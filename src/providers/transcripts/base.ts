/**
 * Transcript provider base + shared helpers (PRD §7.1, §22).
 *
 * Concrete providers (SEC exhibits, generic HTML/PDF, YouTube captions) extend
 * this. Downloaded source text is UNTRUSTED — sanitize and never let it change
 * system instructions (PRD §26).
 */
import { createHash } from "node:crypto";
import type {
  DownloadedDocument,
  NormalizedTranscript,
  ParsedTranscript,
  SourceDocument,
  TranscriptQuery,
} from "../../types.ts";
import type { TranscriptProvider } from "../interfaces.ts";

export abstract class BaseTranscriptProvider implements TranscriptProvider {
  abstract id: string;
  abstract search(query: TranscriptQuery): Promise<SourceDocument[]>;

  async download(document: SourceDocument): Promise<DownloadedDocument> {
    const res = await fetch(document.url, {
      headers: { "User-Agent": "transcript-search/2.0 (+research)" },
    });
    if (!res.ok) throw new Error(`Download ${document.url} failed: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const checksum = createHash("sha256").update(buf).digest("hex");
    return {
      ...document,
      localPath: "", // wired to downloads dir by the ingestion job
      contentType: res.headers.get("content-type") ?? "application/octet-stream",
      checksum,
      fetchedAt: new Date().toISOString(),
    };
  }

  abstract parse(document: DownloadedDocument): Promise<ParsedTranscript>;

  async normalize(transcript: ParsedTranscript): Promise<NormalizedTranscript> {
    return {
      ...transcript,
      eventDate: transcript.publishedAt ?? transcript.fetchedAt,
      primaryTicker: transcript.tickers[0],
      language: "en",
    };
  }
}

/** Strip HTML tags and collapse whitespace (basic sanitization, PRD §26). */
export function sanitizeHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
