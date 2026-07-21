/**
 * Transcript provider base + shared helpers (PRD §7.1, §22).
 *
 * Concrete providers (SEC exhibits, generic HTML/PDF, YouTube captions) extend
 * this. Downloaded source text is UNTRUSTED — sanitize and never let it change
 * system instructions (PRD §26). Downloads are written to disk and checksummed
 * for audit/reproducibility (PRD §26).
 */
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  DownloadedDocument,
  NormalizedTranscript,
  ParsedTranscript,
  SourceDocument,
  TranscriptQuery,
} from "../../types.ts";
import type { TranscriptProvider } from "../interfaces.ts";

// SEC fair-access requires a descriptive UA including a contact email; other
// hosts accept it fine. Overridable via SEC_USER_AGENT.
const USER_AGENT =
  process.env.SEC_USER_AGENT?.replace(/^"|"$/g, "") ??
  "advis0r.com research (anthony@profullstack.com)";

export abstract class BaseTranscriptProvider implements TranscriptProvider {
  abstract id: string;
  constructor(protected downloadsDir: string = "./data/downloads") {}

  abstract search(query: TranscriptQuery): Promise<SourceDocument[]>;

  async download(document: SourceDocument): Promise<DownloadedDocument> {
    const res = await fetch(document.url, {
      headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml,*/*" },
    });
    if (!res.ok) throw new Error(`Download ${document.url} failed: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const checksum = createHash("sha256").update(buf).digest("hex");
    await mkdir(this.downloadsDir, { recursive: true });
    const localPath = join(this.downloadsDir, `${checksum.slice(0, 16)}.raw`);
    await Bun.write(localPath, buf);
    return {
      ...document,
      localPath,
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
  return decodeEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#8217;|&#8216;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;/g, '"')
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return code > 31 && code < 0x10ffff ? String.fromCodePoint(code) : " ";
    });
}

/** Split cleaned text into pseudo-segments of ~1 paragraph each. */
export function segmentText(text: string): { index: number; text: string }[] {
  const chunks = text
    .split(/(?<=[.!?])\s+(?=[A-Z0-9$"])/)
    .reduce<string[]>((acc, sentence) => {
      const last = acc.at(-1);
      if (last && last.length < 600) acc[acc.length - 1] = `${last} ${sentence}`;
      else acc.push(sentence);
      return acc;
    }, []);
  return chunks
    .map((t, index) => ({ index, text: t.trim() }))
    .filter((s) => s.text.length > 0);
}
