/**
 * Alpaca Crypto Market Data client (v1beta3, `/crypto/us`).
 *
 * This adds crypto to advis0r without adding a vendor: it is the SAME Alpaca
 * account the equity side already uses (APCA_API_KEY_ID / APCA_API_SECRET_KEY),
 * and crypto data carries no extra subscription. The endpoint also answers
 * unauthenticated, so /api/crypto/** keeps working on a deployment where the
 * Alpaca keys are absent, expired, or rate-limited — credentials are sent when
 * present and simply omitted when not.
 *
 * That keyless path is why there is no Yahoo-style fallback here: the primary
 * source degrades to itself rather than to a second vendor with different
 * provenance.
 *
 * Crypto trades 24/7, so unlike equities there is no delayed/consolidated-tape
 * distinction: every response is tagged feed "us", delayed false.
 */
import type { AdjustmentMode, BarTimeframe, LatestQuote, LatestTrade, MarketBar } from "../types.ts";

const DEFAULT_DATA_URL = "https://data.alpaca.markets";
const CRYPTO_PREFIX = "/v1beta3/crypto/us";

/** Crypto bars are never split/dividend adjusted. */
const CRYPTO_ADJUSTMENT: AdjustmentMode = "raw";

export interface CryptoSnapshot {
  symbol: string;
  base: string;
  quote: string;
  latestTrade?: LatestTrade;
  latestQuote?: LatestQuote;
  minuteBar?: MarketBar;
  dailyBar?: MarketBar;
  prevDailyBar?: MarketBar;
  /** Provenance, mirroring MarketSnapshot (PRD §7.3). */
  feed: "us";
  delayed: false;
  fetchedAt: string;
  requestId?: string;
}

export interface CryptoOrderbook {
  symbol: string;
  timestamp: string;
  bids: Array<{ price: number; size: number }>;
  asks: Array<{ price: number; size: number }>;
}

export interface CryptoBarsRequest {
  symbols: string[];
  timeframe: BarTimeframe;
  start?: string;
  end?: string;
  limit?: number;
}

export interface CryptoClientOptions {
  dataUrl?: string;
  keyId?: string;
  secretKey?: string;
  requestTimeoutMs?: number;
  maxRetries?: number;
}

class NonRetryableError extends Error {}

export class AlpacaCryptoClient {
  private readonly dataUrl: string;
  private readonly keyId: string;
  private readonly secret: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;

  constructor(options: CryptoClientOptions = {}) {
    this.dataUrl = (options.dataUrl || DEFAULT_DATA_URL).replace(/\/$/, "");
    this.keyId = options.keyId ?? "";
    this.secret = options.secretKey ?? "";
    this.timeoutMs = options.requestTimeoutMs ?? 15_000;
    this.maxRetries = options.maxRetries ?? 2;
  }

  /** True when requests are signed. Reported by /api/crypto so the auth mode is never a mystery. */
  get authenticated(): boolean {
    return Boolean(this.keyId && this.secret);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { Accept: "application/json" };
    // Unlike the equity client this never throws on missing credentials — the
    // crypto feed is public, and a keyless deployment is a supported mode.
    if (this.authenticated) {
      h["APCA-API-KEY-ID"] = this.keyId;
      h["APCA-API-SECRET-KEY"] = this.secret;
    }
    return h;
  }

  private async request(
    path: string,
    params: Record<string, string | number | undefined> = {},
  ): Promise<{ body: any; requestId?: string }> {
    const url = new URL(this.dataUrl + CRYPTO_PREFIX + path);
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
          throw new Error(`Alpaca crypto ${res.status} (retryable)`);
        }
        if (!res.ok) {
          throw new NonRetryableError(
            `Alpaca crypto ${res.status}: ${(await res.text()).slice(0, 200)}`,
          );
        }
        return { body: await res.json(), requestId };
      } catch (err) {
        lastErr = err;
        if (err instanceof NonRetryableError) break;
        if (attempt < this.maxRetries) await sleep(250 * 2 ** attempt);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  async getSnapshots(symbols: string[]): Promise<CryptoSnapshot[]> {
    if (symbols.length === 0) return [];
    const { body, requestId } = await this.request("/snapshots", {
      symbols: symbols.join(","),
    });
    const fetchedAt = nowIso();
    const snapshots: Record<string, any> = body.snapshots ?? {};
    // Map over the REQUESTED symbols, not the response keys: an unknown pair
    // then comes back as an explicitly empty entry instead of vanishing.
    return symbols.map((symbol) => {
      const s = snapshots[symbol] ?? {};
      const [base = symbol, quote = ""] = symbol.split("/");
      return {
        symbol,
        base,
        quote,
        latestTrade: toTrade(symbol, s.latestTrade),
        latestQuote: toQuote(symbol, s.latestQuote),
        minuteBar: toBar(symbol, s.minuteBar, "1Min"),
        dailyBar: toBar(symbol, s.dailyBar, "1Day"),
        prevDailyBar: toBar(symbol, s.prevDailyBar, "1Day"),
        feed: "us",
        delayed: false,
        fetchedAt,
        requestId,
      } satisfies CryptoSnapshot;
    });
  }

  async getLatestTrades(symbols: string[]): Promise<LatestTrade[]> {
    if (symbols.length === 0) return [];
    const { body } = await this.request("/latest/trades", { symbols: symbols.join(",") });
    return Object.entries(body.trades ?? {})
      .map(([symbol, t]) => toTrade(symbol, t))
      .filter((t): t is LatestTrade => Boolean(t));
  }

  async getLatestQuotes(symbols: string[]): Promise<LatestQuote[]> {
    if (symbols.length === 0) return [];
    const { body } = await this.request("/latest/quotes", { symbols: symbols.join(",") });
    return Object.entries(body.quotes ?? {})
      .map(([symbol, q]) => toQuote(symbol, q))
      .filter((q): q is LatestQuote => Boolean(q));
  }

  async getOrderbooks(symbols: string[]): Promise<CryptoOrderbook[]> {
    if (symbols.length === 0) return [];
    const { body } = await this.request("/latest/orderbooks", { symbols: symbols.join(",") });
    return Object.entries(body.orderbooks ?? {}).map(([symbol, ob]: [string, any]) => ({
      symbol,
      timestamp: ob?.t ?? nowIso(),
      bids: (ob?.b ?? []).map((l: any) => ({ price: l.p, size: l.s })),
      asks: (ob?.a ?? []).map((l: any) => ({ price: l.p, size: l.s })),
    }));
  }

  /**
   * Historical bars. The crypto endpoint is multi-symbol (one request covers
   * the whole basket) and paginates with `next_page_token`.
   */
  async getBars(request: CryptoBarsRequest): Promise<MarketBar[]> {
    if (request.symbols.length === 0) return [];
    const out: MarketBar[] = [];
    let pageToken: string | undefined;
    do {
      const { body }: { body: any } = await this.request("/bars", {
        symbols: request.symbols.join(","),
        timeframe: request.timeframe,
        start: request.start,
        end: request.end,
        limit: request.limit ?? 10_000,
        page_token: pageToken,
      });
      for (const [symbol, bars] of Object.entries(body.bars ?? {})) {
        for (const b of (bars as any[]) ?? []) {
          const bar = toBar(symbol, b, request.timeframe);
          if (bar) out.push(bar);
        }
      }
      pageToken = body.next_page_token ?? undefined;
    } while (pageToken);
    // Alpaca returns per-symbol groups; sort so a single-symbol series is
    // chronological, which is what the indicator engine expects.
    return out.sort(
      (a, b) => a.symbol.localeCompare(b.symbol) || a.timestamp.localeCompare(b.timestamp),
    );
  }
}

function toBar(symbol: string, b: any, timeframe: BarTimeframe): MarketBar | undefined {
  if (!b || typeof b.c !== "number") return undefined;
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
    adjustment: CRYPTO_ADJUSTMENT,
  };
}

function toTrade(symbol: string, t: any): LatestTrade | undefined {
  if (!t || typeof t.p !== "number") return undefined;
  return { symbol, price: t.p, size: t.s, timestamp: t.t };
}

function toQuote(symbol: string, q: any): LatestQuote | undefined {
  if (!q || typeof q.bp !== "number") return undefined;
  return {
    symbol,
    bidPrice: q.bp,
    bidSize: q.bs,
    askPrice: q.ap,
    askSize: q.as,
    timestamp: q.t,
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
