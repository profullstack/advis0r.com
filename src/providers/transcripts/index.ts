/**
 * Transcript provider registry (PRD §7.1, §28 Phase 1).
 *
 * NOTE: These providers are scaffolded stubs for the MVP. Each `search`/`parse`
 * is marked TODO and returns empty until the crawler/extractor for that source
 * is implemented. The interfaces and pipeline around them are complete, so the
 * deterministic market/technical/scoring path is fully exercisable today.
 */
import type { AppConfig } from "../../config.ts";
import type {
  DownloadedDocument,
  ParsedTranscript,
  SourceDocument,
  TranscriptQuery,
} from "../../types.ts";
import { BaseTranscriptProvider, sanitizeHtml } from "./base.ts";

/** SEC exhibit / EX-99 press-release & presentation materials. */
export class SecExhibitProvider extends BaseTranscriptProvider {
  id = "sec-exhibits";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_query: TranscriptQuery): Promise<SourceDocument[]> {
    // TODO(phase1): query EDGAR full-text search for 8-K/EX-99 exhibits.
    return [];
  }
  async parse(document: DownloadedDocument): Promise<ParsedTranscript> {
    return { ...document, segments: [{ index: 0, text: "" }] };
  }
}

/** Generic HTML/PDF transcript page (IR sites, conference pages). */
export class GenericHtmlProvider extends BaseTranscriptProvider {
  id = "generic-html";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_query: TranscriptQuery): Promise<SourceDocument[]> {
    // TODO(phase1): accept seed URLs / IR crawl frontier.
    return [];
  }
  async parse(document: DownloadedDocument): Promise<ParsedTranscript> {
    const raw = document.localPath ? await Bun.file(document.localPath).text() : "";
    const text = sanitizeHtml(raw);
    return {
      ...document,
      segments: text ? [{ index: 0, text }] : [{ index: 0, text: "" }],
    };
  }
}

/** Official company YouTube channel captions. */
export class YouTubeCaptionProvider extends BaseTranscriptProvider {
  id = "youtube-captions";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_query: TranscriptQuery): Promise<SourceDocument[]> {
    // TODO(phase1): resolve channel -> videos with captions; import VTT.
    return [];
  }
  async parse(document: DownloadedDocument): Promise<ParsedTranscript> {
    return { ...document, segments: [{ index: 0, text: "" }] };
  }
}

export function buildTranscriptProviders(_config: AppConfig): BaseTranscriptProvider[] {
  return [
    new SecExhibitProvider(),
    new GenericHtmlProvider(),
    new YouTubeCaptionProvider(),
  ];
}
