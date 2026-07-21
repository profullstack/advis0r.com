/**
 * Alpaca Market Data client (PRD §7.3, §7.4).
 *
 * The REQUIRED source for all technical/price data. Every response is tagged
 * with provenance (feed, delayed flag, fetchedAt, request id) so downstream
 * analysis is reproducible and never mixes real-time with delayed data
 * silently.
 */
import type { AppConfig } from "../config.ts";
import type {
  AlpacaAsset,
  AlpacaFeed,
  BarsRequest,
  CalendarRequest,
  LatestQuote,
  LatestTrade,
  MarketBar,
  MarketSession,
  MarketSnapshot,
} from "../types.ts";
import type { AlpacaMarketDataClient } from "./interfaces.ts";

const TRADING_BASE = "https://api.alpaca.markets";

export class AlpacaClient implements AlpacaMarketDataClient {
  private readonly dataUrl: string;
  private readonly keyId: string;
  private readonly secret: string;
  private readonly feed: AlpacaFeed;
  private readonly adjustment: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(config: AppConfig) {
    this.dataUrl = config.alpaca.dataUrl.replace(/\/$/, "");
    this.keyId = config.secrets.alpacaKeyId;
    this.secret = config.secrets.alpacaSecretKey;
    this.feed = config.alpaca.feed;
    this.adjustment = config.alpaca.adjustment;
    this.timeoutMs = config.alpaca.requestTimeoutMs;
    this.maxRetries = config.alpaca.maxRetries;
  }

  private headers(): Record<string, string> {
    if (!this.keyId || !this.secret) {
      throw new Error(
        "Alpaca credentials missing. Set APCA_API_KEY_ID and APCA_API_SECRET_KEY.",
      );
    }
    return {
      "APCA-API-KEY-ID": this.keyId,
      "APCA-API-SECRET-KEY": this.secret,
      Accept: "application/json",
    };
  }

  private async request(
    base: string,
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<{ body: any; requestId?: string }> {
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    let lastErr: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          headers: this.headers(),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        const requestId = res.headers.get("x-request-id") ?? undefined;
        if (res.status === 429 || res.status >= 500) {
          throw new Error(`Alpaca ${res.status} (retryable)`);
        }
        if (!res.ok) {
          throw new Error(`Alpaca ${res.status}: ${await res.text()}`);
        }
        return { body: await res.json(), requestId };
      } catch (err) {
        lastErr = err;
        if (attempt < this.maxRetries) {
          await sleep(250 * 2 ** attempt);
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private get delayed(): boolean {
    // The IEX free feed is delayed relative to SIP consolidated tape.
    return this.feed !== "sip";
  }

  async getSnapshots(symbols: string[]): Promise<MarketSnapshot[]> {
    if (symbols.length === 0) return [];
    const { body, requestId } = await this.request(
      this.dataUrl,
      "/v2/stocks/snapshots",
      { symbols: symbols.join(","), feed: this.feed },
    );
    const fetchedAt = nowIso();
    const snapshots: Record<string, any> = body.snapshots ?? body ?? {};
    return symbols.map((symbol) => {
      const s = snapshots[symbol] ?? {};
      return {
        symbol,
        latestTrade: s.latestTrade
          ? {
              symbol,
              price: s.latestTrade.p,
              size: s.latestTrade.s,
              timestamp: s.latestTrade.t,
            }
          : undefined,
        latestQuote: s.latestQuote
          ? {
              symbol,
              bidPrice: s.latestQuote.bp,
              bidSize: s.latestQuote.bs,
              askPrice: s.latestQuote.ap,
              askSize: s.latestQuote.as,
              timestamp: s.latestQuote.t,
            }
          : undefined,
        dailyBar: s.dailyBar ? toBar(symbol, s.dailyBar, "1Day", this.adjustment) : undefined,
        prevDailyBar: s.prevDailyBar
          ? toBar(symbol, s.prevDailyBar, "1Day", this.adjustment)
          : undefined,
        feed: this.feed,
        delayed: this.delayed,
        fetchedAt,
        requestId,
      } satisfies MarketSnapshot;
    });
  }

  async getLatestTrades(symbols: string[]): Promise<LatestTrade[]> {
    if (symbols.length === 0) return [];
    const { body } = await this.request(this.dataUrl, "/v2/stocks/trades/latest", {
      symbols: symbols.join(","),
      feed: this.feed,
    });
    const trades = body.trades ?? {};
    return Object.entries(trades).map(([symbol, t]: [string, any]) => ({
      symbol,
      price: t.p,
      size: t.s,
      timestamp: t.t,
    }));
  }

  async getLatestQuotes(symbols: string[]): Promise<LatestQuote[]> {
    if (symbols.length === 0) return [];
    const { body } = await this.request(this.dataUrl, "/v2/stocks/quotes/latest", {
      symbols: symbols.join(","),
      feed: this.feed,
    });
    const quotes = body.quotes ?? {};
    return Object.entries(quotes).map(([symbol, q]: [string, any]) => ({
      symbol,
      bidPrice: q.bp,
      bidSize: q.bs,
      askPrice: q.ap,
      askSize: q.as,
      timestamp: q.t,
    }));
  }

  async getBars(request: BarsRequest): Promise<MarketBar[]> {
    const out: MarketBar[] = [];
    const feed = request.feed ?? this.feed;
    const adjustment = request.adjustment ?? this.adjustment;
    for (const symbol of request.symbols) {
      let pageToken: string | undefined;
      do {
        const { body }: { body: any } = await this.request(
          this.dataUrl,
          `/v2/stocks/${encodeURIComponent(symbol)}/bars`,
          {
            timeframe: request.timeframe,
            start: request.start,
            end: request.end,
            limit: request.limit ?? 10000,
            adjustment,
            feed,
            page_token: pageToken,
          },
        );
        for (const b of body.bars ?? []) {
          out.push(toBar(symbol, b, request.timeframe, adjustment));
        }
        pageToken = body.next_page_token ?? undefined;
      } while (pageToken);
    }
    return out;
  }

  async getAssets(symbols?: string[]): Promise<AlpacaAsset[]> {
    // Asset metadata lives on the trading API, not the data API.
    const { body } = await this.request(TRADING_BASE, "/v2/assets", {
      status: "active",
      asset_class: "us_equity",
    });
    const list: AlpacaAsset[] = (body as any[]).map((a) => ({
      symbol: a.symbol,
      name: a.name,
      exchange: a.exchange,
      assetClass: a.class,
      tradable: a.tradable,
      status: a.status,
      fractionable: a.fractionable,
    }));
    if (symbols?.length) {
      const set = new Set(symbols);
      return list.filter((a) => set.has(a.symbol));
    }
    return list;
  }

  async getCalendar(request: CalendarRequest): Promise<MarketSession[]> {
    const { body } = await this.request(TRADING_BASE, "/v2/calendar", {
      start: request.start,
      end: request.end,
    });
    return (body as any[]).map((c) => ({
      date: c.date,
      open: c.open,
      close: c.close,
      sessionOpen: c.session_open ?? c.open,
      sessionClose: c.session_close ?? c.close,
    }));
  }
}

function toBar(
  symbol: string,
  b: any,
  timeframe: MarketBar["timeframe"],
  adjustment: string,
): MarketBar {
  return {
    symbol,
    timestamp: b.t,
    open: b.o,
    high: b.h,
    low: b.l,
    close: b.c,
    volume: b.v,
    vwap: b.vw,
    timeframe,
    adjustment: adjustment as MarketBar["adjustment"],
  };
}

function nowIso(): string {
  return new Date().toISOString();
}
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
