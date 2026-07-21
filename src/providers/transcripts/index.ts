/**
 * Transcript provider registry (PRD §7.1, §28 Phase 1).
 *
 * - SecExhibitProvider: LIVE. Uses SEC EDGAR full-text search to find 8-K
 *   EX-99 press releases / prepared remarks and other exhibits mentioning a
 *   topic, then downloads and extracts the text. Keyless (needs only a
 *   descriptive User-Agent).
 * - GenericHtmlProvider: LIVE for explicit seed URLs (IR pages, conference
 *   pages). Fetches + sanitizes + segments.
 * - YouTubeCaptionProvider: scaffold (caption import is a Phase 1 follow-up;
 *   returns empty rather than guessing).
 */
import type { AppConfig } from "../../config.ts";
import type {
  DownloadedDocument,
  EventType,
  ParsedTranscript,
  SourceDocument,
  TranscriptQuery,
} from "../../types.ts";
import { BaseTranscriptProvider, sanitizeHtml, segmentText } from "./base.ts";

const EDGAR_FTS = "https://efts.sec.gov/LATEST/search-index";
const SEC_UA = "advis0r.com/2.0 transcript-search (research)";

/** SEC EDGAR full-text search over 8-K/EX-99 exhibits & filings. */
export class SecExhibitProvider extends BaseTranscriptProvider {
  id = "sec-exhibits";

  async search(query: TranscriptQuery): Promise<SourceDocument[]> {
    const params = new URLSearchParams();
    params.set("q", `"${query.topic}"`);
    params.set("forms", "8-K,10-K,10-Q,DEF 14A");
    if (query.from) params.set("startdt", query.from.slice(0, 10));
    if (query.to) params.set("enddt", query.to.slice(0, 10));
    const res = await fetch(`${EDGAR_FTS}?${params.toString()}`, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`EDGAR FTS ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    const hits: any[] = body.hits?.hits ?? [];
    const limit = query.limit ?? 40;
    const out: SourceDocument[] = [];
    for (const hit of hits.slice(0, limit)) {
      const src = hit._source ?? {};
      const displayName: string = src.display_names?.[0] ?? "";
      const ticker = parseTicker(displayName);
      if (!ticker) continue; // must resolve to a public ticker (PRD §29.3)
      const cik = String(src.ciks?.[0] ?? "").replace(/^0+/, "");
      const [accession, filename] = String(hit._id).split(":");
      if (!cik || !accession || !filename) continue;
      const accNoDash = accession.replace(/-/g, "");
      out.push({
        id: `sec:${hit._id}`,
        providerId: this.id,
        title: `${src.form} — ${displayName}`,
        url: `https://www.sec.gov/Archives/edgar/data/${cik}/${accNoDash}/${filename}`,
        eventType: formToEventType(src.form, filename),
        publishedAt: src.file_date,
        tickers: [ticker],
        meta: { cik, accession, form: src.form, companyName: parseCompanyName(displayName) },
      });
    }
    return out;
  }

  async parse(document: DownloadedDocument): Promise<ParsedTranscript> {
    const raw = await Bun.file(document.localPath).text();
    const clean = sanitizeHtml(raw);
    const segments = segmentText(clean);
    return { ...document, segments: segments.length ? segments : [{ index: 0, text: clean }] };
  }
}

/** Generic HTML/PDF transcript page — used with explicit seed URLs. */
export class GenericHtmlProvider extends BaseTranscriptProvider {
  id = "generic-html";
  async search(query: TranscriptQuery): Promise<SourceDocument[]> {
    // Seed URLs may be passed via query.tickers as "TICKER=https://..." pairs.
    const seeds = (query.tickers ?? []).filter((t) => t.includes("http"));
    return seeds.map((seed, i) => {
      const [ticker, url] = seed.includes("=") ? seed.split("=") : [`SEED${i}`, seed];
      return {
        id: `html:${url}`,
        providerId: this.id,
        title: url!,
        url: url!,
        eventType: "presentation" as EventType,
        tickers: [ticker!.toUpperCase()],
      } satisfies SourceDocument;
    });
  }
  async parse(document: DownloadedDocument): Promise<ParsedTranscript> {
    const raw = await Bun.file(document.localPath).text();
    const clean = sanitizeHtml(raw);
    const segments = segmentText(clean);
    return { ...document, segments: segments.length ? segments : [{ index: 0, text: clean }] };
  }
}

/** Official company YouTube channel captions (Phase 1 follow-up). */
export class YouTubeCaptionProvider extends BaseTranscriptProvider {
  id = "youtube-captions";
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async search(_query: TranscriptQuery): Promise<SourceDocument[]> {
    return []; // caption import requires channel resolution + VTT fetch (TODO)
  }
  async parse(document: DownloadedDocument): Promise<ParsedTranscript> {
    return { ...document, segments: [{ index: 0, text: "" }] };
  }
}

function parseTicker(displayName: string): string | null {
  // "AZIO AI HOLDINGS, INC.  (EVTV)  (CIK 0001563568)" -> EVTV
  const m = displayName.match(/\(([A-Z][A-Z.]{0,5})\)\s*\(CIK/);
  return m ? m[1]!.replace(/\.$/, "") : null;
}
function parseCompanyName(displayName: string): string {
  return displayName.split(/\s{2,}\(/)[0]?.trim() ?? displayName;
}
function formToEventType(form: string, filename: string): EventType {
  const f = (form ?? "").toUpperCase();
  if (/ex_?99|ex99|ex-99/i.test(filename)) return "sec_exhibit";
  if (f.startsWith("8-K")) return "sec_exhibit";
  if (f === "10-K" || f === "10-Q") return "sec_exhibit";
  if (f.includes("14A")) return "shareholder_meeting";
  return "sec_exhibit";
}

export function buildTranscriptProviders(config: AppConfig): BaseTranscriptProvider[] {
  return [
    new SecExhibitProvider(config.downloadsDir),
    new GenericHtmlProvider(config.downloadsDir),
    new YouTubeCaptionProvider(config.downloadsDir),
  ];
}
