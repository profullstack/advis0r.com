/**
 * Report routes.
 *
 *   GET  /ticker/<SYMBOL>        -> server-rendered report page (public)
 *   GET  /reports?sort=          -> index of every stored report (public)
 *   GET  /sitemap.xml            -> report URLs for crawlers
 *   GET  /robots.txt             -> points at the sitemap
 *   GET  /api/reports?limit=     -> the index as JSON
 *   POST /api/report/regenerate  -> rebuild one snapshot (watchlist members only)
 *
 * Reading a report is public and free. Writing one is not: a rebuild spends
 * third-party quota (Alpaca/Yahoo bars, SEC EDGAR) and CPU, so regeneration is
 * restricted to signed-in users acting on a ticker they actually watch, and
 * throttled on top of that. The check is here rather than only in the UI — the
 * button is a courtesy, this is the control.
 */
import type { Client } from "@libsql/client";
import { rateLimit } from "../auth/service.ts";
import { guardResponse, requireUser } from "../auth/routes.ts";
import {
  renderMissingReportPage,
  renderReportIndex,
  renderReportPage,
  renderSitemap,
} from "./page.ts";
import {
  allReportRefs,
  countReports,
  listReports,
  loadReport,
  normalizeSymbol,
  saveReport,
  type ReportPayload,
  type ReportSort,
} from "./store.ts";

/** Rebuilds are expensive and hit third parties; cap them per account. */
export const REGENERATE_LIMIT = { max: 30, windowMinutes: 60 };

export interface ReportRouteDeps {
  db: Client;
  appUrl: string;
  /** Recompute a ticker's full payload from live sources. Owned by the server. */
  buildReport: (symbol: string) => Promise<ReportPayload>;
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const html = (body: string, status = 200, cacheSeconds = 0) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Stored snapshots are safe to cache briefly at the edge; a regeneration
      // is a deliberate act, so a short window cannot hide a fresh report for long.
      "cache-control": cacheSeconds
        ? `public, max-age=${cacheSeconds}, stale-while-revalidate=${cacheSeconds * 4}`
        : "no-store",
    },
  });

/** Whether this ticker is on the signed-in user's watchlist. */
export async function isWatching(db: Client, userId: string, ticker: string): Promise<boolean> {
  const rs = await db.execute({
    sql: "SELECT 1 FROM watchlist_items WHERE user_id = ? AND ticker = ? LIMIT 1",
    args: [userId, ticker],
  });
  return rs.rows.length > 0;
}

export async function handleReportRoute(
  req: Request,
  path: string,
  deps: ReportRouteDeps,
): Promise<Response | null> {
  const url = new URL(req.url);

  if (path === "/sitemap.xml") {
    return new Response(renderSitemap(await allReportRefs(deps.db), deps.appUrl), {
      headers: { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  }

  if (path === "/robots.txt") {
    const base = deps.appUrl.replace(/\/$/, "");
    return new Response(`User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml\n`, {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" },
    });
  }

  if (path === "/reports" || path === "/reports/") {
    const sort = (["recent", "score", "ticker"] as const).includes(url.searchParams.get("sort") as ReportSort)
      ? (url.searchParams.get("sort") as ReportSort)
      : "recent";
    const [reports, total] = await Promise.all([
      listReports(deps.db, { sort, limit: 200 }),
      countReports(deps.db),
    ]);
    return html(renderReportIndex(reports, { appUrl: deps.appUrl, total, sort }), 200, 300);
  }

  if (path === "/api/reports") {
    const limit = Math.min(500, Number(url.searchParams.get("limit") ?? 100) || 100);
    const sort = (url.searchParams.get("sort") ?? "recent") as ReportSort;
    return json({
      total: await countReports(deps.db),
      reports: await listReports(deps.db, {
        limit,
        sort: (["recent", "score", "ticker"] as const).includes(sort) ? sort : "recent",
      }),
    });
  }

  if (path.startsWith("/ticker/")) {
    const raw = decodeURIComponent(path.slice("/ticker/".length)).replace(/\/$/, "");
    const symbol = normalizeSymbol(raw);
    if (!symbol) {
      return html(
        renderMissingReportPage(raw.slice(0, 12) || "—", { appUrl: deps.appUrl }),
        404,
      );
    }
    // Canonicalize case so /ticker/nvda and /ticker/NVDA are not two pages.
    if (raw !== symbol) {
      return Response.redirect(`${deps.appUrl.replace(/\/$/, "")}/ticker/${symbol}`, 301);
    }
    const report = await loadReport(deps.db, symbol);
    return report
      ? html(renderReportPage(report, { appUrl: deps.appUrl }), 200, 300)
      : html(renderMissingReportPage(symbol, { appUrl: deps.appUrl }), 404);
  }

  if (path === "/api/report/regenerate") {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    return regenerate(req, deps);
  }

  return null;
}

async function regenerate(req: Request, deps: ReportRouteDeps): Promise<Response> {
  let body: Record<string, unknown> = {};
  try {
    body = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const symbol = normalizeSymbol(body.ticker ?? body.symbol);
  if (!symbol) return json({ error: "Enter a valid ticker symbol." }, 400);

  const guard = await requireUser(req, deps.db);
  if (guard.failure) {
    return guardResponse({
      ...guard.failure,
      body: { ...guard.failure.body, error: "Sign in to regenerate a report." },
    });
  }
  const user = guard.user!;

  // The gate the user asked for: you can refresh reports for the tickers you
  // follow. Everyone else reads the stored snapshot.
  if (!(await isWatching(deps.db, user.id, symbol))) {
    return json(
      {
        error: `Add ${symbol} to your watchlist to regenerate its report.`,
        watchlistRequired: true,
        ticker: symbol,
      },
      403,
    );
  }

  const limit = await rateLimit(deps.db, `regen:${user.id}`, REGENERATE_LIMIT);
  if (!limit.allowed) {
    return json(
      { error: `Too many regenerations. Try again in ${limit.retryAfterMinutes} minutes.` },
      429,
    );
  }

  try {
    const payload = await deps.buildReport(symbol);
    const stored = await saveReport(deps.db, symbol, payload, { generatedBy: user.id });
    return json({
      ok: true,
      ticker: symbol,
      cached: false,
      reportGeneratedAt: stored.generatedAt,
      reportFirstGeneratedAt: stored.firstGeneratedAt,
      ...stored.payload,
    });
  } catch (err) {
    return json({ error: `Could not rebuild ${symbol}: ${String(err).slice(0, 200)}` }, 502);
  }
}
