/**
 * Yahoo Finance market-data client (keyless fallback).
 *
 * Implements the same interface as the Alpaca client so the pipeline is
 * source-agnostic. Used automatically when Alpaca credentials are absent, so
 * pricing, technical indicators, and charts work out of the box. Data is
 * end-of-day and delayed; provenance is tagged feed="yahoo", delayed=true so it
 * is never silently confused with real-time Alpaca data (PRD §7.3, §12.5, §27).
 */
import type {
  AlpacaAsset,
  BarsRequest,
  CalendarRequest,
  LatestQuote,
  LatestTrade,
  MarketBar,
  MarketSession,
  MarketSnapshot,
} from "../types.ts";
import type { AlpacaMarketDataClient } from "./interfaces.ts";

const BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const UA = "Mozilla/5.0 (advis0r.com research)";

interface YahooChart {
  timestamp?: number[];
  closes: (number | null)[];
  opens: (number | null)[];
  highs: (number | null)[];
  lows: (number | null)[];
  volumes: (number | null)[];
  meta: any;
}

function tfToInterval(tf: MarketBar["timeframe"]): string {
  switch (tf) {
    case "1Min": return "1m";
    case "5Min": return "5m";
    case "15Min": return "15m";
    case "1Hour": return "60m";
    case "1Week": return "1wk";
    default: return "1d";
  }
}

export class YahooMarketDataClient implements AlpacaMarketDataClient {
  private async chart(
    symbol: string,
    opts: { interval?: string; range?: string; start?: string; end?: string } = {},
  ): Promise<YahooChart | null> {
    const params = new URLSearchParams();
    params.set("interval", opts.interval ?? "1d");
    if (opts.start || opts.end) {
      params.set("period1", String(Math.floor(Date.parse(opts.start ?? "1970-01-01") / 1000)));
      params.set("period2", String(Math.floor((opts.end ? Date.parse(opts.end) : Date.now()) / 1000) + 86400));
    } else {
      params.set("range", opts.range ?? "1y");
    }
    const res = await fetch(`${BASE}/${encodeURIComponent(symbol)}?${params}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = (await res.json()) as any;
    const r = body?.chart?.result?.[0];
    if (!r) return null;
    const q = r.indicators?.quote?.[0] ?? {};
    return {
      timestamp: r.timestamp ?? [],
      closes: q.close ?? [],
      opens: q.open ?? [],
      highs: q.high ?? [],
      lows: q.low ?? [],
      volumes: q.volume ?? [],
      meta: r.meta ?? {},
    };
  }

  async getBars(request: BarsRequest): Promise<MarketBar[]> {
    const interval = tfToInterval(request.timeframe);
    const out: MarketBar[] = [];
    for (const symbol of request.symbols) {
      const c = await this.chart(symbol, { interval, start: request.start, end: request.end });
      if (!c?.timestamp) continue;
      for (let i = 0; i < c.timestamp.length; i++) {
        const close = c.closes[i];
        if (close == null) continue; // skip null/holiday bars (PRD §12.5)
        out.push({
          symbol,
          timestamp: new Date(c.timestamp[i]! * 1000).toISOString(),
          open: c.opens[i] ?? close,
          high: c.highs[i] ?? close,
          low: c.lows[i] ?? close,
          close,
          volume: c.volumes[i] ?? 0,
          timeframe: request.timeframe,
          adjustment: request.adjustment ?? "all",
        });
      }
      if (request.limit && out.length > request.limit) {
        out.splice(0, out.length - request.limit);
      }
    }
    return out;
  }

  async getSnapshots(symbols: string[]): Promise<MarketSnapshot[]> {
    const fetchedAt = new Date().toISOString();
    const snaps: MarketSnapshot[] = [];
    for (const symbol of symbols) {
      const c = await this.chart(symbol, { range: "5d", interval: "1d" });
      if (!c) continue;
      const meta = c.meta ?? {};
      const closes = c.closes.filter((x): x is number => x != null);
      const last = meta.regularMarketPrice ?? closes.at(-1);
      const prev = meta.chartPreviousClose ?? meta.previousClose ?? closes.at(-2);
      const ts = c.timestamp?.at(-1);
      snaps.push({
        symbol,
        latestTrade: last != null ? { symbol, price: last, size: 0, timestamp: fetchedAt } : undefined,
        dailyBar:
          last != null
            ? {
                symbol,
                timestamp: ts ? new Date(ts * 1000).toISOString() : fetchedAt,
                open: c.opens.at(-1) ?? last,
                high: meta.regularMarketDayHigh ?? c.highs.at(-1) ?? last,
                low: meta.regularMarketDayLow ?? c.lows.at(-1) ?? last,
                close: last,
                volume: meta.regularMarketVolume ?? c.volumes.at(-1) ?? 0,
                timeframe: "1Day",
                adjustment: "all",
              }
            : undefined,
        prevDailyBar:
          prev != null
            ? { symbol, timestamp: fetchedAt, open: prev, high: prev, low: prev, close: prev, volume: 0, timeframe: "1Day", adjustment: "all" }
            : undefined,
        feed: "yahoo",
        delayed: true,
        fetchedAt,
      });
    }
    return snaps;
  }

  async getLatestTrades(symbols: string[]): Promise<LatestTrade[]> {
    const snaps = await this.getSnapshots(symbols);
    return snaps.flatMap((s) => (s.latestTrade ? [s.latestTrade] : []));
  }

  async getLatestQuotes(symbols: string[]): Promise<LatestQuote[]> {
    // Yahoo chart endpoint has no bid/ask; return best-effort mid = last.
    const snaps = await this.getSnapshots(symbols);
    return snaps.flatMap((s) => {
      const p = s.latestTrade?.price;
      return p != null
        ? [{ symbol: s.symbol, bidPrice: p, bidSize: 0, askPrice: p, askSize: 0, timestamp: s.fetchedAt }]
        : [];
    });
  }

  async getAssets(symbols?: string[]): Promise<AlpacaAsset[]> {
    if (!symbols?.length) return [];
    const out: AlpacaAsset[] = [];
    for (const symbol of symbols) {
      const c = await this.chart(symbol, { range: "5d", interval: "1d" });
      const meta = c?.meta ?? {};
      out.push({
        symbol,
        name: meta.longName ?? meta.shortName ?? symbol,
        exchange: normalizeExchange(meta.fullExchangeName ?? meta.exchangeName ?? ""),
        assetClass: "us_equity",
        tradable: true,
        status: "active",
      });
    }
    return out;
  }

  async getCalendar(_request: CalendarRequest): Promise<MarketSession[]> {
    return [];
  }
}

function normalizeExchange(name: string): string {
  const n = name.toUpperCase();
  if (n.includes("NASDAQ")) return "NASDAQ";
  if (n.includes("NYSE ARCA")) return "ARCA";
  if (n.includes("NYSE")) return "NYSE";
  if (n.includes("AMEX") || n.includes("NYSE AMERICAN")) return "AMEX";
  if (n.includes("OTC") || n.includes("PINK")) return "OTC";
  return name || "";
}
