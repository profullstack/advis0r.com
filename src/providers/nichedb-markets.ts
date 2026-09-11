/**
 * nichedb items → the site's own shapes, behind the `NICHEDB_MARKETS` switch.
 *
 * Everything downstream — indicators, scoring, the evidence builder, the report
 * page — keeps reading `MarketBar[]`, `CompanyFacts`, `SymbolRow[]` and
 * `NewsHit[]`. This module is the only place that knows a nichedb item exists,
 * and every read here answers `null`/`[]` when nichedb has nothing usable so
 * the caller falls through to the live provider it always had.
 *
 * What stays live on purpose:
 *   - Snapshots (latest trade/quote): nichedb has no quotes. The report's
 *     price, timestamp and `delayed` flag still come from Alpaca (or Yahoo).
 *   - The filings list (SEC submissions): nichedb's `filings` collection is a
 *     different shape; `getFilings` is untouched.
 *   - Yahoo per-miss symbol search: a ticker nichedb's directory lacks is
 *     still found and cached the same way.
 */
import type { CompanyFacts, MarketBar } from "../types.ts";
import type { SymbolRow } from "../symbols/directory.ts";
import type { NewsHit } from "./news/valueserp.ts";
import { normalizeHost, tierFor } from "./news/tiers.ts";
import {
  NichedbClient,
  nichedbEnabled,
  type NichedbFactPoint,
  type NichedbFundamentalsData,
  type NichedbHistoryData,
  type NichedbItem,
  type NichedbNewsData,
  type NichedbSymbolData,
} from "./nichedb.ts";

/** The source name carried on facts, symbols and bars read from the mirror. */
export const NICHEDB_SOURCE = "nichedb";

/**
 * A history window whose last bar is older than this is not used: the mirror
 * refreshes after every session, so five days covers a long weekend plus a
 * holiday, and anything staler means the mirror stopped and the live path
 * should answer.
 */
export const HISTORY_MAX_AGE_DAYS = 5;

/**
 * Daily bars are stamped at 05:00Z: midnight Eastern in winter, 01:00 in
 * summer — either way the same Eastern calendar day as the bar, which is what
 * `etDate()` in the digest and the `slice(0, 10)` on the report page both read.
 * Alpaca stamps its daily bars at midnight ET too, so the two sources agree.
 */
export function barTimestamp(day: string): string {
  return `${day}T05:00:00Z`;
}

export interface BarsWindow {
  /** ISO instant or date; bars on/after this day are kept. */
  start?: string;
  /** ISO instant or date; bars on/before this day are kept. */
  end?: string;
}

export interface HistoryBars {
  bars: MarketBar[];
  feed: "iex" | "sip";
  /** The IEX free feed is one venue; only SIP is the consolidated tape. */
  delayed: boolean;
  /** The last bar's day. */
  last: string;
}

/**
 * A `history` item → `MarketBar[]` in the Alpaca provider's shape, oldest
 * first, cut to the window asked for. `null` when the item is missing, not a
 * history item, or its last bar is older than `HISTORY_MAX_AGE_DAYS`.
 */
export function historyToBars(
  item: NichedbItem | null,
  window: BarsWindow = {},
  now: number = Date.now(),
): HistoryBars | null {
  if (!item || item.kind !== "history") return null;
  const data = item.data as unknown as Partial<NichedbHistoryData>;
  if (!Array.isArray(data.bars) || !data.bars.length) return null;
  const symbol = String(data.symbol ?? "").toUpperCase();
  if (!symbol) return null;

  const last = String(data.last ?? data.bars[data.bars.length - 1]![0]);
  if (!isFresh(last, now)) return null;

  const feed: "iex" | "sip" = data.feed === "sip" ? "sip" : "iex";
  const from = window.start?.slice(0, 10);
  const to = window.end?.slice(0, 10);
  const bars: MarketBar[] = [];
  for (const tuple of data.bars) {
    if (!Array.isArray(tuple) || tuple.length < 6) continue;
    const [day, open, high, low, close, volume, vwap] = tuple;
    if (typeof day !== "string") continue;
    if (from && day < from) continue;
    if (to && day > to) continue;
    if (![open, high, low, close].every((n) => typeof n === "number" && Number.isFinite(n))) continue;
    bars.push({
      symbol,
      timestamp: barTimestamp(day),
      open: open as number,
      high: high as number,
      low: low as number,
      close: close as number,
      volume: typeof volume === "number" ? volume : 0,
      vwap: typeof vwap === "number" ? vwap : undefined,
      timeframe: "1Day",
      // nichedb's window is split-adjusted, whatever the site's Alpaca config
      // says; the bar records what it is rather than what was asked for.
      adjustment: "split",
    });
  }
  if (!bars.length) return null;
  bars.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { bars, feed, delayed: feed !== "sip", last };
}

/** True when `day` (YYYY-MM-DD) is within the staleness limit of `now`. */
export function isFresh(day: string, now: number, maxAgeDays = HISTORY_MAX_AGE_DAYS): boolean {
  const t = Date.parse(day.length === 10 ? `${day}T00:00:00Z` : day);
  if (Number.isNaN(t)) return false;
  return now - t <= maxAgeDays * 86_400_000;
}

/**
 * A `fundamentals` item → `CompanyFacts`, the shape `SecFundamentalsProvider`
 * produces. Derived the same way from the same concepts: revenue through the
 * three tags in the same order of preference, debt as current plus
 * non-current, shares from the cover page, runway from cash over operating
 * burn. `asOf` is honoured point-in-time the way `latestValue` there does it —
 * the newest point whose period end is on/before the cutoff — so a report
 * built for a past date still reads what was known then.
 */
export function fundamentalsToFacts(
  item: NichedbItem | null,
  symbol: string,
  asOf?: string,
): CompanyFacts | null {
  if (!item || item.kind !== "fundamentals") return null;
  const data = item.data as unknown as Partial<NichedbFundamentalsData>;
  const concepts = (data.concepts ?? {}) as Record<string, NichedbFactPoint[] | undefined>;
  const latest = data.latest ?? {};
  const cutoff = asOf?.slice(0, 10);
  const sym = symbol.toUpperCase();
  const nowIso = asOf ?? new Date().toISOString();

  const pick = (concept: string): number | null => latestValue(concepts[concept], cutoff);
  // `latest` is the item's own headline figure. It describes one period
  // (`latest.period`), so it is only point-in-time safe when that period ends
  // on/before the cutoff — the same `end <= cutoff` rule `latestValue` applies.
  const latestUsable = !cutoff || (typeof latest.period === "string" && latest.period <= cutoff);
  const orLatest = (v: number | null, key: keyof NichedbFundamentalsData["latest"]): number | null => {
    if (v != null) return v;
    if (!latestUsable) return null;
    const l = latest[key];
    return typeof l === "number" ? l : null;
  };

  const shares = orLatest(
    pick("EntityCommonStockSharesOutstanding") ?? pick("CommonStockSharesOutstanding"),
    "sharesOutstanding",
  );
  const publicFloat = orLatest(pick("EntityPublicFloat"), "publicFloat");
  const revenueConcept = ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues", "SalesRevenueNet"].find(
    (c) => concepts[c]?.length,
  );
  const revenue = orLatest(revenueConcept ? pick(revenueConcept) : null, "revenue");
  const revenueGrowth = revenueConcept ? yoyGrowth(concepts[revenueConcept], cutoff) : undefined;
  const cash = orLatest(pick("CashAndCashEquivalentsAtCarryingValue"), "cash");
  const debtParts = [pick("LongTermDebtNoncurrent"), pick("LongTermDebtCurrent")];
  const debt = debtParts.some((d) => d != null)
    ? debtParts.reduce<number>((a, b) => a + (b ?? 0), 0)
    : orLatest(pick("LongTermDebt"), "longTermDebt");
  const opCashFlow = orLatest(pick("NetCashProvidedByUsedInOperatingActivities"), "operatingCashFlow");
  const runwayMonths =
    cash != null && opCashFlow != null && opCashFlow < 0
      ? Math.round((cash / (Math.abs(opCashFlow) / 12)) * 10) / 10
      : undefined;

  const cikRaw = data.cik != null ? String(data.cik).replace(/\D/g, "") : "";
  return {
    symbol: sym,
    companyName: data.name ? String(data.name) : undefined,
    cik: cikRaw ? cikRaw.padStart(10, "0") : undefined,
    exchange: data.exchange ? String(data.exchange) : undefined,
    sharesOutstanding: shares ?? undefined,
    publicFloat: publicFloat ?? undefined,
    revenue: revenue ?? undefined,
    revenueGrowth,
    cashBalance: cash ?? undefined,
    totalDebt: debt || undefined,
    freeCashFlow: opCashFlow ?? undefined,
    runwayMonths,
    asOf: nowIso,
    source: NICHEDB_SOURCE,
  };
}

/** Newest point on/before `cutoff` (period end), like sec.ts `latestValue`. */
function latestValue(points: NichedbFactPoint[] | undefined, cutoff?: string): number | null {
  if (!points?.length) return null;
  const eligible = points
    .filter((p) => p.end && (!cutoff || p.end <= cutoff))
    .sort((a, b) => a.end.localeCompare(b.end));
  const last = eligible.at(-1);
  return typeof last?.val === "number" ? last.val : null;
}

/** Year-over-year growth from the two newest full-year 10-K points, like sec.ts. */
function yoyGrowth(points: NichedbFactPoint[] | undefined, cutoff?: string): number | undefined {
  if (!points?.length) return undefined;
  const annual = points
    .filter((p) => /^10-K/.test(p.form ?? "") && p.fp === "FY" && p.start && p.end)
    .filter((p) => !cutoff || p.end <= cutoff)
    .filter((p) => (Date.parse(p.end) - Date.parse(p.start!)) / 86_400_000 >= 300)
    .sort((a, b) => a.end.localeCompare(b.end));
  const latest = annual.at(-1);
  const prior = annual.at(-2);
  if (!latest || !prior || typeof latest.val !== "number" || !prior.val) return undefined;
  return Math.round(((latest.val - prior.val) / Math.abs(prior.val)) * 1000) / 10;
}

/**
 * `symbol` items → directory rows. Crypto pairs are skipped: the directory is
 * the equity typeahead, and the Alpaca sync it replaces asked for
 * `asset_class=us_equity` only. Untradable and OTC names are kept and flagged,
 * exactly as the Alpaca rows were.
 */
export function symbolItemsToRows(items: NichedbItem[]): SymbolRow[] {
  const rows: SymbolRow[] = [];
  for (const item of items) {
    if (item.kind !== "symbol") continue;
    const d = item.data as unknown as Partial<NichedbSymbolData>;
    if (!d.symbol || !d.name) continue;
    if (d.assetClass && d.assetClass !== "us_equity") continue;
    rows.push({
      symbol: String(d.symbol).toUpperCase(),
      name: String(d.name),
      exchange: d.exchange ? String(d.exchange) : undefined,
      assetClass: d.assetClass ?? "us_equity",
      status: d.status ? String(d.status) : undefined,
      tradable: d.tradable !== false && d.status !== "inactive",
      source: NICHEDB_SOURCE,
    });
  }
  return rows;
}

/**
 * Market-news items → the hits the RSS path produces, so they run through the
 * same subject check, headline dedupe, tiering and article fetch. The
 * publisher is the wire's source name (Benzinga, Reuters...) or the byline;
 * the tier comes from the article's own host, exactly as for an RSS hit.
 */
export function newsItemsToHits(items: NichedbItem[]): NewsHit[] {
  const hits: NewsHit[] = [];
  for (const item of items) {
    if (!item.url || !item.title) continue;
    const d = (item.data ?? {}) as Partial<NichedbNewsData>;
    const host = normalizeHost(item.url);
    if (!host) continue;
    hits.push({
      title: item.title,
      url: item.url,
      publisher: d.source || d.author || host,
      host,
      tier: tierFor(item.url),
      publishedAt: item.published_at ? item.published_at.slice(0, 10) : undefined,
      snippet: item.summary ?? undefined,
    });
  }
  return hits;
}

/**
 * The reads a report build makes. Each one swallows nichedb errors into a
 * `null`/`[]` and reports them through `onMiss`, because the caller has a live
 * path to fall back to and a mirror outage must not fail a page that used to
 * render without it.
 */
export class NichedbMarkets {
  constructor(
    readonly client: NichedbClient,
    private readonly opts: { now?: () => number; onMiss?: (what: string, why: string) => void } = {},
  ) {}

  private miss(what: string, why: string): void {
    this.opts.onMiss?.(what, why);
  }

  /** Daily bars for the window, or null when nichedb has none fresh enough. */
  async bars(symbol: string, window: BarsWindow): Promise<HistoryBars | null> {
    try {
      const item = await this.client.historyItem(symbol);
      const out = historyToBars(item, window, this.opts.now?.() ?? Date.now());
      if (!out) this.miss("history", item ? "stale or empty window" : "no item");
      return out;
    } catch (err) {
      this.miss("history", String(err).slice(0, 200));
      return null;
    }
  }

  /** Company facts, or null when nichedb has no fundamentals for the ticker. */
  async facts(symbol: string, asOf?: string): Promise<CompanyFacts | null> {
    try {
      const item = await this.client.fundamentalsItem(symbol);
      const out = fundamentalsToFacts(item, symbol, asOf);
      if (!out) this.miss("fundamentals", "no item");
      return out;
    } catch (err) {
      this.miss("fundamentals", String(err).slice(0, 200));
      return null;
    }
  }

  /** News hits about a ticker from the shared wire, newest first. */
  async newsHits(symbol: string, opts: { sinceDays?: number; limit?: number } = {}): Promise<NewsHit[]> {
    try {
      return newsItemsToHits(await this.client.newsItems(symbol, opts));
    } catch (err) {
      this.miss("news", String(err).slice(0, 200));
      return [];
    }
  }
}

/**
 * The switch, resolved once at boot. `undefined` when `NICHEDB_MARKETS` is off,
 * which is what every call site tests — with it undefined, no code path can
 * construct a client, so no request can be made.
 */
export function nichedbMarketsFromEnv(
  env: Record<string, string | undefined> = process.env,
  opts: { fetch?: typeof fetch; onMiss?: (what: string, why: string) => void } = {},
): NichedbMarkets | undefined {
  if (!nichedbEnabled(env)) return undefined;
  return new NichedbMarkets(new NichedbClient({ baseUrl: env.NICHEDB_URL, fetch: opts.fetch }), { onMiss: opts.onMiss });
}
