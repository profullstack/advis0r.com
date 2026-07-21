/**
 * Resilient market-data client: try the primary source (Alpaca), fall back to
 * a secondary (Yahoo) on error or empty result.
 *
 * This means invalid/expired/rate-limited Alpaca credentials degrade gracefully
 * to the keyless source instead of breaking pricing/technicals entirely. Each
 * response still carries its own provenance (snapshot.feed), so the true source
 * of any datum is never ambiguous (PRD §7.3, §12.5).
 */
import type {
  AlpacaAsset,
  BarsRequest,
  CalendarRequest,
  LatestQuote,
  LatestTrade,
  MarketSession,
  MarketSnapshot,
} from "../types.ts";
import type { AlpacaMarketDataClient } from "./interfaces.ts";

export class FallbackMarketDataClient implements AlpacaMarketDataClient {
  private primaryHealthy = true;

  constructor(
    private primary: AlpacaMarketDataClient,
    private fallback: AlpacaMarketDataClient,
    private onFallback?: (op: string, err: unknown) => void,
  ) {}

  private async race<T>(op: string, run: (c: AlpacaMarketDataClient) => Promise<T>, empty: (v: T) => boolean): Promise<T> {
    if (this.primaryHealthy) {
      try {
        const v = await run(this.primary);
        if (!empty(v)) return v;
      } catch (err) {
        this.primaryHealthy = false; // stop hammering a dead/invalid primary
        this.onFallback?.(op, err);
      }
    }
    return run(this.fallback);
  }

  getSnapshots(symbols: string[]): Promise<MarketSnapshot[]> {
    return this.race("getSnapshots", (c) => c.getSnapshots(symbols), (v) => v.length === 0);
  }
  getLatestTrades(symbols: string[]): Promise<LatestTrade[]> {
    return this.race("getLatestTrades", (c) => c.getLatestTrades(symbols), (v) => v.length === 0);
  }
  getLatestQuotes(symbols: string[]): Promise<LatestQuote[]> {
    return this.race("getLatestQuotes", (c) => c.getLatestQuotes(symbols), (v) => v.length === 0);
  }
  getBars(request: BarsRequest): Promise<import("../types.ts").MarketBar[]> {
    return this.race("getBars", (c) => c.getBars(request), (v) => v.length === 0);
  }
  getAssets(symbols?: string[]): Promise<AlpacaAsset[]> {
    // Assets are metadata-only; never treat empty as failure worth falling back.
    return this.race("getAssets", (c) => c.getAssets(symbols), () => false);
  }
  getCalendar(request: CalendarRequest): Promise<MarketSession[]> {
    return this.race("getCalendar", (c) => c.getCalendar(request), () => false);
  }
}
