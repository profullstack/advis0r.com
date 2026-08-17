/**
 * Multi-period price performance, computed from daily bars that were already
 * fetched for something else — no extra upstream call, no second vendor.
 *
 * Written for the crypto pair page, moved here when the watchlist needed the
 * same numbers per row. The only thing that differs between the two callers is
 * which periods they name, so that is the parameter.
 *
 * Deliberately NOT here: market capitalisation, shares outstanding and
 * all-time high. A market-data API does not carry them, and deriving them would
 * mean either inventing a figure or mixing in a vendor with its own provenance.
 * An absent field is better than a wrong one.
 */
import type { MarketBar } from "../types.ts";

export interface PeriodSpec {
  label: string;
  /** Calendar days back. */
  days: number;
}

export interface PeriodChange extends PeriodSpec {
  percent: number | null;
  /** The close this was measured against, so the number is checkable. */
  from: number | null;
}

export interface PricePerformance {
  changes: PeriodChange[];
  high52: number | null;
  low52: number | null;
  high52At: string | null;
  low52At: string | null;
  /** Volume over the last session, in quote currency. */
  volumeQuote: number | null;
  /** How many daily bars backed this, so a thin history is visible. */
  barCount: number;
}

/** What a 24/7 asset is asked for. */
export const CRYPTO_PERIODS: readonly PeriodSpec[] = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
];

/** What a watchlist row is asked for — same windows, market convention. */
export const EQUITY_PERIODS: readonly PeriodSpec[] = [
  { label: "1D", days: 1 },
  { label: "1W", days: 7 },
  { label: "1M", days: 30 },
  { label: "3M", days: 90 },
  { label: "1Y", days: 365 },
];

/**
 * `bars` must be chronological. A period longer than the available history
 * yields null rather than silently measuring from the oldest bar — "+400%
 * over 1y" computed from four months of data is a fabrication.
 */
export function computePerformance(
  bars: MarketBar[],
  periods: readonly PeriodSpec[] = CRYPTO_PERIODS,
): PricePerformance {
  const usable = bars.filter((b) => Number.isFinite(b.close));
  const last = usable.at(-1);
  if (!last) {
    return {
      changes: periods.map((p) => ({ ...p, percent: null, from: null })),
      high52: null, low52: null, high52At: null, low52At: null,
      volumeQuote: null, barCount: 0,
    };
  }

  const changes = periods.map(({ label, days }) => {
    // Index arithmetic would assume one bar per calendar day; an equity has no
    // weekend bars and a feed gap would skew it either way. Seek by date.
    const cutoff = Date.parse(last.timestamp) - days * 86_400_000;
    const prior = [...usable].reverse().find((b) => Date.parse(b.timestamp) <= cutoff);
    if (!prior || !prior.close) return { label, days, percent: null, from: null };
    return {
      label,
      days,
      percent: ((last.close - prior.close) / prior.close) * 100,
      from: prior.close,
    };
  });

  const window52 = usable.slice(-365);
  let high: MarketBar | undefined;
  let low: MarketBar | undefined;
  for (const b of window52) {
    if (!high || b.high > high.high) high = b;
    if (!low || b.low < low.low) low = b;
  }

  return {
    changes,
    high52: high?.high ?? null,
    low52: low?.low ?? null,
    high52At: high?.timestamp?.slice(0, 10) ?? null,
    low52At: low?.timestamp?.slice(0, 10) ?? null,
    volumeQuote: last.volume != null && last.close != null ? last.volume * last.close : null,
    barCount: usable.length,
  };
}
