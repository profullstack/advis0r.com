/**
 * Crypto asset fundamentals — market capitalisation, supply, ATH.
 *
 * This is the one place the crypto path uses a vendor other than Alpaca, and
 * that is deliberate rather than casual: Alpaca's market-data API carries no
 * supply figure, and market cap cannot be derived from a price without one.
 * The alternative was to invent a supply number, which is not an alternative.
 *
 * CoinGecko's public endpoint answers unauthenticated, matching the rest of
 * this path — no new credential, and the page degrades to "—" if it is
 * unreachable rather than failing.
 *
 * PROVENANCE. These figures are market-wide and priced by CoinGecko; every
 * other number on a crypto page comes from Alpaca's US venue. The two are not
 * interchangeable and are labelled separately wherever they appear together.
 * In particular `volume24h` here is aggregate market volume, which is a
 * different quantity from the venue volume shown beside it — conflating them
 * would overstate liquidity by orders of magnitude.
 */

const BASE_URL = "https://api.coingecko.com/api/v3";

/**
 * Base asset -> CoinGecko id. Explicit ids rather than symbol search: tickers
 * collide across hundreds of listings, and resolving "UNI" or "GRT" by symbol
 * would eventually pick up an impostor. Verified against the API on
 * 2026-08-07 — every id below returned the expected symbol.
 */
const COINGECKO_IDS: Record<string, string> = {
  AAVE: "aave",
  ADA: "cardano",
  AVAX: "avalanche-2",
  BAT: "basic-attention-token",
  BCH: "bitcoin-cash",
  BTC: "bitcoin",
  CRV: "curve-dao-token",
  DOGE: "dogecoin",
  DOT: "polkadot",
  ETH: "ethereum",
  GRT: "the-graph",
  LDO: "lido-dao",
  LINK: "chainlink",
  LTC: "litecoin",
  // MATIC and MKR are deliberately mapped to their legacy ids, which is what
  // Alpaca actually lists. Both have since migrated (MATIC->POL, MKR->SKY), so
  // those entries now report zero supply and stop updating. The staleness and
  // non-positive guards below are what stop that being rendered as fact; the
  // fix is NOT to point them at the successor token, which is a different
  // asset from the one being priced.
  MATIC: "matic-network",
  MKR: "maker",
  PEPE: "pepe",
  SHIB: "shiba-inu",
  SOL: "solana",
  SUSHI: "sushi",
  TRUMP: "official-trump",
  UNI: "uniswap",
  USDC: "usd-coin",
  USDT: "tether",
  XRP: "ripple",
  XTZ: "tezos",
  YFI: "yearn-finance",
};

/**
 * Older than this and the record is treated as unavailable. A delisted or
 * migrated token keeps returning its last known values indefinitely; printing
 * a six-month-old supply figure next to a live price is the "stale data
 * wearing the costume of live data" failure this codebase exists to avoid.
 */
const MAX_AGE_MS = 7 * 86_400_000;

export interface AssetFundamentals {
  base: string;
  coingeckoId: string;
  marketCap: number | null;
  marketCapRank: number | null;
  fullyDilutedValuation: number | null;
  circulatingSupply: number | null;
  totalSupply: number | null;
  maxSupply: number | null;
  ath: number | null;
  athDate: string | null;
  athChangePercent: number | null;
  /** Aggregate 24h market volume — NOT the venue volume shown elsewhere. */
  volume24h: number | null;
  /** CoinGecko's own timestamp, so the reader can judge freshness. */
  lastUpdated: string | null;
  /** Set when the record was rejected, naming why. */
  unavailableReason?: string;
}

/** A value only counts if it is a positive, finite number. */
function positive(n: unknown): number | null {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export interface FundamentalsOptions {
  baseUrl?: string;
  requestTimeoutMs?: number;
  /** How long a successful fetch is reused. CoinGecko's free tier is rate limited. */
  cacheTtlMs?: number;
  now?: () => number;
}

export class CryptoFundamentalsClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private cache: { at: number; byBase: Map<string, AssetFundamentals> } | null = null;
  private inFlight: Promise<Map<string, AssetFundamentals>> | null = null;

  constructor(options: FundamentalsOptions = {}) {
    this.baseUrl = (options.baseUrl || BASE_URL).replace(/\/$/, "");
    this.timeoutMs = options.requestTimeoutMs ?? 8_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Every asset in one request, cached — traffic does not scale upstream calls. */
  private async loadAll(): Promise<Map<string, AssetFundamentals>> {
    const fresh = this.cache && this.now() - this.cache.at < this.cacheTtlMs;
    if (fresh) return this.cache!.byBase;
    // Collapse concurrent misses into one request rather than stampeding a
    // rate-limited free tier.
    if (this.inFlight) return this.inFlight;

    this.inFlight = (async () => {
      const ids = [...new Set(Object.values(COINGECKO_IDS))].join(",");
      const url = new URL(`${this.baseUrl}/coins/markets`);
      url.searchParams.set("vs_currency", "usd");
      url.searchParams.set("ids", ids);
      url.searchParams.set("per_page", "250");

      const res = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) throw new Error(`CoinGecko ${res.status}`);
      const rows = (await res.json()) as any[];

      const byId = new Map<string, any>(rows.map((r) => [r.id, r]));
      const byBase = new Map<string, AssetFundamentals>();
      for (const [base, id] of Object.entries(COINGECKO_IDS)) {
        const r = byId.get(id);
        if (!r) continue;
        byBase.set(base, this.toFundamentals(base, id, r));
      }
      this.cache = { at: this.now(), byBase };
      return byBase;
    })();

    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private toFundamentals(base: string, id: string, r: any): AssetFundamentals {
    const empty: AssetFundamentals = {
      base, coingeckoId: id,
      marketCap: null, marketCapRank: null, fullyDilutedValuation: null,
      circulatingSupply: null, totalSupply: null, maxSupply: null,
      ath: null, athDate: null, athChangePercent: null,
      volume24h: null, lastUpdated: r.last_updated ?? null,
    };

    const age = r.last_updated ? this.now() - Date.parse(r.last_updated) : NaN;
    if (Number.isFinite(age) && age > MAX_AGE_MS) {
      const days = Math.round(age / 86_400_000);
      return {
        ...empty,
        unavailableReason: `the upstream record has not updated in ${days} days, so its figures are not current`,
      };
    }
    if (positive(r.market_cap) == null && positive(r.circulating_supply) == null) {
      // Both zero is the signature of a migrated or delisted token.
      return {
        ...empty,
        unavailableReason:
          "the upstream reports no circulating supply for this asset, which usually means it has migrated to a successor token",
      };
    }

    return {
      base,
      coingeckoId: id,
      marketCap: positive(r.market_cap),
      marketCapRank: positive(r.market_cap_rank),
      fullyDilutedValuation: positive(r.fully_diluted_valuation),
      circulatingSupply: positive(r.circulating_supply),
      totalSupply: positive(r.total_supply),
      maxSupply: positive(r.max_supply),
      ath: positive(r.ath),
      athDate: r.ath_date ?? null,
      athChangePercent: Number.isFinite(Number(r.ath_change_percentage))
        ? Number(r.ath_change_percentage)
        : null,
      volume24h: positive(r.total_volume),
      lastUpdated: r.last_updated ?? null,
    };
  }

  /** Null when unknown or unreachable — never throws into a page render. */
  async get(base: string): Promise<AssetFundamentals | null> {
    if (!COINGECKO_IDS[base]) return null;
    try {
      return (await this.loadAll()).get(base) ?? null;
    } catch {
      return null;
    }
  }
}

/** Exposed for tests and for documenting coverage. */
export const FUNDAMENTALS_ASSETS = Object.keys(COINGECKO_IDS);
