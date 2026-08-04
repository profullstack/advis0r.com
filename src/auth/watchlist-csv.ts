/**
 * Watchlist import / export as CSV.
 *
 * The export is meant to open in a spreadsheet: a header row, then one row per
 * stock with the **ticker leftmost** and the last known price beside it. Prices
 * come from the stored report snapshot, so — like every other price surface
 * here — the row carries the timestamp it was captured at rather than implying
 * it is live.
 *
 * The import is deliberately forgiving. It reads our own export back (keying off
 * the `Symbol` / `Note` header columns and ignoring the price columns, so a file
 * edited in a spreadsheet still loads), and it also accepts a plain list of
 * tickers pasted from anywhere — comma, whitespace, semicolon or newline
 * separated. Everything is validated before it reaches the database.
 */
import { normalizeTicker } from "./watchlist.ts";

/** Column order of the export. Ticker first; price columns are informational. */
export const WATCHLIST_CSV_COLUMNS = ["Symbol", "Note", "Price", "Price As Of", "Added"] as const;

/** File name offered to the browser. */
export const WATCHLIST_CSV_FILENAME = "watchlist.csv";

export interface WatchlistCsvRow {
  ticker: string;
  note?: string;
  createdAt?: string;
}

/** Last known price for one ticker, from its stored report snapshot. */
export interface WatchlistCsvPrice {
  lastPrice?: number;
  /** When that price was captured — never presented as live. */
  generatedAt?: string;
}

/** Escape one CSV field (RFC4180: quote when it holds a comma, quote or newline). */
export function csvField(value: string): string {
  return /["\n\r,]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** Split one CSV line into fields, honoring quoted fields and `""` escapes. */
export function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field.length === 0) {
      quoted = true;
    } else if (ch === ",") {
      fields.push(field);
      field = "";
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

/** `YYYY-MM-DD` from an ISO timestamp; blank when absent or unparseable. */
function day(iso: string | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : "";
}

/**
 * Render the watchlist as CSV, tickers alphabetical. Price cells are blank for
 * a ticker with no stored report — an empty cell reads as "not known", where a
 * zero or a dash would have to be re-parsed by whatever opens the file.
 */
export function formatWatchlistCsv(
  items: WatchlistCsvRow[],
  prices: Record<string, WatchlistCsvPrice | undefined> = {},
): string {
  const rows = [WATCHLIST_CSV_COLUMNS.join(",")];
  const sorted = [...items].sort((a, b) => a.ticker.localeCompare(b.ticker));
  for (const item of sorted) {
    const price = prices[item.ticker];
    rows.push(
      [
        item.ticker,
        csvField(item.note ?? ""),
        typeof price?.lastPrice === "number" && Number.isFinite(price.lastPrice) ? price.lastPrice.toFixed(2) : "",
        day(price?.generatedAt),
        day(item.createdAt),
      ].join(","),
    );
  }
  return rows.join("\n");
}

export interface ParsedWatchlistCsv {
  /** Valid, de-duplicated entries in file order. */
  entries: { ticker: string; note?: string }[];
  /** Tokens that did not look like tickers, for user feedback. */
  invalid: string[];
}

/**
 * Parse an uploaded file into watchlist entries. Handles our own export (by
 * header) and a plain ticker list (anything else).
 */
export function parseWatchlistCsv(text: string): ParsedWatchlistCsv {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return { entries: [], invalid: [] };

  const header = parseCsvLine(lines[0]!).map((h) => h.trim().toLowerCase());
  const symbolAt = header.indexOf("symbol");
  return symbolAt === -1
    ? parsePlainTickers(text)
    : parseRows(lines.slice(1), symbolAt, header.indexOf("note"));
}

/** Our own export, or any CSV carrying a `Symbol` column. */
function parseRows(lines: string[], symbolAt: number, noteAt: number): ParsedWatchlistCsv {
  const entries: { ticker: string; note?: string }[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const fields = parseCsvLine(line);
    const raw = (fields[symbolAt] ?? "").trim();
    if (!raw) continue;
    const ticker = normalizeTicker(raw);
    if (!ticker) {
      invalid.push(raw);
      continue;
    }
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    const note = noteAt === -1 ? undefined : (fields[noteAt] ?? "").trim() || undefined;
    entries.push(note ? { ticker, note } : { ticker });
  }

  return { entries, invalid };
}

/** A pasted list of tickers — comma, whitespace, semicolon or newline separated. */
function parsePlainTickers(text: string): ParsedWatchlistCsv {
  const entries: { ticker: string }[] = [];
  const invalid: string[] = [];
  const seen = new Set<string>();

  for (const token of text.split(/[\s,;]+/)) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    const ticker = normalizeTicker(trimmed);
    if (!ticker) {
      invalid.push(trimmed);
      continue;
    }
    if (seen.has(ticker)) continue;
    seen.add(ticker);
    entries.push({ ticker });
  }

  return { entries, invalid };
}
