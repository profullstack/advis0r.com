#!/usr/bin/env bun
/**
 * HTTP surface + web dashboard for hosted deployment (PRD §28: web dashboard).
 *
 * Serves a static PWA from ./public and a read-only research API over the
 * already-indexed data. The web watchlist uses the deterministic OFFLINE
 * analyzer by default (zero external cost), so it works without any LLM keys.
 *
 * Endpoints:
 *   GET /health                          -> liveness probe
 *   GET /api/stats                       -> index coverage counts
 *   GET /api/search?q=...&limit=..       -> FTS over indexed transcript segments
 *   GET /api/signals?ticker=..           -> extracted signals for a ticker
 *   GET /api/tickers                     -> tickers present in the index
 *   GET /api/discover?topic=..&provider= -> ranked watchlist (offline by default)
 *   GET /*                               -> static assets / SPA shell
 */
import { join, normalize } from "node:path";
import { loadConfig } from "./config.ts";
import { getDb, migrate } from "./db/index.ts";
import { buildRegistry, getAiProvider } from "./registry.ts";
import { analyzeTicker } from "./pipeline/analyze.ts";
import { calculateIndicators, scoreTechnicalSetup } from "./technical/indicators.ts";
import { buildEvidence } from "./evidence/builder.ts";
import { composeScore, classifyRisk } from "./scoring/score.ts";
import { DISCLAIMER } from "./compliance.ts";
import type { IndicatorConfig, RankedCandidate } from "./types.ts";

const config = loadConfig();
const db = getDb(config);
await migrate(db);
const registry = buildRegistry(config);

const port = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = join(import.meta.dir, "..", "public");

const INDICATOR_CONFIG: IndicatorConfig = {
  movingAverages: config.technical.movingAverages,
  emaPeriods: config.technical.emaPeriods,
  rsiPeriod: config.technical.rsiPeriod,
  macd: { fast: config.technical.macdFast, slow: config.technical.macdSlow, signal: config.technical.macdSignal },
  bollinger: { period: config.technical.bollingerPeriod, stdDev: config.technical.bollingerStddev },
  atrPeriod: config.technical.atrPeriod,
  relativeVolumePeriod: config.technical.relativeVolumePeriod,
};

/** Full detail for one ticker: facts, quote, technicals, bars, signals, analysis. */
async function tickerDetail(symbol: string): Promise<Record<string, unknown>> {
  const sym = symbol.toUpperCase();
  const asOf = new Date().toISOString();
  const start = new Date(Date.now() - 400 * 86_400_000).toISOString();

  let bars: Awaited<ReturnType<typeof registry.alpaca.getBars>> = [];
  let snapshot: Awaited<ReturnType<typeof registry.alpaca.getSnapshots>>[number] | undefined;
  let asset: Awaited<ReturnType<typeof registry.alpaca.getAssets>>[number] | undefined;
  let marketError: string | undefined;
  try {
    bars = await registry.alpaca.getBars({ symbols: [sym], timeframe: "1Day", start, end: asOf });
    [snapshot] = await registry.alpaca.getSnapshots([sym]);
    [asset] = await registry.alpaca.getAssets([sym]);
  } catch (err) {
    marketError = String(err);
  }

  const facts = await registry.fundamentals.getCompanyFacts(sym, asOf);
  const lastPrice = snapshot?.latestTrade?.price ?? snapshot?.dailyBar?.close ?? bars.at(-1)?.close;
  if (facts.marketCap == null && facts.sharesOutstanding && lastPrice) {
    facts.marketCap = facts.sharesOutstanding * lastPrice;
  }

  const technical = bars.length ? calculateIndicators(bars, INDICATOR_CONFIG) : undefined;
  const technicalScore = technical ? scoreTechnicalSetup(technical, 2) : undefined;

  const evidence = await buildEvidence(db, sym, { snapshot, facts, technical });
  let analysis: unknown;
  let overallScore: number | undefined;
  let confidence: number | undefined;
  let classification: string | undefined;
  try {
    const offline = getAiProvider(registry, "offline");
    const result = await offline.analyze({
      ticker: sym, topic: "detail", asOf, horizonQuarters: 2,
      model: "offline-deterministic-v1", evidence: evidence.items, technical, technicalScore, facts, snapshot,
    });
    const composite = composeScore({
      analysis: result.analysis, technicalScore: technicalScore?.score,
      independentSources: evidence.independentSources, missingDataCount: result.analysis.missingData.length,
    });
    analysis = result.analysis;
    overallScore = composite.overall;
    confidence = composite.confidence;
    classification = classifyRisk(composite.overall, composite.confidence, lastPrice);
  } catch { /* analysis optional */ }

  const sigRs = await db.execute({
    sql: `SELECT signal_type, direction, strength, specificity, quote, event_date, source_url
          FROM signals WHERE ticker = ? ORDER BY event_date DESC LIMIT 60`,
    args: [sym],
  });

  return {
    ticker: sym,
    companyName: facts.companyName ?? asset?.name ?? sym,
    exchange: asset?.exchange,
    lastPrice,
    priceTimestamp: snapshot?.latestTrade?.timestamp,
    delayed: snapshot?.delayed ?? true,
    marketSource: registry.marketSource,
    marketError,
    facts,
    technical,
    technicalScore,
    overallScore,
    confidence,
    classification,
    analysis,
    bars: bars.map((b) => ({ t: b.timestamp.slice(0, 10), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })),
    signals: sigRs.rows,
    disclaimer: DISCLAIMER,
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = Bun.file(join(PUBLIC_DIR, safe));
  if (await file.exists()) return new Response(file);
  // SPA fallback.
  const index = Bun.file(join(PUBLIC_DIR, "index.html"));
  if (await index.exists()) return new Response(index);
  return json({ error: "not found" }, 404);
}

async function candidateTickers(topic: string | null, limit: number): Promise<string[]> {
  try {
    if (topic) {
      const rs = await db.execute({
        sql: `SELECT DISTINCT ticker FROM segments_fts WHERE segments_fts MATCH ? LIMIT ?`,
        args: [topic, limit],
      });
      const t = rs.rows.map((r) => String(r.ticker)).filter(Boolean);
      if (t.length) return t;
    }
    const rs = await db.execute({
      sql: `SELECT ticker, COUNT(*) n FROM signals GROUP BY ticker ORDER BY n DESC LIMIT ?`,
      args: [limit],
    });
    return rs.rows.map((r) => String(r.ticker)).filter(Boolean);
  } catch {
    return [];
  }
}

const server = Bun.serve({
  port,
  idleTimeout: 60,
  async fetch(req) {
    const url = new URL(req.url);
    const p = url.pathname;
    try {
      if (p === "/health") return json({ ok: true });

      if (p === "/api" || p === "/api/") {
        return json({
          name: "advis0r.com API",
          description:
            "Read-only research API over indexed executive transcripts. The web dashboard lives at /.",
          endpoints: {
            "GET /api/stats": "index coverage counts",
            "GET /api/tickers": "tickers present in the index",
            "GET /api/search?q=&limit=": "full-text search over transcript segments",
            "GET /api/signals?ticker=": "extracted signals for a ticker",
            "GET /api/ticker?symbol=": "full detail: quote, technicals, bars, fundamentals, signals, analysis",
            "GET /api/discover?topic=&provider=offline&horizon=2&limit=": "ranked watchlist",
          },
          disclaimer: DISCLAIMER,
        });
      }

      if (p === "/api/stats") {
        const out: Record<string, number> = {};
        for (const t of ["documents", "transcripts", "signals", "analyses", "market_bars"]) {
          const rs = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
          out[t] = Number(rs.rows[0]?.n ?? 0);
        }
        return json(out);
      }

      if (p === "/api/tickers") {
        const rs = await db.execute(
          `SELECT ticker, COUNT(*) n FROM signals GROUP BY ticker ORDER BY n DESC`,
        );
        return json({ tickers: rs.rows });
      }

      if (p === "/api/search") {
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

      if (p === "/api/ticker") {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) return json({ error: "missing ?symbol=" }, 400);
        return json(await tickerDetail(symbol));
      }

      if (p === "/api/signals") {
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

      if (p === "/api/discover") {
        const topic = url.searchParams.get("topic");
        const provider = url.searchParams.get("provider") ?? "offline";
        const horizon = (Number(url.searchParams.get("horizon")) === 1 ? 1 : 2) as 1 | 2;
        const limit = Math.min(25, Number(url.searchParams.get("limit") ?? 10) || 10);
        const tickers = await candidateTickers(topic, limit);
        const ranked: RankedCandidate[] = [];
        for (const ticker of tickers) {
          try {
            const outcome = await analyzeTicker(db, config, registry, ticker, {
              topic: topic ?? "watchlist",
              asOf: new Date().toISOString(),
              horizonQuarters: horizon,
              provider,
              model: provider === "offline" ? "offline-deterministic-v1" : config.ai.defaultModelAlias,
              criteria: {},
              persist: false,
            });
            if (outcome.candidate) ranked.push(outcome.candidate);
          } catch {
            /* skip individual failures */
          }
        }
        ranked.sort((a, b) => b.overallScore - a.overallScore);
        ranked.forEach((c, i) => (c.rank = i + 1));
        return json({ topic: topic ?? null, provider, horizonQuarters: horizon, candidates: ranked, disclaimer: DISCLAIMER });
      }

      if (p.startsWith("/api/")) return json({ error: "not found" }, 404);

      return await serveStatic(p);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
});

console.log(`advis0r.com server listening on :${server.port}`);
