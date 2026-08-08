/**
 * Compact price series for the grid cards.
 *
 * The grid draws twelve sparklines at once. Sending raw bars for that would be
 * ~2,000 objects of OHLCV where the card needs a shape — so the series is built
 * and downsampled here, and the wire format is a bare array of closes.
 *
 * Upstream cost is the other half of the reason: Alpaca's multi-symbol bars
 * endpoint paginates, so one grid load is several requests. That is fine once a
 * minute for everyone; it is not fine per visitor, hence the cache.
 */
import type { AlpacaCryptoClient } from "./client.ts";
import type { MarketBar } from "../types.ts";

export type SparkPeriod = "24h" | "7d";

export const SPARK_PERIODS: SparkPeriod[] = ["24h", "7d"];

interface PeriodSpec {
  hours: number;
  /** Most points to send per pair. A card is ~170px wide; more is invisible. */
  maxPoints: number;
  /** How long a built series is reused. */
  cacheTtlMs: number;
}

const SPECS: Record<SparkPeriod, PeriodSpec> = {
  "24h": { hours: 24, maxPoints: 24, cacheTtlMs: 60_000 },
  "7d": { hours: 24 * 7, maxPoints: 56, cacheTtlMs: 5 * 60_000 },
};

export interface SparkSeries {
  symbol: string;
  /** Closing prices, oldest first. */
  points: number[];
  first: number | null;
  last: number | null;
  changePercent: number | null;
  start: string | null;
  end: string | null;
}

/**
 * Keep at most `max` points, evenly spaced, always retaining the first and
 * last. Dropping the last point would move the line's endpoint away from the
 * current price and make the card disagree with the number printed beside it.
 */
export function downsample(values: number[], max: number): number[] {
  if (max <= 0) return [];
  if (values.length <= max) return [...values];
  if (max === 1) return [values.at(-1)!];
  const step = (values.length - 1) / (max - 1);
  const out: number[] = [];
  for (let i = 0; i < max; i++) out.push(values[Math.round(i * step)]!);
  return out;
}

/** Bars for one symbol -> the series a card draws. */
export function toSeries(symbol: string, bars: MarketBar[], maxPoints: number): SparkSeries {
  const usable = bars.filter((b) => Number.isFinite(b.close));
  const points = downsample(usable.map((b) => b.close), maxPoints);
  const first = points[0] ?? null;
  const last = points.at(-1) ?? null;
  return {
    symbol,
    points,
    first,
    last,
    // Measured across the window actually returned, not the window requested —
    // a pair with only six hours of history reports its six-hour change.
    changePercent: first != null && last != null && first !== 0 ? ((last - first) / first) * 100 : null,
    start: usable[0]?.timestamp ?? null,
    end: usable.at(-1)?.timestamp ?? null,
  };
}

export interface SparklineOptions {
  now?: () => number;
}

export class SparklineService {
  private readonly now: () => number;
  private cache = new Map<SparkPeriod, { at: number; series: Map<string, SparkSeries> }>();
  private inFlight = new Map<SparkPeriod, Promise<Map<string, SparkSeries>>>();

  constructor(
    private readonly client: AlpacaCryptoClient,
    options: SparklineOptions = {},
  ) {
    this.now = options.now ?? Date.now;
  }

  /**
   * Series for `symbols`. The upstream fetch always covers the full requested
   * set for the period and is cached as a unit, so two visitors looking at the
   * same grid cost one set of requests, not two.
   */
  async get(symbols: string[], period: SparkPeriod): Promise<Map<string, SparkSeries>> {
    const spec = SPECS[period];
    const cached = this.cache.get(period);
    if (cached && this.now() - cached.at < spec.cacheTtlMs) return cached.series;

    const existing = this.inFlight.get(period);
    if (existing) return existing;

    const task = (async () => {
      const start = new Date(this.now() - spec.hours * 3_600_000).toISOString();
      const bars = await this.client.getBars({
        symbols,
        timeframe: "1Hour",
        start,
        end: new Date(this.now()).toISOString(),
      });
      const bySymbol = new Map<string, MarketBar[]>();
      for (const b of bars) (bySymbol.get(b.symbol) ?? bySymbol.set(b.symbol, []).get(b.symbol)!).push(b);

      const series = new Map<string, SparkSeries>();
      for (const symbol of symbols) {
        const rows = bySymbol.get(symbol) ?? [];
        // A pair with one point cannot be drawn as a line; send it empty so the
        // card omits the chart rather than rendering a flat line that implies
        // a stable price we did not observe.
        if (rows.length < 2) continue;
        series.set(symbol, toSeries(symbol, rows, spec.maxPoints));
      }
      this.cache.set(period, { at: this.now(), series });
      return series;
    })();

    this.inFlight.set(period, task);
    try {
      return await task;
    } finally {
      this.inFlight.delete(period);
    }
  }
}

export function isSparkPeriod(v: unknown): v is SparkPeriod {
  return v === "24h" || v === "7d";
}
