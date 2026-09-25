/**
 * Full-text search over transcript segments on either database.
 *
 * SQLite (local `file:` databases, tests) keeps the FTS5 virtual table from
 * schema.sql. Postgres (production, via @profullstack/libsql-pg) has a plain
 * `segments_fts` table with a generated tsvector column `search` and a GIN
 * index (schema.pg.sql). Inserts are the same on both; only the predicate
 * differs, and every query site builds it here.
 */
import type { Client } from "@libsql/client";

/** True when the client talks to Postgres through @profullstack/libsql-pg. */
export function isPostgres(db: Client): boolean {
  return (db as { protocol?: string }).protocol === "postgres";
}

/**
 * The alphanumeric tokens of a free-text query, lowercased. One-letter words
 * are dropped unless they are digits, so "a" and "i" do not match everything.
 */
export function searchTokens(raw: string): string[] {
  return (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2 || /\d/.test(t));
}

/**
 * A WHERE fragment and its one argument matching segments against free text,
 * every token required and prefix-matched (typeahead-style). Null when the
 * text has no usable tokens.
 *
 * - SQLite: `segments_fts MATCH '"tok"* "tok2"*'` — each token quoted so
 *   hyphens, colons and FTS5 operators in user input cannot break the parser.
 * - Postgres: `search @@ to_tsquery('english', 'tok:* & tok2:*')` — tokens are
 *   alphanumeric already, so no tsquery operator can slip in.
 */
export function segmentsMatch(db: Client, raw: string): { where: string; arg: string } | null {
  const tokens = searchTokens(raw);
  if (!tokens.length) return null;
  if (isPostgres(db)) {
    return { where: "search @@ to_tsquery('english', ?)", arg: tokens.map((t) => `${t}:*`).join(" & ") };
  }
  return { where: "segments_fts MATCH ?", arg: tokens.map((t) => `"${t}"*`).join(" ") };
}
