/**
 * Crypto pair directory and symbol normalization.
 *
 * Alpaca writes pairs as `BASE/QUOTE` ("BTC/USD"). A slash is hostile in a URL
 * path, so every route here also accepts the dash form ("BTC-USD"), the bare
 * base ("BTC" -> BTC/USD) and the concatenated form ("BTCUSD"). One canonical
 * value comes back out, so callers never have to care which they sent.
 *
 * The pair list is a seed, not a guess: it was probed against
 * `data.alpaca.markets/v1beta3/crypto/us/latest/bars` on 2026-08-06 and holds
 * only pairs that actually returned a bar. Re-probe with:
 *
 *   curl -s 'https://data.alpaca.markets/v1beta3/crypto/us/latest/bars?symbols=<csv>'
 *
 * `/api/crypto/assets` additionally marks each pair live/idle from a real
 * response, so a delisting shows up without a code change.
 */

/** Quote currencies Alpaca's US crypto venue settles in, longest-first. */
export const QUOTE_CURRENCIES = ["USDT", "USDC", "USD", "BTC"] as const;

/** Display names for every base asset in the supported set. */
const ASSET_NAMES: Record<string, string> = {
  AAVE: "Aave",
  ADA: "Cardano",
  AVAX: "Avalanche",
  BAT: "Basic Attention Token",
  BCH: "Bitcoin Cash",
  BTC: "Bitcoin",
  CRV: "Curve DAO",
  DOGE: "Dogecoin",
  DOT: "Polkadot",
  ETH: "Ethereum",
  GRT: "The Graph",
  LDO: "Lido DAO",
  LINK: "Chainlink",
  LTC: "Litecoin",
  MATIC: "Polygon",
  MKR: "Maker",
  PEPE: "Pepe",
  SHIB: "Shiba Inu",
  SOL: "Solana",
  SUSHI: "SushiSwap",
  TRUMP: "Official Trump",
  UNI: "Uniswap",
  USDC: "USD Coin",
  USDT: "Tether",
  XRP: "XRP",
  XTZ: "Tezos",
  YFI: "yearn.finance",
};

/** Common aliases people actually type, mapped to a base asset. */
const NAME_ALIASES: Record<string, string> = {
  bitcoin: "BTC",
  btc: "BTC",
  xbt: "BTC",
  ether: "ETH",
  ethereum: "ETH",
  eth: "ETH",
  ripple: "XRP",
  solana: "SOL",
  cardano: "ADA",
  polkadot: "DOT",
  dogecoin: "DOGE",
  doge: "DOGE",
  litecoin: "LTC",
  polygon: "MATIC",
  matic: "MATIC",
  chainlink: "LINK",
  uniswap: "UNI",
  tether: "USDT",
  usdcoin: "USDC",
  "usd coin": "USDC",
  "bitcoin cash": "BCH",
  bcash: "BCH",
  avalanche: "AVAX",
  tezos: "XTZ",
  maker: "MKR",
  aave: "AAVE",
  "shiba inu": "SHIB",
  shiba: "SHIB",
  pepe: "PEPE",
  "the graph": "GRT",
  "curve dao": "CRV",
  curve: "CRV",
  "lido dao": "LDO",
  lido: "LDO",
  sushiswap: "SUSHI",
  "basic attention token": "BAT",
  "yearn finance": "YFI",
  "yearn.finance": "YFI",
  trump: "TRUMP",
};

/**
 * Every pair Alpaca's US crypto feed served on the probe date. Keeping the
 * quote grouping explicit documents that e.g. ADA trades against USD only.
 */
const PAIRS_BY_QUOTE: Record<string, string[]> = {
  USD: [
    "AAVE", "ADA", "AVAX", "BAT", "BCH", "BTC", "CRV", "DOGE", "DOT", "ETH",
    "GRT", "LDO", "LINK", "LTC", "MATIC", "MKR", "PEPE", "SHIB", "SOL",
    "SUSHI", "TRUMP", "UNI", "USDC", "USDT", "XRP", "XTZ", "YFI",
  ],
  USDT: ["AAVE", "AVAX", "BCH", "BTC", "DOGE", "ETH", "LINK", "LTC", "SOL", "UNI", "YFI"],
  USDC: ["BTC", "DOGE", "ETH", "SOL"],
  BTC: ["AVAX", "BCH", "DOGE", "ETH", "LINK", "LTC", "UNI"],
};

export interface CryptoPair {
  /** Canonical Alpaca form, e.g. "BTC/USD". */
  symbol: string;
  /** URL-safe form used in paths, e.g. "BTC-USD". */
  slug: string;
  base: string;
  quote: string;
  name: string;
}

function build(): CryptoPair[] {
  const out: CryptoPair[] = [];
  for (const [quote, bases] of Object.entries(PAIRS_BY_QUOTE)) {
    for (const base of bases) {
      out.push({
        symbol: `${base}/${quote}`,
        slug: `${base}-${quote}`,
        base,
        quote,
        name: ASSET_NAMES[base] ?? base,
      });
    }
  }
  return out.sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export const SUPPORTED_PAIRS: CryptoPair[] = build();

const BY_SYMBOL = new Map(SUPPORTED_PAIRS.map((p) => [p.symbol, p]));
const BASES = new Set(SUPPORTED_PAIRS.map((p) => p.base));

/** The quote used when someone names a bare asset ("BTC" -> "BTC/USD"). */
export const DEFAULT_QUOTE = "USD";

/**
 * Turn any reasonable spelling of a pair into the canonical `BASE/QUOTE`.
 * Returns null when the result is not a pair Alpaca actually serves — callers
 * should 400 rather than forward an unknown symbol upstream.
 */
export function normalizePair(input: string | null | undefined): string | null {
  if (!input) return null;
  const raw = input.trim().toUpperCase().replace(/[\s_]+/g, "");
  if (!raw) return null;

  // Explicit separator: BTC/USD, BTC-USD.
  const parts = raw.split(/[/-]/).filter(Boolean);
  if (parts.length === 2) {
    const candidate = `${parts[0]}/${parts[1]}`;
    return BY_SYMBOL.has(candidate) ? candidate : null;
  }
  if (parts.length !== 1) return null;

  const only = parts[0]!;
  // Bare base asset — default to the USD pair.
  if (BASES.has(only) && BY_SYMBOL.has(`${only}/${DEFAULT_QUOTE}`)) {
    return `${only}/${DEFAULT_QUOTE}`;
  }
  // Concatenated: BTCUSD, ETHUSDT. Longest quote wins so BTCUSDT does not
  // resolve to BTCUSD + a stray "T".
  for (const quote of QUOTE_CURRENCIES) {
    if (only.length > quote.length && only.endsWith(quote)) {
      const candidate = `${only.slice(0, -quote.length)}/${quote}`;
      if (BY_SYMBOL.has(candidate)) return candidate;
    }
  }
  return null;
}

/** Parse a comma-separated `?symbols=` list, preserving order and de-duping. */
export function normalizePairs(input: string | null | undefined): {
  pairs: string[];
  rejected: string[];
} {
  const pairs: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  for (const part of (input ?? "").split(",")) {
    const token = part.trim();
    if (!token) continue;
    const pair = normalizePair(token);
    if (!pair) {
      rejected.push(token);
    } else if (!seen.has(pair)) {
      seen.add(pair);
      pairs.push(pair);
    }
  }
  return { pairs, rejected };
}

export function getPair(symbol: string): CryptoPair | undefined {
  return BY_SYMBOL.get(symbol);
}

/**
 * Find pairs by asset name or ticker — the crypto twin of /api/lookup.
 * "bitcoin" -> BTC/USD first, then the other BTC-quoted pairs.
 */
export function lookupPairs(query: string, limit = 10): CryptoPair[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];

  const aliasBase = NAME_ALIASES[q];
  const scored: Array<{ pair: CryptoPair; score: number }> = [];

  for (const pair of SUPPORTED_PAIRS) {
    const base = pair.base.toLowerCase();
    const name = pair.name.toLowerCase();
    let score = 0;

    if (aliasBase && pair.base === aliasBase) score = 100;
    else if (base === q || pair.symbol.toLowerCase() === q) score = 95;
    else if (name === q) score = 90;
    else if (name.startsWith(q)) score = 70;
    else if (base.startsWith(q)) score = 60;
    else if (name.includes(q)) score = 40;
    else continue;

    // Prefer the USD pair — it is the one a person means by "bitcoin".
    if (pair.quote === DEFAULT_QUOTE) score += 5;
    scored.push({ pair, score });
  }

  return scored
    .sort(
      (a, b) =>
        b.score - a.score ||
        // On a prefix tie the shorter name is the better answer: "bitc" means
        // Bitcoin, not Bitcoin Cash.
        a.pair.name.length - b.pair.name.length ||
        a.pair.symbol.localeCompare(b.pair.symbol),
    )
    .slice(0, Math.max(0, limit))
    .map((s) => s.pair);
}
