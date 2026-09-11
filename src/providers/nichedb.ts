/**
 * nichedb.dev client — the shared market mirror.
 *
 * nichedb fetches the US symbol directory (Alpaca assets), daily price history
 * (Alpaca bars) and SEC XBRL fundamentals once, for every site, and serves them
 * as items in its `markets` collection. This client reads those items; it never
 * writes, needs no key, and is rate-limited per IP (~600 requests an hour), so
 * every caller here asks for exactly one page and lets the site cache the rest.
 *
 * The contract (kinds, tags, `data` shapes) is nichedb's docs/markets.md and
 * docs/consolidation.md. The shapes are typed here; the mapping into the
 * site's own types lives in nichedb-markets.ts so this file stays a wire client.
 *
 * `fetch` is injectable so the mapping can be tested with fixtures and so the
 * switch-off case ("no nichedb request is ever made") is provable.
 */

export const DEFAULT_NICHEDB_URL = "https://nichedb.dev";
const USER_AGENT = "advis0r.com/2.0 (research)";
const TIMEOUT_MS = 15_000;
/** The API caps `limit` at 200 for anonymous reads; a walker asks for the cap. */
export const PAGE_LIMIT = 200;

/** One item as `GET /api/v1/items` returns it. */
export interface NichedbItem {
  id: number;
  collection: string;
  source?: string;
  adapter?: string;
  kind: string;
  external_id: string;
  updated_at: string;
  title: string | null;
  summary: string | null;
  url: string | null;
  image_url: string | null;
  published_at: string | null;
  tags: string[];
  data: Record<string, unknown>;
}

/** `data` of a `kind=symbol` item (one per active Alpaca asset). */
export interface NichedbSymbolData {
  assetId: string;
  symbol: string;
  name: string;
  exchange: string;
  assetClass: "us_equity" | "crypto";
  status: string;
  tradable: boolean;
  marginable?: boolean;
  shortable?: boolean;
  easyToBorrow?: boolean;
  fractionable?: boolean;
  attributes?: string[];
}

/** One bar of a `history` item: day, open, high, low, close, volume, vwap. */
export type NichedbBarTuple = [string, number, number, number, number, number, number | null];

/** `data` of a `kind=history` item (last 400 daily bars, oldest first). */
export interface NichedbHistoryData {
  symbol: string;
  timeframe: "1Day";
  feed: "iex" | "sip";
  adjustment: "split";
  bars: NichedbBarTuple[];
  first: string;
  last: string;
  count: number;
}

/** One XBRL point in a `fundamentals` item's `concepts`. */
export interface NichedbFactPoint {
  start: string | null;
  end: string;
  val: number;
  fy: number | null;
  fp: string | null;
  form: string;
  filed: string;
  unit: string;
}

/** `data` of a `kind=fundamentals` item (one per CIK). */
export interface NichedbFundamentalsData {
  cik: number | string;
  symbol: string;
  symbols: string[];
  name: string;
  exchange: string | null;
  concepts: Record<string, NichedbFactPoint[]>;
  latest: {
    revenue?: number | null;
    grossProfit?: number | null;
    operatingIncome?: number | null;
    netIncome?: number | null;
    epsDiluted?: number | null;
    epsBasic?: number | null;
    assets?: number | null;
    liabilities?: number | null;
    equity?: number | null;
    cash?: number | null;
    operatingCashFlow?: number | null;
    sharesOutstanding?: number | null;
    publicFloat?: number | null;
    longTermDebt?: number | null;
    period?: string | null;
    fp?: string | null;
    fy?: number | null;
    form?: string | null;
    filed?: string | null;
  };
}

/** `data` of a market-news item from the `alpaca-news` adapter. */
export interface NichedbNewsData {
  newsId?: number | string;
  author: string | null;
  source: string | null;
  symbols: string[];
  updatedAt?: string | null;
}

/**
 * The kind the alpaca-news adapter emits. The markets doc calls it "news"; the
 * adapter (`packages/adapters/src/alpaca.js`, `newsToItem`) writes
 * `kind: 'market-news'`, and the kind is also its first tag.
 */
export const NEWS_KIND = "market-news";

export interface ItemsQuery {
  collection: string;
  kind?: string;
  /** Every tag named must be on the item. */
  tags?: string[];
  /** `published_at >= from` (ISO). */
  from?: string;
  /** `published_at < to` (ISO). */
  to?: string;
  /** `updated_at >= since` (ISO) — what a mirror asks. */
  since?: string;
  /** Keyset pagination on the item id, pairs with `sort=id&order=asc`. */
  after?: number;
  limit?: number;
  sort?: "id" | "published" | "updated";
  order?: "asc" | "desc";
}

export interface NichedbClientOptions {
  /** Base URL; `NICHEDB_URL` in the environment, else https://nichedb.dev. */
  baseUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => number;
}

export type MirrorPage = { items: NichedbItem[]; page: number };

export class NichedbClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly now: () => number;
  /** Requests made by this instance, so a caller can budget and a test can count. */
  requests = 0;

  constructor(opts: NichedbClientOptions = {}) {
    this.baseUrl = (opts.baseUrl ?? process.env.NICHEDB_URL ?? DEFAULT_NICHEDB_URL).replace(/\/$/, "");
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? TIMEOUT_MS;
    this.now = opts.now ?? Date.now;
  }

  /** The `/api/v1/items` URL for a query. Pure, so tests can check exactly what is asked. */
  itemsUrl(q: ItemsQuery): string {
    const url = new URL(`${this.baseUrl}/api/v1/items`);
    url.searchParams.set("collection", q.collection);
    if (q.kind) url.searchParams.set("kind", q.kind);
    if (q.tags?.length) url.searchParams.set("tags", q.tags.map(normalizeTag).join(","));
    if (q.from) url.searchParams.set("from", q.from);
    if (q.to) url.searchParams.set("to", q.to);
    if (q.since) url.searchParams.set("since", q.since);
    if (q.after != null) url.searchParams.set("after", String(q.after));
    if (q.sort) url.searchParams.set("sort", q.sort);
    if (q.order) url.searchParams.set("order", q.order);
    url.searchParams.set("limit", String(Math.min(PAGE_LIMIT, Math.max(1, q.limit ?? 50))));
    return url.toString();
  }

  /** The `/api/v1/match` URL: best items for a name, by trigram similarity on `title`. */
  matchUrl(params: { collection: string; q: string; kind?: string; limit?: number }): string {
    const url = new URL(`${this.baseUrl}/api/v1/match`);
    url.searchParams.set("collection", params.collection);
    url.searchParams.set("q", params.q);
    if (params.kind) url.searchParams.set("kind", params.kind);
    url.searchParams.set("limit", String(Math.max(1, params.limit ?? 5)));
    return url.toString();
  }

  private async getJson(url: string): Promise<{ items?: NichedbItem[] }> {
    this.requests += 1;
    const res = await this.fetchImpl(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json" },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`nichedb ${res.status} for ${url.replace(this.baseUrl, "")}`);
    }
    return (await res.json()) as { items?: NichedbItem[] };
  }

  async items(q: ItemsQuery): Promise<NichedbItem[]> {
    const body = await this.getJson(this.itemsUrl(q));
    return Array.isArray(body.items) ? body.items : [];
  }

  /**
   * The `symbol` item for a ticker.
   *
   * `symbol` items carry no `symbol:<sym>` tag (the contract says the directory
   * is the lookup), so a single-symbol read goes through `/api/v1/match` on the
   * title — `AAPL · Apple Inc. Common Stock` — and is verified against
   * `data.symbol`, so a near-miss on a similar ticker is never returned.
   */
  async symbolItem(symbol: string): Promise<NichedbItem | null> {
    const wanted = symbol.toUpperCase();
    const body = await this.getJson(this.matchUrl({ collection: "markets", kind: "symbol", q: wanted, limit: 5 }));
    const items = Array.isArray(body.items) ? body.items : [];
    return items.find((i) => String((i.data as { symbol?: unknown })?.symbol ?? "").toUpperCase() === wanted) ?? null;
  }

  /** The `history` item (last 400 daily bars) for a symbol, or null. */
  async historyItem(symbol: string): Promise<NichedbItem | null> {
    const items = await this.items({
      collection: "markets",
      kind: "history",
      tags: [symbolTag(symbol)],
      limit: 1,
    });
    return items[0] ?? null;
  }

  /**
   * The `fundamentals` item for a ticker or a CIK. A company that lists several
   * tickers is one item tagged with all of them, so either spelling finds it.
   */
  async fundamentalsItem(symbolOrCik: string): Promise<NichedbItem | null> {
    const key = String(symbolOrCik).trim();
    const tag = /^\d+$/.test(key) ? `cik:${Number(key)}` : symbolTag(key);
    const items = await this.items({ collection: "markets", kind: "fundamentals", tags: [tag], limit: 1 });
    return items[0] ?? null;
  }

  /**
   * Market-news items about a symbol, newest first. Stories are tagged with
   * their lowercased tickers (`aapl`), and the window is on `published_at`,
   * which is what "news from the last N days" means; `updated_at` would let a
   * backfill of old stories through.
   */
  async newsItems(symbol: string, opts: { sinceDays?: number; limit?: number } = {}): Promise<NichedbItem[]> {
    const days = opts.sinceDays ?? 90;
    const from = new Date(this.now() - days * 86_400_000).toISOString();
    return this.items({
      collection: "markets",
      kind: NEWS_KIND,
      tags: [symbol.toLowerCase()],
      from,
      sort: "published",
      order: "desc",
      limit: opts.limit ?? 50,
    });
  }

  /**
   * Walk every `symbol` item, a page at a time.
   *
   * Keyset on the item id (`sort=id&order=asc&after=<last id>`), which is stable
   * while the walk runs, filtered by `since` on `updated_at` so a daily sync
   * after the first only reads what moved. The caller keeps the cursor: the
   * newest `updated_at` seen is what to pass as `since` next time.
   */
  async *mirrorSymbols(opts: { since?: string; maxPages?: number } = {}): AsyncGenerator<MirrorPage> {
    const maxPages = opts.maxPages ?? 200;
    let after: number | undefined;
    for (let page = 0; page < maxPages; page++) {
      const items = await this.items({
        collection: "markets",
        kind: "symbol",
        since: opts.since,
        after,
        sort: "id",
        order: "asc",
        limit: PAGE_LIMIT,
      });
      if (!items.length) return;
      yield { items, page };
      if (items.length < PAGE_LIMIT) return;
      after = items[items.length - 1]!.id;
    }
  }
}

/** `symbol:<symbol>` tag — lower-case, Alpaca's spelling (`symbol:brk.b`). */
export function symbolTag(symbol: string): string {
  return `symbol:${symbol.trim().toLowerCase()}`;
}

function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase();
}

/** The switch. `NICHEDB_MARKETS=1` (or `true`) reads shared market data from nichedb. */
export function nichedbEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const v = (env.NICHEDB_MARKETS ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}
