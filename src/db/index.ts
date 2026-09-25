/**
 * Database access.
 *
 * Production runs on Postgres (DATABASE_URL=postgres://...) through
 * @profullstack/libsql-pg, which keeps the @libsql/client surface this code was
 * written against (execute / batch / transaction) and rewrites the remaining
 * SQLite idioms per statement. Local development and the tests use an embedded
 * libSQL file (DATABASE_URL=file:./...). Turso (libsql://) is no longer read:
 * the data moved to Postgres in 2026-09.
 */
import type { Client } from "@libsql/client";
import { createClient as createPostgresClient } from "@profullstack/libsql-pg";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config.ts";
import { isPostgres } from "./fts.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);

const POSTGRES_URL = /^postgres(ql)?:\/\//i;

let client: Client | null = null;
/** The URL each Postgres client was opened with; migrate() needs it for a second, DDL-only client. */
const openedWith = new WeakMap<object, string>();

export function getDb(config: AppConfig): Client {
  if (client) return client;
  client = openClient(config.databaseUrl, config.databaseAuthToken || undefined);
  return client;
}

/**
 * Open the database named by DATABASE_URL.
 *
 * - `postgres://` (production): @profullstack/libsql-pg over a pg pool.
 * - `file:` (local, tests): @libsql/client, a devDependency loaded lazily so
 *   the production image carries neither it nor its native binding.
 * - anything else, `libsql://` included, is a configuration error and fails
 *   here rather than writing to the wrong place.
 */
export function openClient(url: string, authToken?: string): Client {
  if (POSTGRES_URL.test(url)) {
    const pg = createPostgresClient({ url }) as unknown as Client;
    openedWith.set(pg, url);
    return pg;
  }
  if (url.startsWith("file:")) {
    const { createClient } = require_("@libsql/client") as typeof import("@libsql/client");
    return createClient({ url, authToken });
  }
  const scheme = url.split(":")[0];
  throw new Error(
    `DATABASE_URL must be a postgres:// URL (production) or a file: path (local); got "${scheme}:". ` +
      "Turso/libsql:// is no longer supported: the data lives in Postgres now.",
  );
}

/**
 * Columns added after the initial schema shipped (PRD v3). `CREATE TABLE IF NOT
 * EXISTS` is a no-op on databases that already have the table, so existing
 * deployments need explicit `ALTER TABLE ... ADD COLUMN` to gain new columns.
 */
const ADDED_COLUMNS: Record<string, Record<string, string>> = {
  documents: {
    publisher: "TEXT",
    source_tier: "INTEGER",
    paywalled: "INTEGER DEFAULT 0",
    media_url: "TEXT",
    media_type: "TEXT",
    duration_ms: "INTEGER",
    provenance: "TEXT",
    asr_model: "TEXT",
    asr_version: "TEXT",
  },
  signals: {
    source_tier: "INTEGER",
    is_boilerplate: "INTEGER DEFAULT 0",
    boilerplate_reasons: "TEXT",
    speaker_confidence: "REAL",
    start_ms: "INTEGER",
    provenance: "TEXT",
  },
  // Watchlist email digests. Existing accounts inherit the 'daily' default, so
  // the feature is opt-out rather than opt-in — but delivery is still gated on a
  // verified address and a non-empty watchlist.
  users: {
    digest_frequency: "TEXT NOT NULL DEFAULT 'daily'",
    digest_last_sent_at: "TEXT",
    digest_unsub_token: "TEXT",
  },
};

/**
 * Apply the schema. Safe to run repeatedly.
 *
 * Order matters: tables first, then additive column migrations, then indexes —
 * an index may reference a column that only exists after the ALTER pass.
 *
 * Postgres reads schema.pg.sql, already in its own dialect, through a second
 * client that sends SQL as-is (`dialect: 'postgres'`), so the statement
 * rewriter never touches DDL that is not SQLite's. SQLite reads schema.sql.
 */
export async function migrate(db: Client): Promise<void> {
  const postgres = isPostgres(db);
  const schema = readFileSync(join(__dirname, postgres ? "schema.pg.sql" : "schema.sql"), "utf8");
  const statements = splitSqlStatements(schema);
  const indexes = statements.filter((s) => /^CREATE\s+INDEX/i.test(s));
  const rest = statements.filter((s) => !/^CREATE\s+INDEX/i.test(s));

  const ddl = postgres ? createPostgresClient({ url: openedWith.get(db)!, dialect: "postgres", pool: { max: 1 } }) : db;
  try {
    await (ddl as Client).batch(rest, "write");
    await ensureColumns(db);
    if (indexes.length) await (ddl as Client).batch(indexes, "write");
  } finally {
    if (ddl !== db) (ddl as Client).close();
  }
}

/** Idempotently add any missing columns listed in ADDED_COLUMNS. */
export async function ensureColumns(db: Client): Promise<string[]> {
  const applied: string[] = [];
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    let existing: Set<string>;
    try {
      // Postgres has no PRAGMA (libsql-pg answers it with no rows); ask the catalogue.
      const info = isPostgres(db)
        ? await db.execute({
            sql: "SELECT column_name AS name FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = ?",
            args: [table],
          })
        : await db.execute(`PRAGMA table_info(${table})`);
      existing = new Set(info.rows.map((r) => String(r.name)));
    } catch {
      continue; // table does not exist yet; the CREATE pass will handle it
    }
    if (existing.size === 0) continue;
    for (const [column, type] of Object.entries(columns)) {
      if (existing.has(column)) continue;
      await db.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      applied.push(`${table}.${column}`);
    }
  }
  return applied;
}

/**
 * Split a SQL script into individual statements on `;` boundaries.
 * The schema intentionally avoids semicolons inside statements (no triggers
 * with BEGIN...END), so a simple splitter is sufficient and predictable.
 */
function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    // Strip full-line `--` comments so a statement preceded by a comment (e.g.
    // the FTS5 virtual table or the indexes) is not dropped along with it.
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !line.trim().startsWith("--"))
        .join("\n")
        .trim(),
    )
    .filter((s) => s.length > 0);
}

export function closeDb(): void {
  client?.close();
  client = null;
}
