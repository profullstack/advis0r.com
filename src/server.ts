#!/usr/bin/env bun
/**
 * Minimal HTTP surface for hosted deployment (PRD §28 Phase 3 REST API seed).
 *
 * The primary interface is the `transcripts` CLI; this server exists so the
 * project can run as a long-lived Railway service with a health check and a
 * read-only research API over the already-indexed data. It performs NO
 * unauthenticated write/crawl work.
 *
 * Endpoints:
 *   GET /health                      -> liveness probe
 *   GET /                            -> service info + disclaimer
 *   GET /api/search?q=...&limit=..   -> FTS over indexed transcript segments
 *   GET /api/signals?ticker=..       -> extracted signals for a ticker
 *   GET /api/stats                   -> index coverage counts
 */
import { loadConfig } from "./config.ts";
import { getDb, migrate } from "./db/index.ts";
import { DISCLAIMER } from "./compliance.ts";

const config = loadConfig();
const db = getDb(config);
await migrate(db);

const port = Number(process.env.PORT ?? 8080);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return json({ ok: true });

      if (url.pathname === "/") {
        return json({
          name: "advis0r.com",
          description:
            "Executive-transcript stock discovery. Primary interface is the `transcripts` CLI; this is a read-only research API.",
          endpoints: ["/health", "/api/search?q=", "/api/signals?ticker=", "/api/stats"],
          disclaimer: DISCLAIMER,
        });
      }

      if (url.pathname === "/api/stats") {
        const out: Record<string, number> = {};
        for (const t of ["documents", "transcripts", "signals", "analyses", "market_bars"]) {
          const rs = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
          out[t] = Number(rs.rows[0]?.n ?? 0);
        }
        return json(out);
      }

      if (url.pathname === "/api/search") {
        const q = url.searchParams.get("q");
        if (!q) return json({ error: "missing ?q=" }, 400);
        const limit = Math.min(50, Number(url.searchParams.get("limit") ?? 20) || 20);
        const rs = await db.execute({
          sql: `SELECT text, speaker, ticker, event_date FROM segments_fts
                WHERE segments_fts MATCH ? LIMIT ?`,
          args: [q, limit],
        });
        return json({ query: q, results: rs.rows });
      }

      if (url.pathname === "/api/signals") {
        const ticker = url.searchParams.get("ticker");
        if (!ticker) return json({ error: "missing ?ticker=" }, 400);
        const rs = await db.execute({
          sql: `SELECT ticker, signal_type, direction, strength, specificity, quote,
                       event_date, source_url FROM signals WHERE ticker = ?
                ORDER BY event_date DESC LIMIT 200`,
          args: [ticker.toUpperCase()],
        });
        return json({ ticker: ticker.toUpperCase(), signals: rs.rows, disclaimer: DISCLAIMER });
      }

      return json({ error: "not found" }, 404);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
});

console.log(`advis0r.com server listening on :${server.port}`);
