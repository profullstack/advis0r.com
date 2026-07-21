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

/** Apply the schema. Safe to run repeatedly (all statements are IF NOT EXISTS). */
export async function migrate(db: Client): Promise<void> {
  const schema = readFileSync(join(__dirname, "schema.sql"), "utf8");
  const statements = splitSqlStatements(schema);
  await db.batch(statements, "write");
}

/**
 * Split a SQL script into individual statements on `;` boundaries.
 * The schema intentionally avoids semicolons inside statements (no triggers
 * with BEGIN...END), so a simple splitter is sufficient and predictable.
 */
function splitSqlStatements(sql: string): string[] {
  return sql
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith("--"));
}

export function closeDb(): void {
  client?.close();
  client = null;
}
