/**
 * Compact price series for anything that draws a sparkline.
 *
 * Lived in `src/crypto/sparkline.ts` until the watchlist grew a line per row
 * and needed exactly the same thing for equities. Nothing here is crypto- or
 * equity-specific: bars in, a short array of closes out, so the wire format
 * stays a bare number list instead of a few thousand OHLCV objects.
 */
import type { MarketBar } from "../types.ts";

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
