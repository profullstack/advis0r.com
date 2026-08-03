/**
 * The symbol directory: turn what a person types into a ticker.
 *
 * Before this, knowing the ticker was a precondition for using a tool whose job
 * is to find tickers. "rivian" was rejected by the watchlist (over five
 * letters), missing from the signals box (which wants an exact symbol), and
 * answered by full-text search with Amazon's 10-Q — because that filing
 * mentions their Rivian stake. Three dead ends for a company the app already
 * had a price for.
 *
 * The directory is local-first: a bulk sync from the Alpaca asset list makes
 * lookup a single indexed query with no third-party call on the hot path. When
 * there are no Alpaca credentials, or the query misses, a keyless Yahoo search
 * fills the gap and its results are cached — so the same miss is only ever paid
 * for once.
 */
import type { Client } from "@libsql/client";

export interface SymbolRow {
  symbol: string;
  name: string;
  exchange?: string;
  assetClass?: string;
  status?: string;
  tradable?: boolean;
  source: "alpaca" | "yahoo";
}

export interface SymbolMatch {
  symbol: string;
  name: string;
  exchange?: string;
  /** Why this matched, highest first — the UI groups exact hits above the rest. */
  rank: number;
}

/**
 * Exchanges worth surfacing first in a picker. A ticker on one of these is the
 * listing someone typing a company name almost certainly means; OTC carries the
 * shells and the grey-market duplicates.
 */
export const PREFERRED_EXCHANGES = ["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS"] as const;

/** The same list as a SQL literal, so ranking has one source of truth. */
const PREFERRED_SQL = PREFERRED_EXCHANGES.map((x) => `'${x}'`).join(",");

const iso = () => new Date().toISOString();

/**
 * Normalize a user's query.
 *
 * Deliberately permissive: this is the one input in the app that is *meant* to
 * accept prose. Punctuation is dropped so "rivian, inc." and "berkshire
 * hathaway" behave, and length is capped so a pasted paragraph cannot turn into
 * a table scan with a 4KB LIKE pattern.
 */
export function normalizeQuery(raw: unknown): string {
  return String(raw ?? "")
    .trim()
    .replace(/[%_]/g, " ") // LIKE wildcards, neutralized before they reach SQL
    .replace(/[^\p{L}\p{N}.\-& ]/gu, " ")
    .replace(/\s+/g, " ")
    .slice(0, 64)
    .trim();
}

/** True when the query is already shaped like a ticker. */
export function looksLikeTicker(q: string): boolean {
  return /^[A-Za-z]{1,5}(\.[A-Za-z]{1,2})?$/.test(q);
}

/**
 * The form company names are matched in: lowercase, punctuation collapsed to
 * spaces.
 *
 * Applied to both the stored name and the query, so how a name is punctuated
 * stops mattering. Without it "coca cola" missed The Coca-Cola Company outright
 * — the hyphen in the stored name meant the LIKE could never match, even though
 * the search that fetched it had returned exactly the right row.
 */
export function searchableText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    // Drop a leading article. "The Coca-Cola Company" must rank as a
    // *starts-with* hit for "coca cola", or it loses to Coca-Cola Europacific
    // and Coca-Cola Consolidated — whose legal names happen not to begin with
    // "The" — and the company everybody meant falls off the list.
    .replace(/^the /, "");
}

export async function countSymbols(db: Client): Promise<number> {
  const rs = await db.execute("SELECT COUNT(*) AS n FROM symbols");
  return Number(rs.rows[0]?.n ?? 0);
}

/** Bulk upsert. Chunked, because libSQL may be a remote Turso instance. */
export async function upsertSymbols(db: Client, rows: SymbolRow[]): Promise<number> {
  if (!rows.length) return 0;
  const now = iso();
  let written = 0;
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await db.batch(
      chunk.map((r) => ({
        sql: `INSERT INTO symbols
                (symbol, name, exchange, asset_class, status, tradable, source, updated_at, name_search)
              VALUES (?,?,?,?,?,?,?,?,?)
              ON CONFLICT(symbol) DO UPDATE SET
                name = excluded.name,
                exchange = COALESCE(excluded.exchange, symbols.exchange),
                asset_class = COALESCE(excluded.asset_class, symbols.asset_class),
                status = COALESCE(excluded.status, symbols.status),
                tradable = excluded.tradable,
                source = excluded.source,
                updated_at = excluded.updated_at,
                name_search = excluded.name_search`,
        args: [
          r.symbol.toUpperCase(),
          r.name,
          r.exchange ?? null,
          r.assetClass ?? null,
          r.status ?? null,
          r.tradable === false ? 0 : 1,
          r.source,
          now,
          searchableText(r.name),
        ],
      })),
      "write",
    );
    written += chunk.length;
  }
  return written;
}

/**
 * Search the local directory.
 *
 * Ranking is the whole feature. "rivian" has to put RIVN first, not a
 * shell company whose name happens to start with the same letters, and "aapl"
 * has to put AAPL first rather than every name containing that substring. The
 * tiers, highest first:
 *
 *   100  exact symbol            "rivn" -> RIVN
 *    90  symbol starts with      "riv"  -> RIVN
 *    80  name starts with        "rivian" -> Rivian Automotive
 *    70  a word in the name starts with the query
 *    60  name contains it anywhere
 *
 * Ties break toward a real listing: a preferred exchange first, then the
 * shorter symbol (primary listings are short; warrants and units carry
 * suffixes), then alphabetically so results are stable between keystrokes.
 */
export async function searchSymbols(
  db: Client,
  rawQuery: string,
  limit = 10,
): Promise<SymbolMatch[]> {
  const q = normalizeQuery(rawQuery);
  if (q.length < 1) return [];
  const lower = q.toLowerCase();
  // Symbols are matched literally (so BRK.B works); names are matched in the
  // punctuation-insensitive form, so "coca cola" finds The Coca-Cola Company.
  const nameQ = searchableText(q);
  const capped = Math.min(50, Math.max(1, limit));

  const rs = await db.execute({
    sql: `SELECT symbol, name, exchange,
                 CASE
                   WHEN LOWER(symbol) = ?           THEN 100
                   WHEN LOWER(symbol) LIKE ? THEN 90
                   WHEN name_search LIKE ?    THEN 80
                   WHEN name_search LIKE ?    THEN 70
                   ELSE 60
                 END AS rank
          FROM symbols
          WHERE COALESCE(tradable, 1) = 1
            AND (LOWER(symbol) LIKE ? OR name_search LIKE ?)
          ORDER BY rank DESC,
                   CASE WHEN exchange IN (${PREFERRED_SQL}) THEN 0 ELSE 1 END,
                   LENGTH(symbol),
                   symbol
          LIMIT ?`,
    args: [
      lower,          // exact symbol
      `${lower}%`,    // symbol prefix
      `${nameQ}%`,    // name starts with
      `% ${nameQ}%`,  // a word in the name starts with it
      `${lower}%`,    // (filter) symbol prefix
      `%${nameQ}%`,   // (filter) name contains
      capped,
    ],
  });

  return rs.rows.map((r) => ({
    symbol: String(r.symbol),
    name: String(r.name),
    exchange: r.exchange ? String(r.exchange) : undefined,
    rank: Number(r.rank),
  }));
}

/** Freshness of the directory, for the CLI and the sync decision. */
export async function directoryAge(db: Client): Promise<{ count: number; newest?: string }> {
  const rs = await db.execute("SELECT COUNT(*) AS n, MAX(updated_at) AS newest FROM symbols");
  const row = rs.rows[0];
  return {
    count: Number(row?.n ?? 0),
    newest: row?.newest ? String(row.newest) : undefined,
  };
}

