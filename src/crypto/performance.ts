/**
 * Crypto's view of the shared performance calculator.
 *
 * The implementation moved to `src/market/performance.ts` when the equity
 * watchlist needed the same per-period changes and 52-week extremes. This file
 * stays as the crypto-facing name so the pair page and its tests keep reading
 * the way they did.
 */
import { CRYPTO_PERIODS, computePerformance as compute, type PricePerformance } from "../market/performance.ts";
import type { MarketBar } from "../types.ts";

export type { PeriodChange } from "../market/performance.ts";
export type CryptoPerformance = PricePerformance;

/** `bars` must be chronological. See the shared implementation for the rules. */
export function computePerformance(bars: MarketBar[]): CryptoPerformance {
  return compute(bars, CRYPTO_PERIODS);
}
