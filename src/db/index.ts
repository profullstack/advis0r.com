/**
 * Database access via @libsql/client.
 *
 * Works with both a local embedded SQLite file (DATABASE_URL=file:./...)
 * and a remote Turso database (DATABASE_URL=libsql://...). FTS5 is available
 * in both modes.
 */
import { createClient, type Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));

let client: Client | null = null;

export function getDb(config: AppConfig): Client {
  if (client) return client;
  const url = config.databaseUrl;
  const authToken = config.databaseAuthToken || undefined;
  client = createClient({ url, authToken });
  return client;
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
 */
export async function migrate(db: Client): Promise<void> {
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  const statements = splitSqlStatements(schema);
  const indexes = statements.filter((s) => /^CREATE\s+INDEX/i.test(s));
  const rest = statements.filter((s) => !/^CREATE\s+INDEX/i.test(s));

  await db.batch(rest, "write");
  await ensureColumns(db);
  if (indexes.length) await db.batch(indexes, "write");
}

/** Idempotently add any missing columns listed in ADDED_COLUMNS. */
export async function ensureColumns(db: Client): Promise<string[]> {
  const applied: string[] = [];
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    let existing: Set<string>;
    try {
      const info = await db.execute(`PRAGMA table_info(${table})`);
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
