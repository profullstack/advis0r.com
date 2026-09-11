/**
 * Symbol directory sync from nichedb's `kind=symbol` mirror.
 *
 * Replaces the Alpaca `/v2/assets` pull when `NICHEDB_MARKETS` is on: the
 * first sync walks the whole directory (~14k rows, ~72 pages of 200), every
 * later sync passes the stored cursor as `since=` and reads only the rows
 * whose `updated_at` moved — between listings that is a page or none.
 *
 * The cursor is the newest `updated_at` seen on a completed walk, kept in
 * `nichedb_cursor` under `symbols.since`. It is only advanced after the walk
 * finishes, so a walk cut short by a network error is simply repeated.
 * `since` is inclusive, so the boundary row is re-read once; the upsert makes
 * that harmless.
 */
import type { Client } from "@libsql/client";
import type { NichedbClient } from "../providers/nichedb.ts";
import { symbolItemsToRows } from "../providers/nichedb-markets.ts";
import { upsertSymbols } from "./directory.ts";

export const SYMBOLS_CURSOR_KEY = "symbols.since";

export async function readCursor(db: Client, key: string): Promise<string | undefined> {
  const rs = await db.execute({ sql: "SELECT value FROM nichedb_cursor WHERE key = ?", args: [key] });
  const v = rs.rows[0]?.value;
  return v == null ? undefined : String(v);
}

export async function writeCursor(db: Client, key: string, value: string): Promise<void> {
  await db.execute({
    sql: `INSERT INTO nichedb_cursor (key, value, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    args: [key, value, new Date().toISOString()],
  });
}

export interface SymbolSyncResult {
  /** Rows written to `symbols` (crypto pairs and malformed items excluded). */
  written: number;
  /** Items nichedb returned across every page. */
  items: number;
  pages: number;
  /** The cursor the walk started from, if any. */
  since?: string;
  /** The cursor stored for next time. */
  cursor?: string;
}

/**
 * Walk the mirror and upsert each page as it arrives, so a 14k-row first sync
 * does not hold every row in memory and a page that lands is kept even if a
 * later one fails. Returns what was done; throws only when nichedb itself
 * fails, so the caller can fall back to the Alpaca list.
 */
export async function syncSymbolsFromNichedb(
  db: Client,
  client: NichedbClient,
  opts: { onProgress?: (msg: string) => void; upsert?: typeof upsertSymbols } = {},
): Promise<SymbolSyncResult> {
  const upsert = opts.upsert ?? upsertSymbols;
  const since = await readCursor(db, SYMBOLS_CURSOR_KEY);
  const result: SymbolSyncResult = { written: 0, items: 0, pages: 0, since };
  let newest = since ?? "";

  for await (const page of client.mirrorSymbols({ since })) {
    result.pages += 1;
    result.items += page.items.length;
    for (const item of page.items) {
      if (item.updated_at && item.updated_at > newest) newest = item.updated_at;
    }
    const rows = symbolItemsToRows(page.items);
    result.written += await upsert(db, rows);
    opts.onProgress?.(`page ${page.page + 1}: ${page.items.length} item(s), ${rows.length} row(s)`);
  }

  if (newest && newest !== since) {
    await writeCursor(db, SYMBOLS_CURSOR_KEY, newest);
    result.cursor = newest;
  } else {
    result.cursor = since;
  }
  return result;
}
