/**
 * Customer webhooks (@profullstack/webhooks).
 *
 * An account registers https endpoints under /api/v1/webhooks (or the
 * Webhooks panel on the Watchlist tab) and gets a CloudEvents POST, signed per
 * Standard Webhooks, when something it cares about happens:
 *
 *   report.generated    a stored report was (re)built for a ticker you watch
 *   signal.extracted    a new non-boilerplate signal was indexed for a ticker you watch
 *   analysis.completed  the AI analysis you ran (and paid a credit for) finished
 *   analysis.failed     it did not, and the credit was refunded
 *
 * Payloads are summaries plus a link (ticker, kind, score, url), never the full
 * report or analysis text: the link is where the content lives.
 *
 * The outbox lives in the app database: Postgres in production through its own
 * small Bun SQL pool on DATABASE_URL (the same arrangement as the credit-code
 * packages, src/credits/codes.ts), bun:sqlite on a local file database, memory
 * otherwise. The server sets the hub once at boot (setHub) and starts its
 * drain loop; every other caller just emits, which is a no-op when no hub is set
 * (the CLI, tests that do not care).
 */
import type { Client } from "@libsql/client";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import {
  Webhooks,
  memoryStore,
  postgresStore,
  sqliteStore,
  type WebhookStore,
  type WebhooksOptions,
} from "@profullstack/webhooks";
import { databaseUrlOf } from "../db/index.ts";

export const EVENT_TYPES = [
  "report.generated",
  "signal.extracted",
  "analysis.completed",
  "analysis.failed",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/** Signals one document can announce. A long transcript can yield dozens; the link carries the rest. */
export const MAX_SIGNALS_PER_DOCUMENT = 10;

/** The store for this database (see the header). */
export async function storeFor(db: Client): Promise<WebhookStore> {
  const url = databaseUrlOf(db);
  if (url && /^postgres(ql)?:\/\//i.test(url)) {
    const sql = new SQL(url, { max: 3 });
    const pool = {
      async query(text: string, params: unknown[] = []) {
        return { rows: (await sql.unsafe(text, params as never[])) as Record<string, unknown>[] };
      },
    };
    const store = postgresStore(pool, { migrate: true });
    await store.ready;
    return store;
  }
  if (url?.startsWith("file:")) {
    const file = new Database(url.slice("file:".length).split("?")[0]!);
    file.exec("PRAGMA busy_timeout = 5000");
    return sqliteStore(file);
  }
  return memoryStore();
}

export function createHub(
  store: WebhookStore,
  appUrl: string,
  extra: Partial<WebhooksOptions> = {},
): Webhooks {
  return new Webhooks({
    store,
    source: appUrl.replace(/\/+$/, ""),
    eventTypes: [...EVENT_TYPES],
    log: (m) => console.log(`[webhooks] ${m}`),
    ...extra,
  });
}

let hub: Webhooks | null = null;
let siteUrl = "https://advis0r.com";

/** The server's hub, once set. */
export function getHub(): Webhooks | null {
  return hub;
}

/** Set (or clear, with null) the hub every emit goes through. */
export function setHub(h: Webhooks | null, appUrl?: string): void {
  hub = h;
  if (appUrl) siteUrl = appUrl.replace(/\/+$/, "");
}

/** Where a ticker's report lives. */
export function reportUrl(ticker: string): string {
  return `${siteUrl}/stocks/${encodeURIComponent(ticker)}`;
}

/** Queue one event for one account. Never throws: a webhook must not fail the work that caused it. */
export async function emitTo(
  owner: string,
  type: EventType,
  data: Record<string, unknown>,
  subject?: string,
): Promise<number> {
  if (!hub) return 0;
  try {
    const r = await hub.emit(owner, type, data, subject ? { subject } : {});
    return r.queued;
  } catch (err) {
    console.error(`[webhooks] emit ${type} for ${owner} failed: ${String(err).slice(0, 200)}`);
    return 0;
  }
}

/** Accounts with this ticker on their watchlist. */
export async function watchersOf(db: Client, ticker: string): Promise<string[]> {
  const rs = await db.execute({
    sql: "SELECT DISTINCT user_id FROM watchlist_items WHERE ticker = ?",
    args: [ticker.toUpperCase()],
  });
  return rs.rows.map((r) => String(r.user_id));
}

/** Queue an event for everyone watching `ticker`. */
export async function emitToWatchers(
  db: Client,
  ticker: string,
  type: EventType,
  data: Record<string, unknown>,
  subject?: string,
): Promise<number> {
  if (!hub) return 0;
  let owners: string[];
  try {
    owners = await watchersOf(db, ticker);
  } catch (err) {
    console.error(`[webhooks] watchers of ${ticker}: ${String(err).slice(0, 200)}`);
    return 0;
  }
  let queued = 0;
  for (const owner of owners) queued += await emitTo(owner, type, data, subject);
  return queued;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return v == null || Number.isNaN(n) ? null : n;
};

/** report.generated: the summary columns saveReport denormalizes, plus the link. */
export function reportGeneratedData(
  ticker: string,
  payload: Record<string, unknown>,
  generatedAt: string,
): Record<string, unknown> {
  return {
    ticker,
    company_name: payload.companyName == null ? null : String(payload.companyName),
    overall_score: num(payload.overallScore),
    confidence: num(payload.confidence),
    classification: payload.classification == null ? null : String(payload.classification),
    last_price: num(payload.lastPrice),
    signal_count: Array.isArray(payload.signals) ? payload.signals.length : 0,
    source_count: Array.isArray(payload.sources) ? payload.sources.length : 0,
    generated_at: generatedAt,
    url: reportUrl(ticker),
  };
}

export interface SignalSummary {
  id: string;
  ticker: string;
  signalType: string;
  direction: string;
  strength: number;
  eventDate?: string | null;
  eventType?: string | null;
  speaker?: string | null;
  sourceUrl?: string | null;
}

/** signal.extracted: kind, direction, score and links; the quote stays on the site. */
export function signalExtractedData(s: SignalSummary): Record<string, unknown> {
  return {
    signal_id: s.id,
    ticker: s.ticker,
    kind: s.signalType,
    direction: s.direction,
    score: num(s.strength),
    event_type: s.eventType ?? null,
    event_date: s.eventDate ?? null,
    speaker: s.speaker ?? null,
    source_url: s.sourceUrl ?? null,
    url: reportUrl(s.ticker),
  };
}
