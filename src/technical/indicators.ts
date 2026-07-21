/**
 * Deterministic technical indicators (PRD §12).
 *
 * Every value here is computed locally from Alpaca bars. The LLM never
 * calculates or invents an indicator value — it only interprets these.
 */
import type {
  IndicatorConfig,
  MarketBar,
  TechnicalIndicatorSet,
  TechnicalScore,
} from "../types.ts";

const closes = (bars: MarketBar[]) => bars.map((b) => b.close);

export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  // Seed with SMA of the first `period` values.
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
  }
  return prev;
}

export function rsi(values: number[], period: number): number | null {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i++) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gains += change;
    else losses -= change;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i++) {
    const change = values[i]! - values[i - 1]!;
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function emaSeries(values: number[], period: number): number[] {
  if (values.length < period) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out.push(prev);
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function macd(
  values: number[],
  fast: number,
  slow: number,
  signal: number,
): { macd: number | null; signal: number | null; histogram: number | null } {
  if (values.length < slow + signal) {
    return { macd: null, signal: null, histogram: null };
  }
  const fastSeries = emaSeries(values, fast);
  const slowSeries = emaSeries(values, slow);
  // Align tails (slow series is shorter).
  const offset = fastSeries.length - slowSeries.length;
  const macdLine: number[] = [];
  for (let i = 0; i < slowSeries.length; i++) {
    macdLine.push(fastSeries[i + offset]! - slowSeries[i]!);
  }
  const signalSeries = emaSeries(macdLine, signal);
  const macdVal = macdLine.at(-1) ?? null;
  const signalVal = signalSeries.at(-1) ?? null;
  const hist = macdVal != null && signalVal != null ? macdVal - signalVal : null;
  return { macd: macdVal, signal: signalVal, histogram: hist };
}

export function bollinger(
  values: number[],
  period: number,
  stdDev: number,
): { upper: number | null; middle: number | null; lower: number | null } {
  if (values.length < period) return { upper: null, middle: null, lower: null };
  const slice = values.slice(-period);
  const mean = slice.reduce((a, b) => a + b, 0) / period;
  const variance = slice.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
  const sd = Math.sqrt(variance);
  return { upper: mean + stdDev * sd, middle: mean, lower: mean - stdDev * sd };
}

export function atr(bars: MarketBar[], period: number): number | null {
  if (bars.length <= period) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const cur = bars[i]!;
    const prev = bars[i - 1]!;
    const tr = Math.max(
      cur.high - cur.low,
      Math.abs(cur.high - prev.close),
      Math.abs(cur.low - prev.close),
    );
    trs.push(tr);
  }
  // Wilder's smoothing.
  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]!) / period;
  }
  return atrVal;
}

export function momentumPct(values: number[], lookback: number): number | null {
  if (values.length <= lookback) return null;
  const now = values.at(-1)!;
  const then = values[values.length - 1 - lookback]!;
  if (then === 0) return null;
  return ((now - then) / then) * 100;
}

/** Compute the full indicator set required by PRD §12.2. */
export function calculateIndicators(
  bars: MarketBar[],
  config: IndicatorConfig,
): TechnicalIndicatorSet {
  const symbol = bars[0]?.symbol ?? "";
  const asOf = bars.at(-1)?.timestamp ?? new Date(0).toISOString();
  const c = closes(bars);
  const lastClose = c.at(-1) ?? 0;

  const smaMap: Record<number, number | null> = {};
  for (const p of config.movingAverages) smaMap[p] = sma(c, p);
  const emaMap: Record<number, number | null> = {};
  for (const p of config.emaPeriods) emaMap[p] = ema(c, p);

  const momentum: Record<number, number | null> = {
    20: momentumPct(c, 20),
    60: momentumPct(c, 60),
    120: momentumPct(c, 120),
  };

  const window52w = bars.slice(-252);
  const highs = window52w.map((b) => b.high);
  const lows = window52w.map((b) => b.low);
  const high52 = highs.length ? Math.max(...highs) : null;
  const low52 = lows.length ? Math.min(...lows) : null;

  const volumes = bars.map((b) => b.volume);
  const avgDailyVolume =
    volumes.length >= config.relativeVolumePeriod
      ? volumes.slice(-config.relativeVolumePeriod).reduce((a, b) => a + b, 0) /
        config.relativeVolumePeriod
      : null;
  const lastVolume = volumes.at(-1) ?? null;
  const relativeVolume =
    avgDailyVolume && lastVolume ? lastVolume / avgDailyVolume : null;
  const avgDollarVolume =
    avgDailyVolume != null ? avgDailyVolume * lastClose : null;

  const sma50 = smaMap[50] ?? sma(c, 50);
  const sma200 = smaMap[200] ?? sma(c, 200);
  const goldenCross = sma50 != null && sma200 != null && sma50 > sma200;
  const deathCross = sma50 != null && sma200 != null && sma50 < sma200;

  // Breakout/breakdown vs the last 20 completed bars (excluding current).
  const recent = bars.slice(-21, -1);
  const recentHigh = recent.length ? Math.max(...recent.map((b) => b.high)) : null;
  const recentLow = recent.length ? Math.min(...recent.map((b) => b.low)) : null;
  const breakout = recentHigh != null && lastClose > recentHigh;
  const breakdown = recentLow != null && lastClose < recentLow;

  const prevClose = c.at(-2) ?? null;
  const gapPercent =
    prevClose && bars.at(-1)
      ? ((bars.at(-1)!.open - prevClose) / prevClose) * 100
      : null;

  const atrVal = atr(bars, config.atrPeriod);
  const atrPct = atrVal != null && lastClose ? (atrVal / lastClose) * 100 : null;
  const volatilityRegime: TechnicalIndicatorSet["volatilityRegime"] =
    atrPct == null ? "normal" : atrPct < 2 ? "low" : atrPct > 6 ? "high" : "normal";

  const sma20 = smaMap[20] ?? sma(c, 20);
  const aboveShort = sma20 != null && lastClose > sma20;
  const aboveLong = sma200 != null && lastClose > sma200;
  const trend: TechnicalIndicatorSet["trend"] =
    aboveShort && aboveLong && goldenCross
      ? "bullish"
      : !aboveShort && !aboveLong && deathCross
        ? "bearish"
        : "neutral";

  return {
    symbol,
    asOf,
    lastClose,
    sma: smaMap,
    ema: emaMap,
    rsi14: rsi(c, config.rsiPeriod),
    macd: macd(c, config.macd.fast, config.macd.slow, config.macd.signal),
    bollinger: bollinger(c, config.bollinger.period, config.bollinger.stdDev),
    atr14: atrVal,
    vwap: bars.at(-1)?.vwap ?? null,
    relativeVolume,
    avgDailyVolume,
    avgDollarVolume,
    momentum,
    distanceFrom52WeekHigh:
      high52 != null && high52 ? ((lastClose - high52) / high52) * 100 : null,
    distanceFrom52WeekLow:
      low52 != null && low52 ? ((lastClose - low52) / low52) * 100 : null,
    goldenCross,
    deathCross,
    breakout,
    breakdown,
    gapPercent,
    trend,
    volatilityRegime,
  };
}

/**
 * Deterministic technical score (PRD §12.4). Runs BEFORE any LLM analysis.
 * Weights (sum to 100%): MAs 20, RelVol 15, Momentum 20, Breakout 15,
 * Trend 10, Volatility 10, Liquidity/spread 10.
 */
export function scoreTechnicalSetup(
  ind: TechnicalIndicatorSet,
  horizonQuarters: 1 | 2,
): TechnicalScore {
  const breakdown: Record<string, number> = {};

  // Price above 20/50/200-day averages (20 pts).
  let maPts = 0;
  const maChecks = [20, 50, 200];
  for (const p of maChecks) {
    const v = ind.sma[p];
    if (v != null && ind.lastClose > v) maPts += 20 / maChecks.length;
  }
  breakdown.movingAverages = round(maPts);

  // Relative volume (15 pts): 1.0x -> half credit, >=2.0x -> full.
  let rvPts = 0;
  if (ind.relativeVolume != null) {
    rvPts = clamp((ind.relativeVolume - 0.5) / 1.5, 0, 1) * 15;
  }
  breakdown.relativeVolume = round(rvPts);

  // Momentum 20/60/120d (20 pts): positive momentum earns credit.
  let momPts = 0;
  const moms = [ind.momentum[20], ind.momentum[60], ind.momentum[120]];
  const valid = moms.filter((m): m is number => m != null);
  if (valid.length) {
    const avg = valid.reduce((a, b) => a + b, 0) / valid.length;
    momPts = clamp(avg / 30, 0, 1) * 20; // +30% avg momentum -> full credit
  }
  breakdown.momentum = round(momPts);

  // Breakout quality (15 pts).
  breakdown.breakout = ind.breakout ? 15 : ind.breakdown ? 0 : 6;

  // Trend consistency (10 pts).
  breakdown.trend =
    ind.trend === "bullish" ? 10 : ind.trend === "neutral" ? 5 : 0;

  // Volatility suitability (10 pts): normal preferred, high penalized.
  breakdown.volatility =
    ind.volatilityRegime === "normal"
      ? 10
      : ind.volatilityRegime === "low"
        ? 7
        : 3;

  // Liquidity & spread quality (10 pts).
  let liqPts = 0;
  if (ind.avgDollarVolume != null) {
    // $1M/day -> half, $10M/day -> full.
    liqPts = clamp(Math.log10((ind.avgDollarVolume || 1) / 1_000_000) / 1, 0, 1) * 10;
  }
  breakdown.liquidity = round(liqPts);

  const score = round(
    Object.values(breakdown).reduce((a, b) => a + b, 0),
  );

  return { symbol: ind.symbol, score, breakdown, horizonQuarters };
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function round(x: number): number {
  return Math.round(x * 100) / 100;
}
