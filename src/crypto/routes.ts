/**
 * Crypto HTTP surface — every crypto route lives under /crypto/**.
 *
 *   GET /api/crypto                          -> this index
 *   GET /api/crypto/assets                   -> supported pairs, marked live/idle
 *   GET /api/crypto/lookup?q=bitcoin         -> name/ticker -> pair
 *   GET /api/crypto/snapshot?symbols=BTC/USD -> quote + trade + daily bars
 *   GET /api/crypto/quote?symbol=BTC/USD     -> latest trade/quote + spread
 *   GET /api/crypto/bars?symbol=&timeframe=  -> historical OHLCV
 *   GET /api/crypto/orderbook?symbol=        -> top of book, both sides
 *   GET /api/crypto/technicals?symbol=       -> deterministic indicators + score
 *   GET /api/crypto/report?symbol=           -> snapshot + technicals in one call
 *   GET /api/crypto/<PAIR>                   -> the same report, path form
 *
 * The bare `/crypto/**` prefix is accepted as an alias for all of the above, so
 * both `/api/crypto/BTC-USD` and `/crypto/BTC-USD` resolve.
 *
 * Read-only and unauthenticated, matching the rest of the research API. Cost
 * control is by cache headers plus a hard cap on basket size — nothing here can
 * be made to issue an unbounded number of upstream requests.
 */
import { CRYPTO_DISCLAIMER } from "../compliance.ts";
import { calculateIndicators, scoreTechnicalSetup } from "../technical/indicators.ts";
import type { BarTimeframe, IndicatorConfig, MarketBar } from "../types.ts";
import type { AlpacaCryptoClient } from "./client.ts";
import { analyzeCrypto } from "./analysis.ts";
import { computePerformance } from "./performance.ts";
import { SPARK_PERIODS, SparklineService, isSparkPeriod } from "./sparkline.ts";
import type { CryptoFundamentalsClient } from "./fundamentals.ts";
import { renderCryptoIndexPage, renderCryptoPage, renderMissingCryptoPage } from "./page.ts";
import { SUPPORTED_PAIRS, getPair, lookupPairs, normalizePair, normalizePairs } from "./pairs.ts";

const json = (body: unknown, status = 200, cacheSeconds = 0) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
    },
  });

const htmlResponse = (body: string, status = 200, cacheSeconds = 0) =>
  new Response(body, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
    },
  });

/** Most symbols one request may fan out to. Keeps a crawler off our quota. */
const MAX_BASKET = 20;

/** Bars pulled for indicator maths — 400 days covers a 252-session window. */
const TECHNICAL_LOOKBACK_DAYS = 400;

const VALID_TIMEFRAMES: BarTimeframe[] = ["1Min", "5Min", "15Min", "1Hour", "1Day", "1Week"];

/** Reserved sub-paths, so /crypto/<PAIR> can never shadow a named route. */
const RESERVED = new Set([
  "assets",
  "lookup",
  "snapshot",
  "snapshots",
  "quote",
  "quotes",
  "bars",
  "orderbook",
  "orderbooks",
  "technicals",
  "report",
  "sparklines",
]);

export interface CryptoRouteDeps {
  client: AlpacaCryptoClient;
  indicators: IndicatorConfig;
  /** Absolute site origin, for canonical URLs on the rendered pages. */
  appUrl: string;
  /** Market cap / supply. Optional: the pages render without it. */
  fundamentals?: CryptoFundamentalsClient;
  /** Compact price series for the grid cards. Optional. */
  sparklines?: SparklineService;
}

/**
 * Returns null when `path` is not a crypto route, so the caller falls through
 * to its other handlers.
 *
 * Two prefixes, and the difference is what a human versus a program gets:
 * `/crypto/<PAIR>` renders a shareable HTML page, `/api/crypto/<PAIR>` returns
 * the same data as JSON. The named data endpoints (assets, quote, bars, …)
 * answer JSON under either prefix — they have no page form.
 */
export async function handleCryptoRoute(
  req: Request,
  path: string,
  deps: CryptoRouteDeps,
): Promise<Response | null> {
  const matched = cryptoSubPath(path);
  if (!matched) return null;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);
  const { rest, api } = matched;

  const url = new URL(req.url);
  try {
    switch (rest) {
      case "":
        return api ? index(deps) : await indexPage(deps);
      case "assets":
        return await assets(deps);
      case "lookup":
        return lookup(url);
      case "snapshot":
      case "snapshots":
        return await snapshot(url, deps);
      case "quote":
      case "quotes":
        return await quote(url, deps);
      case "bars":
        return await bars(url, deps);
      case "orderbook":
      case "orderbooks":
        return await orderbook(url, deps);
      case "technicals":
        return await technicals(url, deps);
      case "sparklines":
        return await sparklineRoute(url, deps);
      case "report":
        return await report(url.searchParams.get("symbol"), url, deps);
    }
    // A pair: a page under /crypto/<PAIR>, the same data as JSON under
    // /api/crypto/<PAIR>.
    return api ? await report(rest, url, deps) : await pairPage(rest, deps);
  } catch (err) {
    // Upstream failures are the expected error here; surface them as 502 with
    // the reason rather than a bare 500 that hides whether it was us or Alpaca.
    //
    // The error must match what the route would have returned, not the prefix
    // it came in under: `/crypto/snapshot` is a JSON endpoint that happens to
    // live under the page prefix, and answering it with an HTML error page
    // breaks every client parsing its response.
    if (isPageRoute(rest, api)) {
      return htmlResponse(
        renderMissingCryptoPage(rest || "crypto", undefined, { appUrl: deps.appUrl }),
        502,
      );
    }
    return json(
      { error: "crypto market data unavailable", detail: String(err).slice(0, 300) },
      502,
    );
  }
}

/**
 * "/api/crypto/bars" -> {rest:"bars", api:true}; "/crypto" -> {rest:"", api:false}.
 * Tolerant of a trailing slash. Order matters: "/api/crypto" must be tested
 * first, or it would be mistaken for a pair named "crypto" under "/api".
 */
/**
 * `/?pair=BTC-USD` used to open an in-app modal — a second, weaker view of the
 * same pair, with no analysis and a URL nobody could share. There is one
 * surface now, so those links redirect to it.
 *
 * Lives here rather than inline in the server so it can be tested, and so the
 * pair grammar stays in one place. Returns null when the path is not the app
 * root or the parameter is not a pair we serve.
 */
export function cryptoDeepLinkRedirect(
  path: string,
  url: URL,
  appUrl: string,
): Response | null {
  if (path !== "/" && path !== "") return null;
  if (!url.searchParams.has("pair")) return null;
  const symbol = normalizePair(url.searchParams.get("pair"));
  if (!symbol) return null;
  return Response.redirect(`${appUrl.replace(/\/$/, "")}/crypto/${getPair(symbol)!.slug}`, 301);
}

/**
 * Does this route render HTML? Only the directory and a pair, and only under
 * the bare prefix — every named endpoint answers JSON under either prefix.
 */
function isPageRoute(rest: string, api: boolean): boolean {
  return !api && !RESERVED.has(rest);
}

function cryptoSubPath(path: string): { rest: string; api: boolean } | null {
  for (const prefix of ["/api/crypto", "/crypto"]) {
    const api = prefix.startsWith("/api");
    if (path === prefix || path === `${prefix}/`) return { rest: "", api };
    if (path.startsWith(`${prefix}/`)) {
      const rest = path.slice(prefix.length + 1).replace(/\/$/, "");
      // Only a single segment is a crypto route; deeper paths are not ours.
      return rest.includes("/") ? null : { rest, api };
    }
  }
  return null;
}

function index(deps: CryptoRouteDeps): Response {
  return json(
    {
      name: "advis0r.com crypto API",
      description:
        "Read-only crypto market data over Alpaca's US crypto venue. Every crypto route is namespaced under /crypto/**; /api/crypto/** is the same surface.",
      source: {
        provider: "alpaca",
        feed: "v1beta3/crypto/us",
        authenticated: deps.client.authenticated,
        note: deps.client.authenticated
          ? "Signed with the same Alpaca credentials used for equities; crypto needs no extra subscription."
          : "Unsigned — Alpaca's crypto feed is public, so this works without APCA credentials.",
      },
      symbolFormats: [
        "BTC/USD (canonical)",
        "BTC-USD (URL-safe, use this in paths)",
        "BTC (bare asset, defaults to the USD pair)",
        "BTCUSD (concatenated)",
      ],
      endpoints: {
        "GET /crypto/assets": "supported pairs, each marked live or idle",
        "GET /crypto/lookup?q=&limit=": "find a pair by asset name (e.g. q=bitcoin -> BTC/USD)",
        "GET /crypto/snapshot?symbols=": `latest trade, quote and daily bars (up to ${MAX_BASKET} pairs)`,
        "GET /crypto/quote?symbol=": "latest trade and quote with bid/ask spread",
        "GET /crypto/bars?symbol=&timeframe=&start=&end=&limit=":
          `historical OHLCV; timeframe one of ${VALID_TIMEFRAMES.join(", ")}`,
        "GET /crypto/orderbook?symbol=&depth=": "top of book, both sides",
        "GET /crypto/sparklines?symbols=&period=24h|7d":
          "compact close-price series for drawing sparklines",
        "GET /crypto/technicals?symbol=&horizon=1|2":
          "locally computed SMA/EMA/RSI/MACD/Bollinger/ATR + technical score",
        "GET /crypto/report?symbol=": "snapshot + technicals + score in one call",
        "GET /crypto/<PAIR>": "the same report, e.g. /crypto/BTC-USD",
      },
      pairs: SUPPORTED_PAIRS.length,
      disclaimer: CRYPTO_DISCLAIMER,
    },
    200,
    300,
  );
}

/** Cached liveness probe for the pair directory. */
let assetsCache: { at: number; live: Set<string> } | null = null;
const ASSETS_TTL_MS = 60 * 60 * 1000;

/** Drop the liveness cache. Exists so tests can exercise a failing probe. */
export function resetAssetsCache(): void {
  assetsCache = null;
}

async function assets(deps: CryptoRouteDeps): Promise<Response> {
  // The directory is static, but a pair can be delisted upstream. One cheap
  // batched call per hour marks what is actually trading, so a delisting shows
  // up here without a code change.
  let live = assetsCache && Date.now() - assetsCache.at < ASSETS_TTL_MS ? assetsCache.live : null;
  let probeError: string | undefined;
  if (!live) {
    try {
      const trades = await deps.client.getLatestTrades(SUPPORTED_PAIRS.map((p) => p.symbol));
      live = new Set(trades.map((t) => t.symbol));
      assetsCache = { at: Date.now(), live };
    } catch (err) {
      probeError = String(err).slice(0, 200);
    }
  }

  return json(
    {
      count: SUPPORTED_PAIRS.length,
      // Absent a successful probe, say so rather than reporting everything idle.
      liveness: live ? "verified" : "unverified",
      probeError,
      assets: SUPPORTED_PAIRS.map((p) => ({
        symbol: p.symbol,
        slug: p.slug,
        base: p.base,
        quote: p.quote,
        name: p.name,
        status: live ? (live.has(p.symbol) ? "live" : "idle") : "unknown",
      })),
      disclaimer: CRYPTO_DISCLAIMER,
    },
    200,
    300,
  );
}

function lookup(url: URL): Response {
  const q = (url.searchParams.get("q") ?? "").trim();
  const limit = Math.min(25, Number(url.searchParams.get("limit") ?? 10) || 10);
  if (!q) return json({ query: "", matches: [] }, 200, 60);
  return json(
    {
      query: q,
      matches: lookupPairs(q, limit).map((p) => ({
        symbol: p.symbol,
        slug: p.slug,
        base: p.base,
        quote: p.quote,
        name: p.name,
      })),
    },
    200,
    // The directory is near-static; absorb typeahead keystrokes.
    60,
  );
}

/**
 * Resolve `?symbols=` into a validated basket, or an error Response.
 *
 * When SOME tokens resolve the request still succeeds, but the rejects are
 * carried through to the response — a basket that quietly returns two of the
 * three symbols asked for reads as "that pair has no data" when the truth is
 * "you spelled it in a way we do not accept".
 */
function basket(url: URL): { pairs: string[]; rejected: string[] } | { error: Response } {
  const raw = url.searchParams.get("symbols") ?? url.searchParams.get("symbol");
  const { pairs, rejected } = normalizePairs(raw);
  if (!pairs.length) {
    // A basket of one is the common case (?symbol=bitcoin); it deserves the
    // same "did you mean" a single-symbol route gives rather than a bare list.
    const suggestion = rejected.length === 1 ? lookupPairs(rejected[0]!, 1)[0] : undefined;
    return {
      error: json(
        {
          error: rejected.length
            ? `unsupported pair(s): ${rejected.join(", ")}${suggestion ? ` — did you mean ${suggestion.symbol}?` : ""}`
            : "missing ?symbols= (e.g. ?symbols=BTC/USD,ETH/USD)",
          rejected,
          didYouMean: suggestion
            ? { symbol: suggestion.symbol, slug: suggestion.slug, name: suggestion.name }
            : undefined,
          assets: "/crypto/assets",
          lookup: "/crypto/lookup?q=",
        },
        400,
      ),
    };
  }
  if (pairs.length > MAX_BASKET) {
    return { error: json({ error: `too many symbols; max ${MAX_BASKET}` }, 400) };
  }
  return { pairs, rejected };
}

/** Rejected tokens, shaped for inclusion in an otherwise successful response. */
function rejectedNote(rejected: string[]): Record<string, unknown> {
  if (!rejected.length) return {};
  return {
    rejected,
    rejectedNote: `ignored unsupported symbol(s): ${rejected.join(", ")} — see /crypto/assets`,
  };
}

/** Resolve a single `?symbol=`, or an error Response. */
function single(raw: string | null): { pair: string } | { error: Response } {
  const pair = normalizePair(raw);
  if (!pair) {
    const shown = (raw ?? "").trim();
    const suggestion = shown ? lookupPairs(shown, 1)[0] : undefined;
    return {
      error: json(
        {
          error: shown
            ? `"${shown}" is not a supported crypto pair${suggestion ? ` — did you mean ${suggestion.symbol}?` : ""}`
            : "missing ?symbol= (e.g. ?symbol=BTC/USD)",
          didYouMean: suggestion
            ? { symbol: suggestion.symbol, slug: suggestion.slug, name: suggestion.name }
            : undefined,
          assets: "/crypto/assets",
          lookup: `/crypto/lookup?q=${encodeURIComponent(shown.slice(0, 64))}`,
        },
        400,
      ),
    };
  }
  return { pair };
}

async function snapshot(url: URL, deps: CryptoRouteDeps): Promise<Response> {
  const b = basket(url);
  if ("error" in b) return b.error;
  const snapshots = await deps.client.getSnapshots(b.pairs);
  return json(
    {
      snapshots: snapshots.map((s) => ({ ...s, name: getPair(s.symbol)?.name, change: change(s) })),
      ...rejectedNote(b.rejected),
      disclaimer: CRYPTO_DISCLAIMER,
    },
    200,
    // Crypto ticks continuously; a short cache still deflects a hot loop.
    5,
  );
}

async function quote(url: URL, deps: CryptoRouteDeps): Promise<Response> {
  const b = basket(url);
  if ("error" in b) return b.error;
  const [trades, quotes] = await Promise.all([
    deps.client.getLatestTrades(b.pairs),
    deps.client.getLatestQuotes(b.pairs),
  ]);
  const tradeBy = new Map(trades.map((t) => [t.symbol, t]));
  const quoteBy = new Map(quotes.map((q) => [q.symbol, q]));

  return json(
    {
      quotes: b.pairs.map((symbol) => {
        const q = quoteBy.get(symbol);
        const spread = q ? q.askPrice - q.bidPrice : null;
        const mid = q ? (q.askPrice + q.bidPrice) / 2 : null;
        return {
          symbol,
          name: getPair(symbol)?.name,
          latestTrade: tradeBy.get(symbol),
          latestQuote: q,
          // Spread in basis points is the comparable liquidity read across
          // pairs priced from $0.00001 (SHIB) to $60k (BTC).
          spread,
          spreadBps: spread != null && mid ? round((spread / mid) * 10_000, 2) : null,
          mid: mid != null ? round(mid, 8) : null,
        };
      }),
      feed: "us",
      fetchedAt: new Date().toISOString(),
      ...rejectedNote(b.rejected),
      disclaimer: CRYPTO_DISCLAIMER,
    },
    200,
    5,
  );
}

async function bars(url: URL, deps: CryptoRouteDeps): Promise<Response> {
  const b = basket(url);
  if ("error" in b) return b.error;

  const timeframe = (url.searchParams.get("timeframe") ?? "1Day") as BarTimeframe;
  if (!VALID_TIMEFRAMES.includes(timeframe)) {
    return json(
      { error: `invalid timeframe "${timeframe}"`, valid: VALID_TIMEFRAMES },
      400,
    );
  }
  const limit = Math.min(10_000, Math.max(1, Number(url.searchParams.get("limit") ?? 1000) || 1000));
  const start = url.searchParams.get("start") ?? undefined;
  const end = url.searchParams.get("end") ?? undefined;

  const rows = await deps.client.getBars({ symbols: b.pairs, timeframe, start, end, limit });
  const grouped: Record<string, MarketBar[]> = {};
  for (const bar of rows) (grouped[bar.symbol] ??= []).push(bar);

  return json(
    {
      timeframe,
      start,
      end,
      count: rows.length,
      bars: grouped,
      ...rejectedNote(b.rejected),
      disclaimer: CRYPTO_DISCLAIMER,
    },
    200,
    // Closed bars never change; intraday ones do. 30s is safe for both.
    30,
  );
}

async function orderbook(url: URL, deps: CryptoRouteDeps): Promise<Response> {
  const b = basket(url);
  if ("error" in b) return b.error;
  const depth = Math.min(50, Math.max(1, Number(url.searchParams.get("depth") ?? 10) || 10));
  const books = await deps.client.getOrderbooks(b.pairs);
  return json(
    {
      orderbooks: books.map((ob) => ({
        ...ob,
        name: getPair(ob.symbol)?.name,
        bids: ob.bids.slice(0, depth),
        asks: ob.asks.slice(0, depth),
      })),
      ...rejectedNote(b.rejected),
      disclaimer: CRYPTO_DISCLAIMER,
    },
    200,
    // The book moves constantly — never serve a stale one from cache.
    0,
  );
}

/**
 * Compact close-price series, one per pair, for the grid cards.
 *
 * Deliberately not a variant of /crypto/bars: that returns full OHLCV and
 * paginates, and twelve cards do not need thousands of bar objects to draw
 * twelve lines a couple of hundred pixels wide.
 */
async function sparklineRoute(url: URL, deps: CryptoRouteDeps): Promise<Response> {
  if (!deps.sparklines) return json({ error: "sparklines unavailable" }, 503);
  const b = basket(url);
  if ("error" in b) return b.error;

  const requested = url.searchParams.get("period") ?? "24h";
  if (!isSparkPeriod(requested)) {
    return json({ error: `invalid period "${requested}"`, valid: SPARK_PERIODS }, 400);
  }

  const series = await deps.sparklines.get(b.pairs, requested);
  return json(
    {
      period: requested,
      // Only pairs with a drawable line appear. A card omits its chart rather
      // than drawing a flat line from a single observation.
      series: Object.fromEntries(
        b.pairs.flatMap((symbol) => {
          const s = series.get(symbol);
          return s ? [[symbol, s] as const] : [];
        }),
      ),
      ...rejectedNote(b.rejected),
      disclaimer: CRYPTO_DISCLAIMER,
    },
    200,
    // Matches the service's own cache, so an edge hit and a process hit agree.
    requested === "24h" ? 60 : 300,
  );
}

async function technicals(url: URL, deps: CryptoRouteDeps): Promise<Response> {
  const s = single(url.searchParams.get("symbol"));
  if ("error" in s) return s.error;
  const horizon = Number(url.searchParams.get("horizon")) === 1 ? 1 : 2;
  const computed = await computeTechnicals(s.pair, horizon, deps);
  if (!computed) {
    return json(
      { symbol: s.pair, error: "not enough history to compute indicators", bars: 0 },
      200,
      60,
    );
  }
  return json({ symbol: s.pair, ...computed, disclaimer: CRYPTO_DISCLAIMER }, 200, 60);
}

async function report(
  rawSymbol: string | null,
  url: URL,
  deps: CryptoRouteDeps,
): Promise<Response> {
  const s = single(rawSymbol);
  if ("error" in s) return s.error;
  const pair = getPair(s.pair)!;
  const horizon = Number(url.searchParams.get("horizon")) === 1 ? 1 : 2;

  // One round of upstream calls covers every part of the report. Fundamentals
  // come from a different vendor and must not be able to fail the response.
  const [snapshots, computed, funds] = await Promise.all([
    deps.client.getSnapshots([s.pair]),
    computeTechnicals(s.pair, horizon, deps),
    deps.fundamentals ? deps.fundamentals.get(pair.base) : Promise.resolve(null),
  ]);
  const snap = snapshots[0];

  return json(
    {
      symbol: pair.symbol,
      slug: pair.slug,
      name: pair.name,
      base: pair.base,
      quote: pair.quote,
      snapshot: snap ? { ...snap, change: change(snap) } : undefined,
      technical: computed?.indicators,
      technicalScore: computed?.score,
      // Sourced from CoinGecko, not the market-data feed — flagged so a
      // consumer never has to guess which vendor a number came from.
      fundamentals: funds ? { ...funds, source: "coingecko" } : null,
      caveats: computed?.caveats,
      generatedAt: new Date().toISOString(),
      disclaimer: CRYPTO_DISCLAIMER,
    },
    200,
    30,
  );
}

/* ---- Pages --------------------------------------------------------------
   Rendered server-side so a link is shareable: pasted into a chat, crawled,
   or previewed without running any JavaScript. The interactive chart in the
   app is a progressive enhancement, not the only way to see this. */

/** `/crypto` — the pair directory as a page. */
async function indexPage(deps: CryptoRouteDeps): Promise<Response> {
  // Prices make the index worth loading, but one dead upstream must not cost
  // us the page: fall back to a plain list rather than an error.
  let prices = new Map<string, { price: number; changePct: number | null }>();
  try {
    const majors = SUPPORTED_PAIRS.filter((p) => p.quote === "USD").slice(0, MAX_BASKET);
    const snaps = await deps.client.getSnapshots(majors.map((p) => p.symbol));
    for (const s of snaps) {
      const price = s.latestTrade?.price ?? s.dailyBar?.close;
      const prev = s.prevDailyBar?.close;
      if (price != null) {
        prices.set(s.symbol, {
          price,
          changePct: prev ? ((price - prev) / prev) * 100 : null,
        });
      }
    }
  } catch {
    /* listed without prices */
  }
  return htmlResponse(
    renderCryptoIndexPage(SUPPORTED_PAIRS, prices, { appUrl: deps.appUrl }),
    200,
    30,
  );
}

/** `/crypto/<PAIR>` — one pair as a shareable page. */
async function pairPage(raw: string, deps: CryptoRouteDeps): Promise<Response> {
  const symbol = normalizePair(raw);
  if (!symbol) {
    const suggestion = raw ? lookupPairs(raw, 1)[0] : undefined;
    return htmlResponse(
      renderMissingCryptoPage(raw.slice(0, 32) || "—", suggestion, { appUrl: deps.appUrl }),
      404,
    );
  }
  const pair = getPair(symbol)!;
  // Canonicalize so /crypto/btc, /crypto/BTC and /crypto/BTC-USD are one page
  // rather than three competing for the same content.
  if (raw !== pair.slug) {
    return Response.redirect(`${deps.appUrl.replace(/\/$/, "")}/crypto/${pair.slug}`, 301);
  }

  // 400 days covers the technical windows; a year of history also backs the
  // 1-year performance figure.
  const start = new Date(Date.now() - TECHNICAL_LOOKBACK_DAYS * 86_400_000).toISOString();
  let snapshot: Awaited<ReturnType<typeof deps.client.getSnapshots>>[number] | undefined;
  let bars: MarketBar[] = [];
  let orderbook: Awaited<ReturnType<typeof deps.client.getOrderbooks>>[number] | undefined;
  let marketError: string | undefined;
  try {
    const [snaps, rows] = await Promise.all([
      deps.client.getSnapshots([symbol]),
      deps.client.getBars({ symbols: [symbol], timeframe: "1Day", start, end: new Date().toISOString() }),
    ]);
    snapshot = snaps[0];
    bars = rows;
  } catch (err) {
    // Degrade to whatever we have rather than 502 the whole page.
    marketError = String(err).slice(0, 200);
  }
  // Both of these are nice-to-haves from sources other than the page's own
  // feed, so neither may take the page down with it. `get` already swallows
  // its own failures; the book gets an explicit guard.
  let fundamentals: Awaited<ReturnType<CryptoFundamentalsClient["get"]>> = null;
  const [bookResult, fundamentalsResult] = await Promise.allSettled([
    deps.client.getOrderbooks([symbol]),
    deps.fundamentals ? deps.fundamentals.get(pair.base) : Promise.resolve(null),
  ]);
  if (bookResult.status === "fulfilled") [orderbook] = bookResult.value;
  if (fundamentalsResult.status === "fulfilled") fundamentals = fundamentalsResult.value;

  const technical = bars.length >= 2 ? calculateIndicators(bars, deps.indicators) : undefined;
  const technicalScore = technical ? scoreTechnicalSetup(technical, 2) : undefined;

  return htmlResponse(
    renderCryptoPage(
      {
        pair,
        snapshot,
        bars,
        technical,
        technicalScore,
        analysis: analyzeCrypto(pair.symbol, pair.name, technical, technicalScore),
        performance: computePerformance(bars),
        fundamentals,
        orderbook,
        caveats: SCORE_CAVEATS,
        fetchedAt: new Date().toISOString(),
        marketError,
      },
      { appUrl: deps.appUrl },
    ),
    200,
    30,
  );
}

/** Daily bars -> deterministic indicators + score. Null when history is too thin. */
async function computeTechnicals(
  pair: string,
  horizon: 1 | 2,
  deps: CryptoRouteDeps,
): Promise<{
  indicators: ReturnType<typeof calculateIndicators>;
  score: ReturnType<typeof scoreTechnicalSetup>;
  bars: number;
  caveats: readonly string[];
} | null> {
  const start = new Date(Date.now() - TECHNICAL_LOOKBACK_DAYS * 86_400_000).toISOString();
  const rows = await deps.client.getBars({
    symbols: [pair],
    timeframe: "1Day",
    start,
    end: new Date().toISOString(),
  });
  // Below this the indicator engine returns mostly nulls; say "not enough
  // history" rather than emit a report that looks computed but is empty.
  if (rows.length < 2) return null;
  const indicators = calculateIndicators(rows, deps.indicators);
  return {
    indicators,
    score: scoreTechnicalSetup(indicators, horizon),
    bars: rows.length,
    caveats: SCORE_CAVEATS,
  };
}

/**
 * The scoring engine is shared with equities, and two of its components do not
 * carry the same meaning here. Saying so beside the number is the point: a
 * liquidity component reading 0 because Alpaca reports only its own venue's
 * volume is not the same finding as a genuinely illiquid asset.
 */
const SCORE_CAVEATS = [
  "Volume, relativeVolume and avgDollarVolume reflect Alpaca's US crypto venue alone, not aggregate market volume — the liquidity component of the score is not comparable to an equity's.",
  "52-week and moving-average windows count calendar days: crypto trades 24/7, so a 200-day window here spans less market activity per bar than 200 equity sessions.",
];

/** Session change from the previous daily close — the number a dashboard shows. */
function change(s: { dailyBar?: MarketBar; prevDailyBar?: MarketBar; latestTrade?: { price: number } }) {
  const last = s.latestTrade?.price ?? s.dailyBar?.close;
  const prev = s.prevDailyBar?.close;
  if (last == null || prev == null || prev === 0) return null;
  return { absolute: round(last - prev, 8), percent: round(((last - prev) / prev) * 100, 4) };
}

function round(n: number, dp: number): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}
