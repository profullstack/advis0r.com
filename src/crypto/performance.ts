/**
 * Multi-period price performance, computed from the daily bars already fetched
 * for the indicators — no extra upstream call, no second vendor.
 *
 * The pair page previously showed only the session's numbers (bid, ask, day
 * high/low, previous close). That answers "what is it now" but not "what has it
 * been doing", which is most of what someone means by pricing information on a
 * 24/7 asset.
 *
 * Deliberately NOT here: market capitalisation, circulating supply and
 * all-time high. Alpaca's market-data API does not carry them, and deriving
 * them would mean either inventing a supply figure or adding a second vendor
 * with its own provenance. An absent field is better than a wrong one.
 */
import type { MarketBar } from "../types.ts";

export interface PeriodChange {
  label: string;
  /** Calendar days back. */
  days: number;
  percent: number | null;
  /** The close this was measured against, so the number is checkable. */
  from: number | null;
}

export interface CryptoPerformance {
  changes: PeriodChange[];
  high52: number | null;
  low52: number | null;
  high52At: string | null;
  low52At: string | null;
  /** Venue volume over the last session, in quote currency. */
  volumeQuote: number | null;
  /** How many daily bars backed this, so a thin history is visible. */
  barCount: number;
}

const PERIODS: Array<{ label: string; days: number }> = [
  { label: "24h", days: 1 },
  { label: "7d", days: 7 },
  { label: "30d", days: 30 },
  { label: "90d", days: 90 },
  { label: "1y", days: 365 },
];

/**
 * `bars` must be chronological. A period longer than the available history
 * yields null rather than silently measuring from the oldest bar — "+400%
 * over 1y" computed from four months of data is a fabrication.
 */
export function computePerformance(bars: MarketBar[]): CryptoPerformance {
  const usable = bars.filter((b) => Number.isFinite(b.close));
  const last = usable.at(-1);
  if (!last) {
    return {
      changes: PERIODS.map((p) => ({ ...p, percent: null, from: null })),
      high52: null, low52: null, high52At: null, low52At: null,
      volumeQuote: null, barCount: 0,
    };
  }

  const changes = PERIODS.map(({ label, days }) => {
    // Index arithmetic would assume one bar per calendar day; crypto has no
    // market close, but a gap in the feed would still skew it. Seek by date.
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
