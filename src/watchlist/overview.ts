/**
 * The saved watchlist, priced.
 *
 * `/api/watchlist` answers what is on the list: a ticker and a note. That is
 * enough to render a list of links and nothing else, which is what the page did
 * — you had to open every row to learn whether anything had moved.
 *
 * This assembles the at-a-glance view instead: per row a price, the changes
 * over five windows, 52-week context, the stored report's score, and a short
 * close series for the row's sparkline; across the whole list a set of summary
 * statistics and an equal-weight index measured against a broad-market
 * benchmark.
 *
 * Three rules shape the implementation:
 *
 *   - **One upstream fetch for the whole list.** Bars come back for every saved
 *     ticker plus the benchmark in a single batched request (see
 *     `AlpacaClient.getBarsBatched`), cached for a few minutes and shared by
 *     every viewer, so a 200-ticker watchlist is not 200 round trips per load.
 *   - **Nothing is invented.** A ticker the provider has no bars for is
 *     reported as unpriced and named in `missing`, never filled in from its
 *     stored report price and never dropped silently. Every period longer than
 *     the history available yields null.
 *   - **The freshness is part of the answer.** Daily bars are end-of-session
 *     data, so the payload carries the date of the last bar it used. A stale
 *     price labelled with its date is a snapshot; unlabelled it is a bug.
 */
import type { Client } from "@libsql/client";
import type { AlpacaMarketDataClient } from "../providers/interfaces.ts";
import type { MarketBar } from "../types.ts";
import { EQUITY_PERIODS, computePerformance } from "../market/performance.ts";
import { downsample } from "../market/series.ts";

/** Windows the range control offers, in calendar days. */
export const OVERVIEW_RANGES = { "1M": 30, "3M": 90, "6M": 180, "1Y": 365 } as const;
export type RangeKey = keyof typeof OVERVIEW_RANGES;
export const DEFAULT_RANGE: RangeKey = "3M";

export function isRangeKey(v: unknown): v is RangeKey {
  return typeof v === "string" && v in OVERVIEW_RANGES;
}

/** Broad-market line every watchlist is drawn against. */
export const BENCHMARK_SYMBOL = "SPY";
export const BENCHMARK_LABEL = "S&P 500 (SPY)";

/** Enough history for the 1Y change and the 52-week extremes to be real. */
const HISTORY_DAYS = 400;

/** How long a fetched set of bars is reused across requests and users. */
const BARS_TTL_MS = 10 * 60_000;

/** Points per row sparkline. A cell is ~110px wide; more is invisible. */
const SPARK_POINTS = 40;

/** Points in the index chart. Enough for a year of sessions to read smoothly. */
const INDEX_POINTS = 160;

/** Sessions averaged for the relative-volume figure. */
const AVG_VOLUME_SESSIONS = 20;

export interface SavedItem {
  ticker: string;
  note?: string;
  createdAt: string;
}

export interface OverviewChange {
  label: string;
  percent: number | null;
}

export interface OverviewItem extends SavedItem {
  companyName?: string;
  classification?: string;
  overallScore?: number;
  confidence?: number;
  signalCount: number;
  sourceCount: number;
  /** When the stored report snapshot was taken, if there is one. */
  reportGeneratedAt?: string;
  hasReport: boolean;
  /** Last close from the bars actually fetched. Absent when there are none. */
  price: number | null;
  /** Session date of that close. */
  priceAsOf: string | null;
  /** Keyed by period label: 1D, 1W, 1M, 3M, 1Y. */
  changes: OverviewChange[];
  /** Change across the selected range — what the table sorts and colours by. */
  rangePercent: number | null;
  high52: number | null;
  low52: number | null;
  /** Percent below the 52-week high; 0 means it is at it. */
  fromHigh52: number | null;
  volume: number | null;
  avgVolume: number | null;
  relativeVolume: number | null;
  /** Closes across the range, oldest first — the row's sparkline. */
  spark: number[];
  barCount: number;
}

export interface OverviewStats {
  count: number;
  priced: number;
  /** Saved tickers the provider returned nothing for. */
  missing: string[];
  gainers: number;
  losers: number;
  unchanged: number;
  avgDayPercent: number | null;
  medianDayPercent: number | null;
  best: { ticker: string; percent: number } | null;
  worst: { ticker: string; percent: number } | null;
  bestDay: { ticker: string; percent: number } | null;
  worstDay: { ticker: string; percent: number } | null;
  avgScore: number | null;
  scored: number;
  withReports: number;
  /** Equal-weight change across the range, and the benchmark's for contrast. */
  rangePercent: number | null;
  benchmarkPercent: number | null;
}

export interface IndexPoint {
  t: string;
  value: number;
}

export interface OverviewIndex {
  /** Equal-weight, rebased to 100 at the start of the range. */
  points: IndexPoint[];
  benchmark: IndexPoint[];
  benchmarkSymbol: string;
  benchmarkLabel: string;
  /** Tickers that had history for the whole range and so are in the line. */
  members: string[];
  /** Saved tickers left out, because their history starts inside the range. */
  excluded: string[];
}

export interface WatchlistOverview {
  range: RangeKey;
  rangeDays: number;
  /** Session date of the newest bar used anywhere in this payload. */
  asOf: string | null;
  /** Where the prices came from. */
  source: string;
  /** Set when the market fetch failed outright; items are then unpriced. */
  marketError?: string;
  items: OverviewItem[];
  stats: OverviewStats;
  index: OverviewIndex | null;
}

export interface OverviewDeps {
  db: Client;
  market: AlpacaMarketDataClient;
  marketSource?: string;
  now?: () => number;
}

/* ---- Bars cache ---------------------------------------------------------- */

interface CacheEntry {
  at: number;
  bars: MarketBar[];
}

/**
 * Daily bars per symbol, shared process-wide.
 *
 * Two users watching NVDA cost one fetch, and a user reloading the tab costs
 * none. Only symbols that are missing or stale are re-requested, so adding one
 * ticker to a long list is a one-symbol fetch rather than a full refresh.
 */
export class BarsCache {
  private cache = new Map<string, CacheEntry>();

  constructor(
    private readonly market: AlpacaMarketDataClient,
    private readonly ttlMs = BARS_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(symbols: string[]): Promise<{ bars: Map<string, MarketBar[]>; error?: string }> {
    const wanted = [...new Set(symbols)];
    const t = this.now();
    const stale = wanted.filter((s) => {
      const hit = this.cache.get(s);
      return !hit || t - hit.at >= this.ttlMs;
    });

    let error: string | undefined;
    if (stale.length) {
      try {
        const fetched = await this.market.getBars({
          symbols: stale,
          timeframe: "1Day",
          start: new Date(t - HISTORY_DAYS * 86_400_000).toISOString(),
          end: new Date(t).toISOString(),
        });
        const grouped = new Map<string, MarketBar[]>();
        for (const b of fetched) {
          const sym = b.symbol.toUpperCase();
          (grouped.get(sym) ?? grouped.set(sym, []).get(sym)!).push(b);
        }
        // Symbols the provider answered nothing for are cached as empty too:
        // a delisted or unknown ticker should not be re-requested every load.
        for (const sym of stale) {
          const rows = (grouped.get(sym) ?? []).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
          this.cache.set(sym, { at: t, bars: rows });
        }
      } catch (err) {
        error = String(err).slice(0, 300);
      }
    }

    const out = new Map<string, MarketBar[]>();
    for (const s of wanted) {
      const hit = this.cache.get(s);
      if (hit?.bars.length) out.set(s, hit.bars);
    }
    return { bars: out, error };
  }
}

/* ---- Report columns ------------------------------------------------------ */

interface ReportRow {
  companyName?: string;
  classification?: string;
  overallScore?: number;
  confidence?: number;
  signalCount: number;
  sourceCount: number;
  generatedAt: string;
}

const num = (v: unknown): number | undefined => {
  const n = Number(v);
  return v == null || Number.isNaN(n) ? undefined : n;
};

/** The denormalized report columns for a set of tickers — no payload parsing. */
async function reportRows(db: Client, tickers: string[]): Promise<Map<string, ReportRow>> {
  const out = new Map<string, ReportRow>();
  if (!tickers.length) return out;
  for (let i = 0; i < tickers.length; i += 100) {
    const chunk = tickers.slice(i, i + 100);
    const rs = await db.execute({
      sql: `SELECT ticker, company_name, last_price, overall_score, confidence, classification,
                   signal_count, source_count, generated_at
            FROM reports WHERE ticker IN (${chunk.map(() => "?").join(",")})`,
      args: chunk,
    });
    for (const r of rs.rows) {
      out.set(String(r.ticker), {
        companyName: r.company_name == null ? undefined : String(r.company_name),
        classification: r.classification == null ? undefined : String(r.classification),
        overallScore: num(r.overall_score),
        confidence: num(r.confidence),
        signalCount: Number(r.signal_count ?? 0),
        sourceCount: Number(r.source_count ?? 0),
        generatedAt: String(r.generated_at),
      });
    }
  }
  return out;
}

/* ---- Per-row maths ------------------------------------------------------- */

/** Bars at or after `since`, chronological. */
function withinRange(bars: MarketBar[], since: number): MarketBar[] {
  return bars.filter((b) => Date.parse(b.timestamp) >= since);
}

/**
 * Change from the first close at or after `since` to the last close.
 *
 * Measured against a bar we actually have rather than the calendar date asked
 * for: over a 3M window the first session inside it is the honest baseline.
 * Null when the window holds fewer than two closes.
 */
function rangeChange(bars: MarketBar[], since: number): number | null {
  const rows = withinRange(bars, since).filter((b) => Number.isFinite(b.close));
  if (rows.length < 2) return null;
  const first = rows[0]!.close;
  const last = rows.at(-1)!.close;
  return first ? ((last - first) / first) * 100 : null;
}

function averageVolume(bars: MarketBar[], sessions: number): number | null {
  const vols = bars.slice(-sessions).map((b) => b.volume).filter((v): v is number => Number.isFinite(v as number));
  if (!vols.length) return null;
  return vols.reduce((a, b) => a + b, 0) / vols.length;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const mean = (values: number[]): number | null =>
  values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

/* ---- The equal-weight index --------------------------------------------- */

/** Session date (YYYY-MM-DD) -> close, for one symbol. */
function closesByDate(bars: MarketBar[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const b of bars) {
    if (Number.isFinite(b.close)) out.set(b.timestamp.slice(0, 10), b.close);
  }
  return out;
}

/**
 * Rebase every member to 100 at the start of the range and average them.
 *
 * Equal weight, because a watchlist is a list of things being watched, not a
 * portfolio with position sizes — weighting by price or market cap would state
 * a holding nobody entered.
 *
 * Only tickers with a close at or before the first session are members: a
 * ticker whose history starts halfway through the range would otherwise join
 * the average at 100 and flatten it. The ones left out are named, not hidden.
 */
export function buildIndex(
  seriesByTicker: Map<string, MarketBar[]>,
  benchmarkBars: MarketBar[] | undefined,
  since: number,
  tickers: string[],
): OverviewIndex | null {
  const memberDates = new Map<string, Map<string, number>>();
  for (const ticker of tickers) {
    const bars = seriesByTicker.get(ticker);
    if (bars?.length) memberDates.set(ticker, closesByDate(bars));
  }
  const benchDates = benchmarkBars?.length ? closesByDate(benchmarkBars) : null;

  // The benchmark trades every session, so it is the cleanest calendar. Without
  // it, fall back to every date any member has.
  const calendar = [
    ...new Set(
      benchDates
        ? [...benchDates.keys()]
        : [...memberDates.values()].flatMap((m) => [...m.keys()]),
    ),
  ]
    .sort()
    .filter((d) => Date.parse(`${d}T00:00:00Z`) >= since);
  if (calendar.length < 2) return null;

  const first = calendar[0]!;
  const members: string[] = [];
  const excluded: string[] = [];
  const baselines = new Map<string, number>();
  for (const [ticker, dates] of memberDates) {
    // Its own first close inside the window, and only if that is the window's
    // opening session — otherwise the ticker's history starts too late.
    const own = [...dates.keys()].sort().find((d) => d >= first);
    const base = own ? dates.get(own) : undefined;
    if (own && base && own <= calendar[Math.min(2, calendar.length - 1)]!) {
      members.push(ticker);
      baselines.set(ticker, base);
    } else {
      excluded.push(ticker);
    }
  }
  if (!members.length) return null;

  const lastSeen = new Map<string, number>();
  const points: IndexPoint[] = [];
  for (const date of calendar) {
    const ratios: number[] = [];
    for (const ticker of members) {
      const close = memberDates.get(ticker)!.get(date);
      // Carry the last known close through a session a symbol has no bar for —
      // a single gap must not drop a member out of the average and step the line.
      if (close != null) lastSeen.set(ticker, close);
      const value = close ?? lastSeen.get(ticker);
      const base = baselines.get(ticker)!;
      if (value != null && base) ratios.push(value / base);
    }
    const avg = mean(ratios);
    if (avg != null) points.push({ t: date, value: avg * 100 });
  }
  if (points.length < 2) return null;

  const benchmark: IndexPoint[] = [];
  if (benchDates) {
    const firstBench = calendar.find((d) => benchDates.has(d));
    const base = firstBench ? benchDates.get(firstBench)! : null;
    if (base) {
      for (const date of calendar) {
        const v = benchDates.get(date);
        if (v != null) benchmark.push({ t: date, value: (v / base) * 100 });
      }
    }
  }

  return {
    points: downsamplePoints(points, INDEX_POINTS),
    benchmark: downsamplePoints(benchmark, INDEX_POINTS),
    benchmarkSymbol: BENCHMARK_SYMBOL,
    benchmarkLabel: BENCHMARK_LABEL,
    members: members.sort(),
    excluded: excluded.sort(),
  };
}

/** Same rule as `downsample`, applied to dated points. */
function downsamplePoints(points: IndexPoint[], max: number): IndexPoint[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  const out: IndexPoint[] = [];
  for (let i = 0; i < max; i++) out.push(points[Math.round(i * step)]!);
  return out;
}

/* ---- The build ----------------------------------------------------------- */

/**
 * One `BarsCache` per process. It is keyed by symbol and holds a few hundred
 * daily bars each, so even a busy instance is a small map.
 */
let sharedCache: BarsCache | null = null;
let sharedFor: AlpacaMarketDataClient | null = null;

function cacheFor(market: AlpacaMarketDataClient, now: () => number): BarsCache {
  if (!sharedCache || sharedFor !== market) {
    sharedCache = new BarsCache(market, BARS_TTL_MS, now);
    sharedFor = market;
  }
  return sharedCache;
}

export async function buildWatchlistOverview(
  deps: OverviewDeps,
  saved: SavedItem[],
  opts: { range?: RangeKey; cache?: BarsCache } = {},
): Promise<WatchlistOverview> {
  const now = deps.now ?? Date.now;
  const range = opts.range ?? DEFAULT_RANGE;
  const rangeDays = OVERVIEW_RANGES[range];
  // Aligned to the start of the day, for two reasons: the rows compare bar
  // timestamps while the index compares session dates, and an unaligned cutoff
  // makes those two disagree about the first session in the window; and a
  // window that shifts with the time of day would make the same "3M" mean
  // something slightly different every load.
  const since = Date.parse(`${new Date(now() - rangeDays * 86_400_000).toISOString().slice(0, 10)}T00:00:00Z`);
  const tickers = saved.map((i) => i.ticker);

  const cache = opts.cache ?? cacheFor(deps.market, now);
  // An empty watchlist has nothing to price: fetching the benchmark alone would
  // spend a request to draw a line with no watchlist on it.
  const [{ bars, error }, reports] = tickers.length
    ? await Promise.all([cache.get([...tickers, BENCHMARK_SYMBOL]), reportRows(deps.db, tickers)])
    : [{ bars: new Map<string, MarketBar[]>(), error: undefined }, new Map<string, ReportRow>()];

  const items: OverviewItem[] = saved.map((entry) => {
    const rows = bars.get(entry.ticker) ?? [];
    const report = reports.get(entry.ticker);
    const perf = computePerformance(rows, EQUITY_PERIODS);
    const last = rows.at(-1);
    const inRange = withinRange(rows, since);
    const avgVolume = averageVolume(rows, AVG_VOLUME_SESSIONS);
    const volume = last?.volume ?? null;

    return {
      ...entry,
      companyName: report?.companyName,
      classification: report?.classification,
      overallScore: report?.overallScore,
      confidence: report?.confidence,
      signalCount: report?.signalCount ?? 0,
      sourceCount: report?.sourceCount ?? 0,
      reportGeneratedAt: report?.generatedAt,
      hasReport: Boolean(report),
      price: last?.close ?? null,
      priceAsOf: last?.timestamp.slice(0, 10) ?? null,
      changes: perf.changes.map((c) => ({ label: c.label, percent: c.percent })),
      rangePercent: rangeChange(rows, since),
      high52: perf.high52,
      low52: perf.low52,
      fromHigh52:
        perf.high52 && last?.close != null ? ((last.close - perf.high52) / perf.high52) * 100 : null,
      volume,
      avgVolume,
      relativeVolume: volume != null && avgVolume ? volume / avgVolume : null,
      spark: downsample(inRange.map((b) => b.close).filter((c) => Number.isFinite(c)), SPARK_POINTS),
      barCount: perf.barCount,
    };
  });

  const dayOf = (i: OverviewItem) => i.changes.find((c) => c.label === "1D")?.percent ?? null;
  const priced = items.filter((i) => i.price != null);
  const dayMoves = priced.map(dayOf).filter((p): p is number => p != null);
  const ranked = priced.filter((i) => i.rangePercent != null);
  const byRange = [...ranked].sort((a, b) => b.rangePercent! - a.rangePercent!);
  const byDay = priced.filter((i) => dayOf(i) != null).sort((a, b) => dayOf(b)! - dayOf(a)!);
  const scores = items.map((i) => i.overallScore).filter((s): s is number => s != null);

  const index = buildIndex(bars, bars.get(BENCHMARK_SYMBOL), since, tickers);
  const benchPoints = index?.benchmark ?? [];
  const benchmarkPercent =
    benchPoints.length >= 2 ? benchPoints.at(-1)!.value - benchPoints[0]!.value : null;
  const indexPoints = index?.points ?? [];
  const rangePercent = indexPoints.length >= 2 ? indexPoints.at(-1)!.value - indexPoints[0]!.value : null;

  const asOf = items
    .map((i) => i.priceAsOf)
    .filter((d): d is string => d != null)
    .sort()
    .at(-1) ?? null;

  const top = (list: OverviewItem[], pick: (i: OverviewItem) => number | null) => {
    const head = list[0];
    const percent = head ? pick(head) : null;
    return head && percent != null ? { ticker: head.ticker, percent } : null;
  };

  const stats: OverviewStats = {
    count: items.length,
    priced: priced.length,
    missing: items.filter((i) => i.price == null).map((i) => i.ticker),
    gainers: dayMoves.filter((p) => p > 0).length,
    losers: dayMoves.filter((p) => p < 0).length,
    unchanged: dayMoves.filter((p) => p === 0).length,
    avgDayPercent: mean(dayMoves),
    medianDayPercent: median(dayMoves),
    best: top(byRange, (i) => i.rangePercent),
    worst: top([...byRange].reverse(), (i) => i.rangePercent),
    bestDay: top(byDay, dayOf),
    worstDay: top([...byDay].reverse(), dayOf),
    avgScore: mean(scores),
    scored: scores.length,
    withReports: items.filter((i) => i.hasReport).length,
    rangePercent,
    benchmarkPercent,
  };

  return {
    range,
    rangeDays,
    asOf,
    source: deps.marketSource ?? "market data",
    // Only a real failure is reported. An empty watchlist has no prices to
    // fetch and is not an error.
    marketError: error,
    items,
    stats,
    index,
  };
}
