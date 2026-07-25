/**
 * On-demand news top-up for a single ticker (PRD v3 §3).
 *
 * News ingestion used to be reachable only from `transcripts news <tickers>`,
 * so the web app showed news for whichever tickers someone had run the CLI
 * against — two of them, in production — and "Sharpen with AI" reasoned over
 * whatever happened to be in the database. This module closes that gap: the
 * analyze path refreshes coverage for the ticker being analyzed, immediately
 * before the model call, so the evidence is current at the moment it is used.
 *
 * Three properties keep it safe on an interactive request:
 *
 *   - **Keyless by default.** Discovery uses RSS only; ValueSERP is opt-in
 *     (`useValueSerp`) so an interactive click never spends search credits.
 *   - **Freshness-gated.** A ticker refreshed within `maxAgeHours` is skipped,
 *     so repeated analyses of the same ticker cost nothing.
 *   - **Deadlined.** The caller gets control back after `deadlineMs` whatever
 *     the feeds are doing. Ingestion that overruns keeps running and its
 *     documents land for next time; it just stops holding up this analysis.
 */
import type { Client } from "@libsql/client";
import type { AppConfig } from "../config.ts";
import { NewsProvider } from "../providers/news/index.ts";
import { ingest } from "./ingest.ts";

export interface NewsRefreshOptions {
  /** Skip the refresh when this ticker already has news newer than this. */
  maxAgeHours?: number;
  /** Articles to ingest per run. */
  perTicker?: number;
  /** Give up waiting (not: cancel) after this long. */
  deadlineMs?: number;
  /** Spend ValueSERP credits on discovery. Off: RSS is keyless. */
  useValueSerp?: boolean;
  /** Only consider articles published on/after this ISO date. */
  from?: string;
  onProgress?: (message: string) => void;
}

export interface NewsRefreshResult {
  ticker: string;
  /** False when the freshness gate short-circuited the run. */
  ran: boolean;
  /** True when the deadline fired before ingestion finished. */
  timedOut: boolean;
  documents: number;
  signals: number;
  /** Articles already in the index for this ticker, after the run. */
  known: number;
  error?: string;
}

const HOUR_MS = 3_600_000;

/** Most recent news fetch for a ticker, and how many articles it has. */
async function newsState(db: Client, ticker: string): Promise<{ latest?: string; count: number }> {
  const rs = await db.execute({
    sql: `SELECT MAX(d.fetched_at) AS latest, COUNT(*) AS n
          FROM documents d JOIN transcripts t ON t.document_id = d.id
          WHERE d.provider_id = 'news' AND t.primary_ticker = ?`,
    args: [ticker],
  });
  const row = rs.rows[0];
  return { latest: row?.latest ? String(row.latest) : undefined, count: Number(row?.n ?? 0) };
}

/** Company name for a ticker, which makes the news query far more precise. */
export async function companyNameFor(db: Client, ticker: string): Promise<string | undefined> {
  const rs = await db.execute({
    sql: `SELECT d.meta_json AS meta FROM transcripts t JOIN documents d ON d.id = t.document_id
          WHERE t.primary_ticker = ? AND d.meta_json IS NOT NULL
          ORDER BY d.created_at DESC LIMIT 20`,
    args: [ticker],
  });
  for (const row of rs.rows) {
    try {
      const meta = JSON.parse(String(row.meta ?? "{}"));
      if (meta.companyName) return String(meta.companyName);
    } catch {
      /* malformed meta is not fatal */
    }
  }
  return undefined;
}

export async function refreshTickerNews(
  db: Client,
  config: AppConfig,
  rawTicker: string,
  opts: NewsRefreshOptions = {},
): Promise<NewsRefreshResult> {
  const ticker = rawTicker.toUpperCase();
  const maxAgeHours = opts.maxAgeHours ?? 6;
  const deadlineMs = opts.deadlineMs ?? 25_000;
  const base: NewsRefreshResult = {
    ticker, ran: false, timedOut: false, documents: 0, signals: 0, known: 0,
  };

  const state = await newsState(db, ticker);
  base.known = state.count;
  if (state.latest && Date.now() - Date.parse(state.latest) < maxAgeHours * HOUR_MS) {
    opts.onProgress?.(`News for ${ticker} is current (${state.count} article(s) indexed)`);
    return base;
  }

  const provider = new NewsProvider({
    downloadsDir: config.downloadsDir,
    // Deliberately blank unless asked: RSS discovery is free, ValueSERP is not,
    // and this runs on a user-facing click.
    valueSerpKey: opts.useValueSerp ? config.secrets.valueSerpApiKey : "",
    perTicker: opts.perTicker ?? 8,
  });
  const name = await companyNameFor(db, ticker);
  if (name) provider.setCompanyNames(new Map([[ticker, name]]));

  opts.onProgress?.(`Searching news for ${name ? `${name} (${ticker})` : ticker}`);

  // Default window: a quarter of coverage is what a 1-2 quarter horizon needs.
  const from = opts.from ?? new Date(Date.now() - 90 * 86_400_000).toISOString().slice(0, 10);

  const run = ingest(
    db,
    config,
    [provider],
    { topic: "news", tickers: [ticker], from },
    (msg) => opts.onProgress?.(msg),
  );

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), deadlineMs);
  });

  try {
    const outcome = await Promise.race([run, deadline]);
    if (outcome === "timeout") {
      // The ingest keeps going and its rows land for the next analysis; we just
      // stop blocking this one. Swallow its eventual rejection so an unhandled
      // promise cannot take the process down.
      void run.catch(() => {});
      opts.onProgress?.(`News search still running after ${Math.round(deadlineMs / 1000)}s — continuing without it`);
      return { ...base, ran: true, timedOut: true };
    }
    const after = await newsState(db, ticker);
    opts.onProgress?.(
      outcome.documents
        ? `Indexed ${outcome.documents} new article(s), ${outcome.signals} signal(s)`
        : `No new articles for ${ticker} (${after.count} already indexed)`,
    );
    return {
      ...base,
      ran: true,
      documents: outcome.documents,
      signals: outcome.signals,
      known: after.count,
      error: outcome.errors[0],
    };
  } catch (err) {
    // News is an enrichment, never a precondition: a dead feed must not fail
    // an analysis the user has already been charged for.
    const error = String(err).slice(0, 300);
    opts.onProgress?.(`News refresh failed: ${error}`);
    return { ...base, ran: true, error };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
