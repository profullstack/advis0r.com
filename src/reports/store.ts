/**
 * Persisted ticker reports.
 *
 * A "report" is the whole rendered view of a ticker — quote, technicals,
 * fundamentals, signals, grouped sources and the analysis — captured at a point
 * in time. Before this existed every view recomputed all of it: daily bars from
 * Alpaca or Yahoo, company facts from SEC EDGAR, the evidence build and the
 * offline analysis. That is seconds of latency and a fistful of third-party
 * requests to redisplay something that had not changed.
 *
 * So the snapshot is stored and served verbatim thereafter. Two consequences are
 * deliberate and shape everything below:
 *
 *   - **A report never refreshes itself.** Serving a snapshot is the entire
 *     point; silently rebuilding on a cache age would reintroduce the cost this
 *     removes. It is rebuilt only when it does not exist, or when someone asks.
 *   - **Therefore it must say when it was taken.** Every surface that shows a
 *     report shows `generatedAt`. A stale price presented as current is a bug;
 *     a stale price labelled with its timestamp is a snapshot.
 *
 * The hot columns are denormalized out of the payload so the index page and the
 * sitemap can list hundreds of reports without parsing hundreds of JSON blobs.
 */
import type { Client } from "@libsql/client";

/** Ticker symbols are 1-5 letters, optionally a class suffix (e.g. BRK.B). */
const TICKER_RE = /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/;

/**
 * Validate and canonicalize a symbol from a URL path or request body.
 *
 * Everything downstream — the SQL lookup, the page title, the canonical URL —
 * uses the result, so anything that is not a plausible ticker is rejected here
 * rather than sanitized later.
 */
export function normalizeSymbol(raw: unknown): string | null {
  const t = String(raw ?? "").trim().toUpperCase();
  return TICKER_RE.test(t) ? t : null;
}

/** What a report page and the modal both render. Shape of `/api/ticker`. */
export type ReportPayload = Record<string, unknown>;

export interface StoredReport {
  ticker: string;
  payload: ReportPayload;
  /** When this snapshot's data was captured. Moves on every regeneration. */
  generatedAt: string;
  /** When the ticker was first reported on. Never moves — "covered since". */
  firstGeneratedAt: string;
}

/** Row-level summary for the index page and sitemap — no payload parsing. */
export interface ReportSummary {
  ticker: string;
  companyName?: string;
  lastPrice?: number;
  overallScore?: number;
  confidence?: number;
  classification?: string;
  aiProvider?: string;
  aiModel?: string;
  sourceCount: number;
  signalCount: number;
  generatedAt: string;
}

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return v == null || Number.isNaN(n) ? undefined : n;
};

const str = (v: unknown): string | undefined => (v == null ? undefined : String(v));

/**
 * Store (or replace) a ticker's report.
 *
 * One row per ticker: the current snapshot. The generation history lives in
 * `analyses`, which is already append-only, so nothing is lost by overwriting
 * here — and keeping every snapshot of a payload this size would grow without
 * bound for no reader.
 */
export async function saveReport(
  db: Client,
  ticker: string,
  payload: ReportPayload,
  opts: { generatedBy?: string } = {},
): Promise<StoredReport> {
  const now = new Date().toISOString();
  const ai = payload.aiAnalysis as Record<string, unknown> | undefined;

  await db.execute({
    sql: `INSERT INTO reports
            (ticker, payload_json, company_name, last_price, overall_score, confidence,
             classification, ai_provider, ai_model, ai_generated_at, source_count,
             signal_count, generated_at, first_generated_at, generated_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(ticker) DO UPDATE SET
            payload_json = excluded.payload_json,
            company_name = excluded.company_name,
            last_price = excluded.last_price,
            overall_score = excluded.overall_score,
            confidence = excluded.confidence,
            classification = excluded.classification,
            ai_provider = excluded.ai_provider,
            ai_model = excluded.ai_model,
            ai_generated_at = excluded.ai_generated_at,
            source_count = excluded.source_count,
            signal_count = excluded.signal_count,
            generated_at = excluded.generated_at,
            generated_by = excluded.generated_by`,
    // first_generated_at is absent from the UPDATE list on purpose: a
    // regeneration replaces the snapshot but must not rewrite when coverage began.
    args: [
      ticker,
      JSON.stringify(payload),
      str(payload.companyName) ?? null,
      num(payload.lastPrice) ?? null,
      num(payload.overallScore) ?? null,
      num(payload.confidence) ?? null,
      str(payload.classification) ?? null,
      ai ? str(ai.provider) ?? null : null,
      ai ? str(ai.model) ?? null : null,
      ai ? str(ai.createdAt) ?? null : null,
      Array.isArray(payload.sources) ? payload.sources.length : 0,
      Array.isArray(payload.signals) ? payload.signals.length : 0,
      now,
      now,
      opts.generatedBy ?? null,
    ],
  });

  const stored = await loadReport(db, ticker);
  return stored ?? { ticker, payload, generatedAt: now, firstGeneratedAt: now };
}

export async function loadReport(db: Client, ticker: string): Promise<StoredReport | null> {
  const rs = await db.execute({
    sql: "SELECT ticker, payload_json, generated_at, first_generated_at FROM reports WHERE ticker = ?",
    args: [ticker],
  });
  const row = rs.rows[0];
  if (!row) return null;
  try {
    return {
      ticker: String(row.ticker),
      payload: JSON.parse(String(row.payload_json)) as ReportPayload,
      generatedAt: String(row.generated_at),
      firstGeneratedAt: String(row.first_generated_at ?? row.generated_at),
    };
  } catch {
    // A corrupt payload must not 500 the page; the caller rebuilds instead.
    return null;
  }
}

function toSummary(row: Record<string, unknown>): ReportSummary {
  return {
    ticker: String(row.ticker),
    companyName: str(row.company_name),
    lastPrice: num(row.last_price),
    overallScore: num(row.overall_score),
    confidence: num(row.confidence),
    classification: str(row.classification),
    aiProvider: str(row.ai_provider),
    aiModel: str(row.ai_model),
    sourceCount: Number(row.source_count ?? 0),
    signalCount: Number(row.signal_count ?? 0),
    generatedAt: String(row.generated_at),
  };
}

export type ReportSort = "recent" | "score" | "ticker";

const ORDER_BY: Record<ReportSort, string> = {
  recent: "generated_at DESC",
  // NULLs last: an unscored report should not head a list sorted by score.
  score: "overall_score IS NULL, overall_score DESC, generated_at DESC",
  ticker: "ticker ASC",
};

export async function listReports(
  db: Client,
  opts: { limit?: number; offset?: number; sort?: ReportSort } = {},
): Promise<ReportSummary[]> {
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const rs = await db.execute({
    sql: `SELECT ticker, company_name, last_price, overall_score, confidence, classification,
                 ai_provider, ai_model, source_count, signal_count, generated_at
          FROM reports ORDER BY ${ORDER_BY[opts.sort ?? "recent"]} LIMIT ? OFFSET ?`,
    args: [limit, Math.max(0, opts.offset ?? 0)],
  });
  return rs.rows.map((r) => toSummary(r as Record<string, unknown>));
}

export async function countReports(db: Client): Promise<number> {
  const rs = await db.execute("SELECT COUNT(*) AS n FROM reports");
  return Number(rs.rows[0]?.n ?? 0);
}

/** Every ticker with a stored report, oldest generation first — for the sitemap. */
export async function allReportRefs(
  db: Client,
): Promise<Array<{ ticker: string; generatedAt: string }>> {
  const rs = await db.execute(
    "SELECT ticker, generated_at FROM reports ORDER BY ticker ASC LIMIT 50000",
  );
  return rs.rows.map((r) => ({ ticker: String(r.ticker), generatedAt: String(r.generated_at) }));
}
