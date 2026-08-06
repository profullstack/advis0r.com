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
import { SUPPORTED_PAIRS, getPair, lookupPairs, normalizePair, normalizePairs } from "./pairs.ts";

const json = (body: unknown, status = 200, cacheSeconds = 0) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
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
]);

export interface CryptoRouteDeps {
  client: AlpacaCryptoClient;
  indicators: IndicatorConfig;
}

/**
 * Returns null when `path` is not a crypto route, so the caller falls through
 * to its other handlers.
 */
export async function handleCryptoRoute(
  req: Request,
  path: string,
  deps: CryptoRouteDeps,
): Promise<Response | null> {
  const rest = cryptoSubPath(path);
  if (rest === null) return null;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  try {
    switch (rest) {
      case "":
        return index(deps);
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
      case "report":
        return await report(url.searchParams.get("symbol"), url, deps);
    }
    // /crypto/<PAIR> — the shareable path form of /crypto/report.
    return await report(rest, url, deps);
  } catch (err) {
    // Upstream failures are the expected error here; surface them as 502 with
    // the reason rather than a bare 500 that hides whether it was us or Alpaca.
    return json(
      { error: "crypto market data unavailable", detail: String(err).slice(0, 300) },
      502,
    );
  }
}

/**
 * "/api/crypto/bars" -> "bars"; "/crypto" -> ""; anything else -> null.
 * Case-insensitive and tolerant of a trailing slash.
 */
function cryptoSubPath(path: string): string | null {
  for (const prefix of ["/api/crypto", "/crypto"]) {
    if (path === prefix || path === `${prefix}/`) return "";
    if (path.startsWith(`${prefix}/`)) {
      const rest = path.slice(prefix.length + 1).replace(/\/$/, "");
      // Only a single segment is a crypto route; deeper paths are not ours.
      return rest.includes("/") ? null : rest;
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

  // One round of upstream calls covers both halves of the report.
  const [snapshots, computed] = await Promise.all([
    deps.client.getSnapshots([s.pair]),
    computeTechnicals(s.pair, horizon, deps),
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
      caveats: computed?.caveats,
      generatedAt: new Date().toISOString(),
      disclaimer: CRYPTO_DISCLAIMER,
    },
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
