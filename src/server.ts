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
 *   GET /crypto/**                       -> crypto market data (see src/crypto/routes.ts)
 *   GET /*                               -> static assets / SPA shell
 */
import { join, normalize } from "node:path";
import { loadConfig } from "./config.ts";
import { getDb, migrate } from "./db/index.ts";
import { buildRegistry, getAiProvider } from "./registry.ts";
import { analyzeTicker } from "./pipeline/analyze.ts";
import { refreshTickerNews } from "./pipeline/news-refresh.ts";
import { calculateIndicators, scoreTechnicalSetup } from "./technical/indicators.ts";
import { buildEvidence } from "./evidence/builder.ts";
import { composeScore, classifyRisk } from "./scoring/score.ts";
import { DISCLAIMER } from "./compliance.ts";
import { Mailer } from "./auth/email.ts";
import { guardResponse, handleAuthRoute, requireUser } from "./auth/routes.ts";
import { CoinPayClient } from "./credits/coinpay.ts";
import { handleCreditsRoute } from "./credits/routes.ts";
import { COST_PER_ANALYSIS, refundCredits, spendCredits } from "./credits/ledger.ts";
import { handleWatchlistRoute } from "./auth/watchlist.ts";
import { handleDigestRoute } from "./digest/routes.ts";
import { startDigestScheduler } from "./digest/run.ts";
import { handleReportRoute } from "./reports/routes.ts";
import { loadReport, normalizeSymbol, saveReport } from "./reports/store.ts";
import { handleLookupRoute } from "./symbols/routes.ts";
import { cryptoDeepLinkRedirect, handleCryptoRoute } from "./crypto/routes.ts";
import { cryptoSitemapEntries } from "./crypto/page.ts";
import { SUPPORTED_PAIRS } from "./crypto/pairs.ts";
import { resolveOne } from "./symbols/lookup.ts";
import type { IndicatorConfig, RankedCandidate } from "./types.ts";

const config = loadConfig();
const db = getDb(config);
await migrate(db);
const registry = buildRegistry(config);

// Accounts only — no existing route is gated by authentication (PRD v3 §7).
const mailer = new Mailer({
  resendApiKey: config.secrets.resendApiKey,
  mailgunApiKey: config.secrets.mailgunApiKey,
  mailgunDomain: config.secrets.mailgunDomain,
  from: config.secrets.mailFrom || undefined,
});
const coinpay = new CoinPayClient({
  apiKey: config.secrets.coinpayApiKey,
  businessId: config.secrets.coinpayBusinessId,
  webhookSecret: config.secrets.coinpayWebhookSecret,
});
const authDeps = {
  db,
  mailer,
  appUrl: config.appUrl,
  // Secure cookies require HTTPS; localhost development is served over HTTP.
  secureCookies: config.appUrl.startsWith("https://"),
};
console.log(
  `auth: email transport = ${mailer.transport}${mailer.configured ? ` (from ${mailer.from})` : " — verification emails will NOT be sent"}`,
);

// Watchlist digests. The scheduler is a background tick inside this process:
// it needs no external cron, and `digest_sends` makes the repeated ticks (and a
// second server, should one ever run) safe. Set DIGEST_SCHEDULER=0 to run the
// send from cron instead — `transcripts digest send`.
const digestDeps = {
  db,
  mailer,
  market: registry.alpaca,
  appUrl: config.appUrl,
  marketSource: registry.marketSource,
};
const digestSchedulerEnabled = process.env.DIGEST_SCHEDULER !== "0" && mailer.configured;
startDigestScheduler(digestDeps, { enabled: digestSchedulerEnabled });
console.log(
  `digest: scheduler ${
    digestSchedulerEnabled
      ? "on — watchlist emails go out at the 04:00 ET pre-market open"
      : `off${mailer.configured ? " (DIGEST_SCHEDULER=0)" : " — no email transport configured"}`
  }`,
);

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

  // SEC EDGAR rate-limits hard (403 "Request Rate Threshold Exceeded") and is
  // the one provider with no fallback. Treated like the market fetch above:
  // record the failure and carry on, so a transient block degrades the
  // fundamentals section instead of preventing the report from existing at all.
  let facts: Awaited<ReturnType<typeof registry.fundamentals.getCompanyFacts>>;
  let factsError: string | undefined;
  try {
    facts = await registry.fundamentals.getCompanyFacts(sym, asOf);
  } catch (err) {
    factsError = String(err).slice(0, 300);
    // `source` names what produced these facts; "unavailable" is the honest
    // answer, and downstream code reads it rather than inferring provenance.
    facts = { symbol: sym, asOf, source: "unavailable" };
  }
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
          FROM signals WHERE ticker = ? AND COALESCE(is_boilerplate, 0) = 0
          ORDER BY event_date DESC LIMIT 60`,
    args: [sym],
  });

  // Latest cached LLM (non-offline) analysis, if one has been run before.
  let aiAnalysis: unknown;
  try {
    const aiRs = await db.execute({
      sql: `SELECT provider, model, output_json, overall_score, confidence, created_at
            FROM analyses WHERE ticker = ? AND provider != 'offline'
            ORDER BY created_at DESC LIMIT 1`,
      args: [sym],
    });
    if (aiRs.rows.length) {
      const r = aiRs.rows[0]!;
      aiAnalysis = {
        provider: r.provider,
        model: r.model,
        overallScore: r.overall_score,
        confidence: r.confidence,
        createdAt: r.created_at,
        analysis: JSON.parse(String(r.output_json)),
      };
    }
  } catch { /* ignore */ }

  // Group evidence by source document → per-transcript/video "what they said"
  // summary, with links and (for videos) an embeddable player.
  const docsRs = await db.execute({
    sql: `SELECT d.url, d.title, d.event_type, d.published_at, d.publisher, d.source_tier,
                 d.provider_id
          FROM documents d JOIN transcripts t ON t.document_id = d.id
          WHERE t.primary_ticker = ?`,
    args: [sym],
  });
  const docByUrl = new Map(docsRs.rows.map((r) => [String(r.url), r]));
  const byUrl = new Map<string, any[]>();
  for (const s of sigRs.rows) {
    const u = String(s.source_url || "");
    if (!u) continue;
    (byUrl.get(u) ?? byUrl.set(u, []).get(u)!).push(s);
  }
  // Coverage that produced no extracted signal still belongs in the list.
  // Grouping strictly by signal meant an ingested article with no rule match
  // was invisible — the app looked like it had aggregated nothing at all.
  for (const [url, doc] of docByUrl) {
    if (doc.provider_id !== "news" || byUrl.has(url)) continue;
    byUrl.set(url, []);
  }

  const sources = [...byUrl.entries()]
    .map(([url, sigs]) => {
      const doc: any = docByUrl.get(url) ?? {};
      const cls = classifySource(url, String(doc.event_type ?? ""));
      const pos = sigs.filter((s) => s.direction === "positive").length;
      const neg = sigs.filter((s) => s.direction === "negative").length;
      return {
        url,
        title: doc.title ?? url,
        eventType: doc.event_type ?? "document",
        publishedAt: doc.published_at ?? sigs[0]?.event_date ?? null,
        publisher: doc.publisher ?? null,
        sourceTier: doc.source_tier ?? null,
        kind: cls.kind,
        embedUrl: cls.embedUrl,
        direct: cls.direct ?? false,
        positive: pos,
        negative: neg,
        said: sigs
          .slice(0, 8)
          .map((s) => ({ signalType: s.signal_type, direction: s.direction, quote: s.quote, eventDate: s.event_date })),
      };
    })
    .sort((a, b) => String(b.publishedAt ?? "").localeCompare(String(a.publishedAt ?? "")));

  return {
    ticker: sym,
    companyName: facts.companyName ?? asset?.name ?? sym,
    exchange: asset?.exchange,
    lastPrice,
    priceTimestamp: snapshot?.latestTrade?.timestamp,
    delayed: snapshot?.delayed ?? true,
    // True per-response provenance: the feed on the snapshot we actually used.
    marketSource: snapshot?.feed ?? registry.marketSource,
    marketError,
    factsError,
    facts,
    technical,
    technicalScore,
    overallScore,
    confidence,
    classification,
    analysis,
    aiAnalysis,
    aiProviders: [...registry.ai.keys()].filter((k) => k !== "offline"),
    bars: bars.map((b) => ({ t: b.timestamp.slice(0, 10), o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })),
    signals: sigRs.rows,
    sources,
    disclaimer: DISCLAIMER,
  };
}

/**
 * A ticker's report, from storage when one exists.
 *
 * This is the whole point of the reports table. `tickerDetail` costs a bars
 * fetch, a snapshot, an asset lookup, a SEC company-facts call, an evidence
 * build and an offline analysis — several seconds and a handful of third-party
 * requests to redisplay something nobody changed. A stored snapshot costs one
 * row read.
 *
 * It is never refreshed on a timer: a snapshot is rebuilt when it is missing, or
 * when a watchlist member asks for it. What keeps that honest is that every
 * surface renders `reportGeneratedAt` — a stale price is fine as long as it is
 * never dressed up as a current one.
 */
async function getReport(
  symbol: string,
  opts: { rebuild?: boolean; generatedBy?: string } = {},
): Promise<Record<string, unknown>> {
  const sym = symbol.toUpperCase();
  if (!opts.rebuild) {
    const stored = await loadReport(db, sym);
    if (stored) {
      return {
        ...stored.payload,
        cached: true,
        reportGeneratedAt: stored.generatedAt,
        reportFirstGeneratedAt: stored.firstGeneratedAt,
      };
    }
  }
  const payload = await tickerDetail(sym);
  const stored = await saveReport(db, sym, payload, { generatedBy: opts.generatedBy });
  return {
    ...payload,
    cached: false,
    reportGeneratedAt: stored.generatedAt,
    reportFirstGeneratedAt: stored.firstGeneratedAt,
  };
}

/** Classify a source URL as a transcript, an embeddable video, or audio. */
function classifySource(
  url: string,
  eventType: string,
): { kind: "transcript" | "video" | "audio" | "news"; embedUrl?: string; direct?: boolean } {
  // News and press releases are neither transcripts nor media; labelling them
  // "Transcript" in the UI is why ingested coverage looked like it was missing.
  if (eventType === "news_article" || eventType === "press_release") return { kind: "news" };
  const yt = url.match(/(?:youtube\.com\/(?:watch\?v=|embed\/|live\/)|youtu\.be\/)([\w-]{6,})/i);
  if (yt) return { kind: "video", embedUrl: `https://www.youtube.com/embed/${yt[1]}` };
  const vim = url.match(/vimeo\.com\/(?:video\/)?(\d+)/i);
  if (vim) return { kind: "video", embedUrl: `https://player.vimeo.com/video/${vim[1]}` };
  if (/\.(mp4|webm|ogv|mov|m4v)(\?|#|$)/i.test(url)) return { kind: "video", embedUrl: url, direct: true };
  // Audio: direct audio files or podcast enclosures.
  if (/\.(mp3|m4a|wav|aac|flac|opus|ogg|oga)(\?|#|$)/i.test(url)) return { kind: "audio", embedUrl: url, direct: true };
  if (eventType === "video") return { kind: "video", embedUrl: url };
  if (eventType === "podcast") return { kind: "audio", embedUrl: url, direct: true };
  return { kind: "transcript" };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

const NO_STORE = { "cache-control": "no-store, no-cache, must-revalidate" };

// Suggested topics for the watchlist dropdown (users may also type any topic).
const SUGGESTED_TOPICS = [
  "AI infrastructure", "artificial intelligence", "generative AI", "large language models",
  "data center", "semiconductor", "GPU accelerator", "chip foundry", "memory chips",
  "cloud computing", "cloud security", "cybersecurity", "quantum computing", "edge computing",
  "robotics", "industrial automation", "autonomous vehicles", "electric vehicle", "lithium battery",
  "solar energy", "wind energy", "nuclear energy", "energy storage", "hydrogen fuel", "smart grid",
  "biotechnology", "gene therapy", "oncology", "medical devices", "clinical trials", "diagnostics",
  "fintech", "digital payments", "blockchain", "cryptocurrency", "e-commerce", "software as a service",
  "gaming", "streaming media", "digital advertising", "aerospace", "defense contract", "space launch",
  "satellite", "drones", "5G wireless", "internet of things", "supply chain", "3D printing", "carbon capture",
];

async function serveStatic(pathname: string): Promise<Response> {
  const rel = pathname === "/" ? "/index.html" : pathname;
  const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  const file = Bun.file(join(PUBLIC_DIR, safe));
  if (await file.exists()) return new Response(file, { headers: NO_STORE });
  // SPA fallback.
  const index = Bun.file(join(PUBLIC_DIR, "index.html"));
  if (await index.exists()) return new Response(index, { headers: NO_STORE });
  return json({ error: "not found" }, 404);
}

/**
 * Turn a raw user query into a safe FTS5 MATCH expression. Each alphanumeric
 * token is quoted (so hyphens, operators, quotes, colons etc. can't break the
 * parser) and prefix-matched for typeahead-style results. Returns null if the
 * query has no usable tokens.
 */
function ftsQuery(raw: string): string | null {
  const tokens = (raw.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length >= 2 || /\d/.test(t));
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(" ");
}

async function candidateTickers(topic: string | null, limit: number): Promise<string[]> {
  try {
    const match = topic ? ftsQuery(topic) : null;
    if (match) {
      const rs = await db.execute({
        sql: `SELECT DISTINCT ticker FROM segments_fts WHERE segments_fts MATCH ? LIMIT ?`,
        args: [match, limit],
      });
      const t = rs.rows.map((r) => String(r.ticker)).filter(Boolean);
      if (t.length) return t;
    }
    const rs = await db.execute({
      sql: `SELECT ticker, COUNT(*) n FROM signals WHERE COALESCE(is_boilerplate, 0) = 0
            GROUP BY ticker ORDER BY n DESC LIMIT ?`,
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

    // Canonicalize: strip a leading "www." from the host on every request.
    const host = req.headers.get("host") ?? "";
    if (host.toLowerCase().startsWith("www.")) {
      const proto = req.headers.get("x-forwarded-proto") ?? "https";
      return Response.redirect(`${proto}://${host.slice(4)}${p}${url.search}`, 301);
    }

    try {
      if (p === "/health") return json({ ok: true });

      const pairRedirect = cryptoDeepLinkRedirect(p, url, config.appUrl);
      if (pairRedirect) return pairRedirect;

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
            "GET /api/ticker?symbol=": "stored report snapshot: quote, technicals, bars, fundamentals, signals, analysis",
            "GET /ticker/<SYMBOL>": "the same report as a shareable page",
            "GET /reports?sort=recent|score|ticker": "every stored report",
            "GET /api/reports?limit=&sort=": "the report index as JSON",
            "POST /api/report/regenerate": "rebuild one snapshot (watchlist members only)",
            "GET /api/discover?topic=&provider=offline&horizon=2&limit=": "ranked watchlist",
            "GET /api/lookup?q=&limit=": "find a ticker by company name (e.g. q=rivian -> RIVN)",
            "GET /api/watchlist": "your saved tickers (requires sign-in); ?format=csv downloads them",
            "GET /api/watchlist/overview?range=1M|3M|6M|1Y":
              "the same tickers priced: per-row changes, sparkline and score, summary statistics, and an equal-weight index against SPY",
            "GET /api/digest": "your watchlist email frequency (requires sign-in)",
            "POST /api/digest": "set frequency: daily | weekly | off",
            "GET /crypto": "crypto market data index — every crypto route is namespaced under /crypto/**",
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
        // Report the usable corpus alongside the raw count: `signals` includes
        // rows flagged as filing boilerplate, which nothing downstream reads.
        const kept = await db.execute(
          "SELECT COUNT(*) AS n FROM signals WHERE COALESCE(is_boilerplate, 0) = 0",
        );
        out.signals_usable = Number(kept.rows[0]?.n ?? 0);
        out.signals_boilerplate = (out.signals ?? 0) - out.signals_usable;
        const news = await db.execute(
          "SELECT COUNT(*) AS n FROM documents WHERE COALESCE(source_tier, 0) > 0",
        );
        out.news_documents = Number(news.rows[0]?.n ?? 0);
        return json(out);
      }

      if (p === "/api/topics") {
        return json({ topics: SUGGESTED_TOPICS });
      }

      if (p === "/api/tickers") {
        const rs = await db.execute(
          `SELECT ticker, COUNT(*) n FROM signals WHERE COALESCE(is_boilerplate, 0) = 0
            GROUP BY ticker ORDER BY n DESC`,
        );
        return json({ tickers: rs.rows });
      }

      if (p === "/api/search") {
        const q = url.searchParams.get("q");
        if (!q) return json({ error: "missing ?q=" }, 400);
        const limit = Math.min(50, Number(url.searchParams.get("limit") ?? 20) || 20);
        const match = ftsQuery(q);
        let rows: any[] = [];
        if (match) {
          const rs = await db.execute({
            sql: `SELECT text, speaker, ticker, event_date FROM segments_fts
                  WHERE segments_fts MATCH ? LIMIT ?`,
            args: [match, limit],
          });
          rows = rs.rows;
        }
        // Fallback: substring scan when FTS finds nothing (e.g. rare tokens).
        if (rows.length === 0) {
          const rs = await db.execute({
            sql: `SELECT s.text AS text, s.speaker AS speaker, t.primary_ticker AS ticker,
                         t.event_date AS event_date
                  FROM transcript_segments s JOIN transcripts t ON t.id = s.transcript_id
                  WHERE s.text LIKE ? LIMIT ?`,
            args: [`%${q.replace(/[%_]/g, "")}%`, limit],
          });
          rows = rs.rows;
        }
        return json({ query: q, results: rows });
      }

      if (p === "/api/ticker") {
        const raw = url.searchParams.get("symbol") ?? "";
        const symbol = normalizeSymbol(raw);
        if (!symbol) {
          // "rivian" lands here. Rejecting it without saying where to go next is
          // how someone concludes the company simply is not covered.
          const hit = raw.trim() ? await resolveOne(db, raw).catch(() => null) : null;
          return json(
            {
              error: hit
                ? `"${raw.trim()}" is not a ticker — did you mean ${hit.symbol} (${hit.name})?`
                : `"${raw.trim()}" is not a ticker. Search by company name at /api/lookup?q=`,
              didYouMean: hit ? { symbol: hit.symbol, name: hit.name } : undefined,
              lookup: `/api/lookup?q=${encodeURIComponent(raw.trim().slice(0, 64))}`,
            },
            400,
          );
        }
        // Serves the stored snapshot. Rebuilding is a separate, authorized act
        // (POST /api/report/regenerate) so a crawler hammering this route cannot
        // spend our market-data quota.
        return json(await getReport(symbol));
      }

      // On-demand LLM sharpening for one ticker (persisted → cached thereafter).
      // Tries the requested (or default) provider first, then falls back to the
      // others — so OpenAI is used the moment its quota resets, and Anthropic
      // covers it in the meantime.

      // Streaming variant of /api/analyze. Emits a Server-Sent Event per
      // pipeline stage so the UI can show what is actually happening — the
      // previous blind spinner made a slow model call, a validation failure and
      // an edge-proxy 502 all look identical.
      if (p === "/api/analyze/stream") {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) return json({ error: "missing ?symbol=" }, 400);
        // Metered LLM path: signed in AND verified. Enforced here as well as in
        // the UI — the client-side check is a courtesy, this is the control.
        const guard = await requireUser(req, db, { requireVerified: true });
        if (guard.failure) return guardResponse(guard.failure);
        // Charge before doing the work. A failed analysis is refunded below, so
        // a user is never billed for output they did not get.
        const spend = await spendCredits(db, guard.user!.id, COST_PER_ANALYSIS, "analysis");
        if (!spend.ok) {
          return json({ error: spend.error, insufficientCredits: true, balance: spend.balance }, 402);
        }
        const ticker = symbol.toUpperCase();
        const requested = url.searchParams.get("provider");
        // `balanced` (Sonnet-tier) rather than `latest`: measured 44s vs 67s
        // on the same input, for an interactive path where latency is the
        // difference between a usable feature and a proxy timeout.
        const model = url.searchParams.get("model") ?? "balanced";
        const all = [...registry.ai.keys()].filter((k) => k !== "offline");
        const order =
          requested && requested !== "offline"
            ? [requested, ...all.filter((x) => x !== requested)]
            : [config.ai.defaultProvider, ...all.filter((x) => x !== config.ai.defaultProvider)];

        const stream = new ReadableStream({
          async start(controller) {
            const enc = new TextEncoder();
            const started = Date.now();
            const send = (event: string, data: unknown) => {
              try {
                controller.enqueue(enc.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
              } catch {
                /* client disconnected */
              }
            };
            // Heartbeat keeps intermediaries from buffering or closing an idle
            // connection during the long model call.
            const beat = setInterval(() => {
              try {
                controller.enqueue(enc.encode(`: keep-alive ${Date.now() - started}ms\n\n`));
              } catch {
                /* ignore */
              }
            }, 5000);

            send("status", { message: `Analyzing ${ticker}`, providers: order });
            let lastErr = "no analysis produced";
            try {
              // Aggregate current news before the model sees the evidence.
              // Keyless RSS only and deadlined, so an interactive click never
              // spends search credits or hangs on a slow publisher.
              const news = await refreshTickerNews(db, config, ticker, {
                onProgress: (message) => send("stage", { stage: "news", message }),
                deadlineMs: 25_000,
              });
              send("stage", {
                stage: "news",
                message: news.ran
                  ? `News ready — ${news.documents} new article(s), ${news.known} indexed for ${ticker}`
                  : `News ready — ${news.known} article(s) indexed for ${ticker}`,
                done: true,
              });
              for (const prov of order) {
                if (!registry.ai.has(prov)) continue;
                send("provider", { provider: prov, message: `Trying ${prov}` });
                try {
                  const outcome = await analyzeTicker(db, config, registry, ticker, {
                    topic: url.searchParams.get("topic") ?? ticker,
                    asOf: new Date().toISOString(),
                    horizonQuarters: 2,
                    provider: prov,
                    model,
                    criteria: {},
                    persist: true,
                    onProgress: (p) => send("stage", p),
                  });
                  if (outcome.candidate) {
                    const c = outcome.candidate;
                    send("result", {
                      provider: c.provider,
                      model: c.model,
                      overallScore: c.overallScore,
                      confidence: c.confidence,
                      analysis: c.analysis,
                      analyzedAt: c.analyzedAt,
                      elapsedMs: Date.now() - started,
                      disclaimer: DISCLAIMER,
                    });
                    // Fold the new analysis into the stored report so
                    // /ticker/<SYMBOL> shows it. After the result is sent: the
                    // user has what they paid for and should not wait on it.
                    getReport(ticker, { rebuild: true, generatedBy: guard.user!.id }).catch((err) =>
                      console.error(`[report] refresh after analyze failed for ${ticker}: ${String(err).slice(0, 200)}`),
                    );
                    return;
                  }
                  lastErr = outcome.filterReasons.join("; ") || "filtered out";
                  send("provider_failed", { provider: prov, error: lastErr });
                } catch (err) {
                  lastErr = String(err).slice(0, 400);
                  console.error(`[analyze] ${ticker} ${prov} failed: ${lastErr}`);
                  send("provider_failed", { provider: prov, error: lastErr });
                }
              }
              // Charged up front; nothing usable was produced, so give it back.
              await refundCredits(db, guard.user!.id, COST_PER_ANALYSIS, "analysis");
              send("failed", { error: lastErr, elapsedMs: Date.now() - started, refunded: true });
            } finally {
              clearInterval(beat);
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          },
        });

        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      }

      if (p === "/api/analyze") {
        const symbol = url.searchParams.get("symbol");
        if (!symbol) return json({ error: "missing ?symbol=" }, 400);
        const guard = await requireUser(req, db, { requireVerified: true });
        if (guard.failure) return guardResponse(guard.failure);
        // Charge before doing the work. A failed analysis is refunded below, so
        // a user is never billed for output they did not get.
        const spend = await spendCredits(db, guard.user!.id, COST_PER_ANALYSIS, "analysis");
        if (!spend.ok) {
          return json({ error: spend.error, insufficientCredits: true, balance: spend.balance }, 402);
        }
        const requested = url.searchParams.get("provider");
        const all = [...registry.ai.keys()].filter((k) => k !== "offline");
        const order =
          requested && requested !== "offline"
            ? [requested, ...all.filter((x) => x !== requested)]
            : [config.ai.defaultProvider, ...all.filter((x) => x !== config.ai.defaultProvider)];
        const model = url.searchParams.get("model") ?? "balanced";
        // Same news top-up as the streaming path — this route just has no
        // channel to report it on.
        await refreshTickerNews(db, config, symbol.toUpperCase(), { deadlineMs: 25_000 });
        let lastErr = "no analysis produced";
        for (const prov of order) {
          if (!registry.ai.has(prov)) continue;
          try {
            const outcome = await analyzeTicker(db, config, registry, symbol.toUpperCase(), {
              topic: url.searchParams.get("topic") ?? symbol.toUpperCase(),
              asOf: new Date().toISOString(),
              horizonQuarters: 2,
              provider: prov,
              model,
              criteria: {},
              persist: true,
            });
            if (outcome.candidate) {
              const c = outcome.candidate;
              // Same refresh as the streaming path, for the same reason.
              getReport(symbol.toUpperCase(), { rebuild: true, generatedBy: guard.user!.id }).catch(
                (err) => console.error(`[report] refresh after analyze failed: ${String(err).slice(0, 200)}`),
              );
              return json({
                provider: c.provider,
                model: c.model,
                overallScore: c.overallScore,
                confidence: c.confidence,
                analysis: c.analysis,
                analyzedAt: c.analyzedAt,
                triedFallback: prov !== order[0],
                disclaimer: DISCLAIMER,
              });
            }
            lastErr = outcome.filterReasons.join("; ") || lastErr;
          } catch (err) {
            lastErr = String(err);
            // fall through to the next provider
          }
        }
        await refundCredits(db, guard.user!.id, COST_PER_ANALYSIS, "analysis");
        return json({ error: lastErr }, 502);
      }

      if (p === "/api/signals") {
        const ticker = url.searchParams.get("ticker");
        if (!ticker) return json({ error: "missing ?ticker=" }, 400);
        const rs = await db.execute({
          sql: `SELECT ticker, signal_type, direction, strength, specificity, quote,
                       event_date, source_url, source_tier, speaker, speaker_title,
                       provenance, start_ms
                FROM signals WHERE ticker = ? AND COALESCE(is_boilerplate, 0) = 0
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
        // Overlay any cached LLM analyses so a sharpened watchlist shows AI
        // scores/theses and re-ranks by them (no new spend).
        const syms = ranked.map((c) => c.ticker);
        if (syms.length) {
          const ph = syms.map(() => "?").join(",");
          const aiRs = await db.execute({
            sql: `SELECT a.ticker, a.provider, a.model, a.output_json, a.overall_score, a.confidence
                  FROM analyses a
                  JOIN (SELECT ticker, MAX(created_at) mc FROM analyses
                        WHERE provider != 'offline' AND ticker IN (${ph}) GROUP BY ticker) l
                  ON a.ticker = l.ticker AND a.created_at = l.mc
                  WHERE a.provider != 'offline'`,
            args: syms,
          });
          const aiByTicker = new Map(aiRs.rows.map((r) => [String(r.ticker), r]));
          for (const c of ranked) {
            const ai: any = aiByTicker.get(c.ticker);
            if (!ai) continue;
            c.overallScore = Number(ai.overall_score);
            c.confidence = Number(ai.confidence);
            c.analysis = JSON.parse(String(ai.output_json));
            c.provider = String(ai.provider);
            c.model = String(ai.model);
            c.thesis = c.analysis.thesis;
            c.primaryCatalyst = c.analysis.catalystSummary?.[0];
            c.mainRisk = c.analysis.riskSummary?.[0];
            c.classification = classifyRisk(c.overallScore, c.confidence, c.lastPrice);
          }
        }
        ranked.sort((a, b) => b.overallScore - a.overallScore);
        ranked.forEach((c, i) => (c.rank = i + 1));
        return json({ topic: topic ?? null, provider, horizonQuarters: horizon, candidates: ranked, disclaimer: DISCLAIMER });
      }

      const authResponse = await handleAuthRoute(req, p, authDeps);
      if (authResponse) return authResponse;

      // The saved watchlist is the one authenticated feature — everything else
      // stays public.
      const watchlistResponse = await handleWatchlistRoute(req, p, {
        db,
        market: registry.alpaca,
        marketSource: registry.marketSource,
      });
      if (watchlistResponse) return watchlistResponse;

      const creditsResponse = await handleCreditsRoute(req, p, { db, coinpay, appUrl: config.appUrl });
      if (creditsResponse) return creditsResponse;

      // Digest preferences, plus the login-free unsubscribe endpoint every
      // digest email links to.
      const digestResponse = await handleDigestRoute(req, p, { db, appUrl: config.appUrl });
      if (digestResponse) return digestResponse;

      // Crypto (/crypto/** and /api/crypto/**). Ahead of the report routes and
      // the SPA fallback so /crypto/BTC-USD is never answered with index.html.
      const cryptoResponse = await handleCryptoRoute(req, p, {
        client: registry.crypto,
        indicators: INDICATOR_CONFIG,
        appUrl: config.appUrl,
        fundamentals: registry.cryptoFundamentals,
        sparklines: registry.cryptoSparklines,
      });
      if (cryptoResponse) return cryptoResponse;

      // Stored report pages (/ticker/<SYMBOL>, /reports) and the regenerate
      // endpoint. Must come before the SPA fallback, which would otherwise
      // answer /ticker/NVDA with index.html.
      // Name -> ticker. Before the report routes, so /api/lookup is never
      // shadowed, and so a report page can offer suggestions on a miss.
      const lookupResponse = await handleLookupRoute(req, p, { db });
      if (lookupResponse) return lookupResponse;

      const reportResponse = await handleReportRoute(req, p, {
        db,
        appUrl: config.appUrl,
        buildReport: tickerDetail,
        suggest: (q) => resolveOne(db, q, { localOnly: false }),
        // Crypto pages are rendered live rather than stored, so they have no
        // report row to enumerate — they come from the static pair directory.
        extraSitemapUrls: cryptoSitemapEntries(SUPPORTED_PAIRS, config.appUrl),
      });
      if (reportResponse) return reportResponse;

      if (p.startsWith("/api/")) return json({ error: "not found" }, 404);

      return await serveStatic(p);
    } catch (err) {
      return json({ error: String(err) }, 500);
    }
  },
});

console.log(`advis0r.com server listening on :${server.port}`);
