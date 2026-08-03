/**
 * Builds the market summary a digest reports on.
 *
 * The summary is assembled once per run and shared by every recipient: the
 * expensive parts (daily bars, company names, headlines) are fetched for the
 * union of all watchlisted tickers, then each user's email is composed from that
 * cache. A thousand subscribers watching the same fifty tickers costs fifty
 * lookups, not fifty thousand.
 *
 * Nothing here invents a number. When a provider has no bar for a session the
 * ticker is reported as unavailable rather than filled in from a nearby day —
 * a wrong price in an email is worse than a visible gap.
 */
import type { Client } from "@libsql/client";
import type { MarketBar } from "../types.ts";
import type { AlpacaMarketDataClient } from "../providers/interfaces.ts";
import { addDays, etDate, type DigestWindow } from "./schedule.ts";

/** Broad-market context shown above the user's own tickers. */
export const MARKET_INDICES: ReadonlyArray<{ symbol: string; label: string }> = [
  { symbol: "SPY", label: "S&P 500" },
  { symbol: "QQQ", label: "Nasdaq 100" },
  { symbol: "IWM", label: "Russell 2000" },
  { symbol: "DIA", label: "Dow 30" },
];

export interface Performance {
  ticker: string;
  label?: string;
  companyName?: string;
  /** Number of sessions actually covered by the numbers below. */
  sessions: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  /** Close of the session immediately before the window, when known. */
  previousClose?: number;
  changeAbs?: number;
  changePercent?: number;
}

export interface Headline {
  ticker: string;
  title: string;
  url: string;
  publisher?: string;
  publishedAt?: string;
}

export interface MarketSummary {
  window: DigestWindow;
  /** Broad-market movers for the same window. */
  indices: Performance[];
  /** Per-ticker performance, keyed by symbol. */
  byTicker: Map<string, Performance>;
  /** Tickers with no usable market data this window. */
  unavailable: Set<string>;
  /** Recent coverage, keyed by symbol. */
  headlines: Map<string, Headline[]>;
  /** Where the price data came from, for the email footer. */
  source: string;
  /** Populated when market data could not be fetched at all. */
  marketError?: string;
}

export interface SummaryDeps {
  db: Client;
  market: AlpacaMarketDataClient;
  marketSource?: string;
}

/**
 * Fetch everything the window needs for the given tickers.
 *
 * Bars are requested from well before the window so the pre-window close — the
 * baseline every percentage is measured against — is present even across a long
 * holiday weekend.
 */
export async function buildMarketSummary(
  deps: SummaryDeps,
  window: DigestWindow,
  tickers: string[],
): Promise<MarketSummary> {
  const indexSymbols = MARKET_INDICES.map((i) => i.symbol);
  const symbols = [...new Set([...indexSymbols, ...tickers.map((t) => t.toUpperCase())])];

  const firstSession = window.sessions[0]!;
  const lastSession = window.sessions.at(-1)!;
  const start = addDays(firstSession, -14);
  // Alpaca's `end` is exclusive of later data but inclusive of the day itself;
  // asking through the send date guarantees the last session is included.
  const end = window.sendDate;

  let bars: MarketBar[] = [];
  let marketError: string | undefined;
  try {
    bars = await deps.market.getBars({ symbols, timeframe: "1Day", start, end });
  } catch (err) {
    marketError = String(err).slice(0, 300);
  }

  const bySymbol = new Map<string, Map<string, MarketBar>>();
  for (const bar of bars) {
    const sym = bar.symbol.toUpperCase();
    // Map each bar to the Eastern session it belongs to: providers timestamp
    // daily bars at midnight ET (Alpaca) or the opening bell (Yahoo), and only
    // one of those survives a naive UTC date slice.
    const session = etDate(new Date(bar.timestamp));
    let sessions = bySymbol.get(sym);
    if (!sessions) bySymbol.set(sym, (sessions = new Map()));
    sessions.set(session, bar);
  }

  const byTicker = new Map<string, Performance>();
  const unavailable = new Set<string>();
  for (const symbol of symbols) {
    const perf = performanceFor(bySymbol.get(symbol), window, firstSession);
    if (perf) byTicker.set(symbol, { ...perf, ticker: symbol });
    else if (!indexSymbols.includes(symbol)) unavailable.add(symbol);
  }

  const names = await companyNames(deps.db, [...byTicker.keys()]);
  for (const [symbol, perf] of byTicker) {
    const name = names.get(symbol);
    if (name) perf.companyName = name;
  }

  const indices = MARKET_INDICES.flatMap((i) => {
    const perf = byTicker.get(i.symbol);
    return perf ? [{ ...perf, label: i.label }] : [];
  });

  return {
    window,
    indices,
    byTicker,
    unavailable,
    headlines: await recentHeadlines(deps.db, tickers, firstSession),
    source: deps.marketSource ?? "market data",
    marketError,
  };
}

/** Aggregate a symbol's bars across the window into one performance row. */
function performanceFor(
  sessions: Map<string, MarketBar> | undefined,
  window: DigestWindow,
  firstSession: string,
): Omit<Performance, "ticker"> | null {
  if (!sessions?.size) return null;
  const covered = window.sessions.flatMap((d) => {
    const bar = sessions.get(d);
    return bar ? [bar] : [];
  });
  if (!covered.length) return null;

  const first = covered[0]!;
  const last = covered.at(-1)!;
  // The baseline is the last close before the window opened — that is what makes
  // a weekly digest report the week's move rather than the final day's.
  const priorDates = [...sessions.keys()].filter((d) => d < firstSession).sort();
  const previousClose = priorDates.length ? sessions.get(priorDates.at(-1)!)!.close : undefined;
  const baseline = previousClose ?? first.open;

  const changeAbs = baseline ? last.close - baseline : undefined;
  return {
    sessions: covered.length,
    open: first.open,
    high: Math.max(...covered.map((b) => b.high)),
    low: Math.min(...covered.map((b) => b.low)),
    close: last.close,
    volume: covered.reduce((sum, b) => sum + (b.volume ?? 0), 0),
    previousClose,
    changeAbs,
    changePercent: baseline && changeAbs != null ? (changeAbs / baseline) * 100 : undefined,
  };
}

/** Company names already indexed locally — no extra provider calls. */
async function companyNames(db: Client, tickers: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!tickers.length) return out;
  try {
    const ph = tickers.map(() => "?").join(",");
    const rs = await db.execute({
      sql: `SELECT t.symbol AS symbol, c.name AS name
            FROM tickers t JOIN companies c ON c.id = t.company_id
            WHERE t.symbol IN (${ph})`,
      args: tickers,
    });
    for (const row of rs.rows) {
      if (row.name) out.set(String(row.symbol).toUpperCase(), String(row.name));
    }
  } catch {
    /* names are decoration; a schema without them must not break the digest */
  }
  return out;
}

/** Indexed coverage published since the window opened, newest first. */
async function recentHeadlines(
  db: Client,
  tickers: string[],
  since: string,
): Promise<Map<string, Headline[]>> {
  const out = new Map<string, Headline[]>();
  if (!tickers.length) return out;
  try {
    const ph = tickers.map(() => "?").join(",");
    const rs = await db.execute({
      sql: `SELECT t.primary_ticker AS ticker, d.title AS title, d.url AS url,
                   d.publisher AS publisher, d.published_at AS published_at
            FROM documents d JOIN transcripts t ON t.document_id = d.id
            WHERE t.primary_ticker IN (${ph}) AND d.published_at >= ?
            ORDER BY d.published_at DESC
            LIMIT 200`,
      args: [...tickers.map((t) => t.toUpperCase()), since],
    });
    for (const row of rs.rows) {
      const ticker = String(row.ticker).toUpperCase();
      const list = out.get(ticker) ?? [];
      if (list.length >= 3) continue; // per-ticker cap keeps the email readable
      list.push({
        ticker,
        title: String(row.title ?? row.url),
        url: String(row.url),
        publisher: row.publisher ? String(row.publisher) : undefined,
        publishedAt: row.published_at ? String(row.published_at) : undefined,
      });
      out.set(ticker, list);
    }
  } catch {
    /* headlines are optional context */
  }
  return out;
}

/** One user's slice of the shared summary, ordered biggest move first. */
export interface UserSummary {
  rows: Performance[];
  unavailable: string[];
  headlines: Headline[];
  gainers: Performance[];
  losers: Performance[];
}

export function summaryForTickers(summary: MarketSummary, tickers: string[]): UserSummary {
  const wanted = tickers.map((t) => t.toUpperCase());
  const rows = wanted
    .flatMap((t) => {
      const perf = summary.byTicker.get(t);
      return perf ? [perf] : [];
    })
    .sort((a, b) => Math.abs(b.changePercent ?? 0) - Math.abs(a.changePercent ?? 0));

  const moved = rows.filter((r) => r.changePercent != null);
  return {
    rows,
    unavailable: wanted.filter((t) => summary.unavailable.has(t)),
    headlines: wanted.flatMap((t) => summary.headlines.get(t) ?? []).slice(0, 8),
    gainers: moved.filter((r) => (r.changePercent ?? 0) > 0).sort((a, b) => b.changePercent! - a.changePercent!),
    losers: moved.filter((r) => (r.changePercent ?? 0) < 0).sort((a, b) => a.changePercent! - b.changePercent!),
  };
}
