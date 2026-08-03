/**
 * Where directory entries come from.
 *
 * Two sources, chosen by what the deployment has rather than by configuration:
 *
 *   - **Alpaca asset list** — one request returns every tradable US equity
 *     (~11k rows) with name and exchange. Needs credentials, and gives a
 *     directory that answers every lookup locally.
 *   - **Yahoo search** — keyless, per-query. Covers deployments with no Alpaca
 *     keys, and fills gaps in a synced directory (a fresh listing, an ETF the
 *     asset list omits). Results are cached, so a given miss costs one call.
 *
 * The point of the split is that lookup must work with no keys at all. A
 * feature whose job is "type a company name" cannot be the one that requires
 * a paid data provider.
 */
import type { AlpacaMarketDataClient } from "../providers/interfaces.ts";
import type { SymbolRow } from "./directory.ts";

const YAHOO_SEARCH = "https://query2.finance.yahoo.com/v1/finance/search";
const UA = "Mozilla/5.0 (advis0r.com research)";

/** Quote types worth listing. Options, futures and currencies are noise here. */
const USEFUL_TYPES = new Set(["EQUITY", "ETF"]);

/**
 * Venues the rest of the app can actually price.
 *
 * Yahoo happily returns foreign cross-listings — RIVN.MX, 0R2V.L — and the
 * symbol shape alone cannot reject them, because "RIVN.MX" is indistinguishable
 * from a legitimate class suffix like "BRK.B". Filtering on the venue is what
 * separates the two, and matters because offering a Mexican listing would
 * resolve to a ticker every other endpoint here fails to price.
 */
const US_EXCHANGES = new Set(["NASDAQ", "NYSE", "AMEX", "ARCA", "BATS", "OTC"]);

/**
 * Full tradable-asset list from the market client.
 *
 * Returns [] when the client cannot provide one — the Yahoo fallback client
 * answers `getAssets()` with an empty array when given no symbols, which is
 * exactly the "no bulk source available" signal the caller needs.
 */
export async function fetchAlpacaDirectory(market: AlpacaMarketDataClient): Promise<SymbolRow[]> {
  const assets = await market.getAssets();
  return assets
    .filter((a) => a.symbol && a.name)
    .map((a) => ({
      symbol: a.symbol,
      name: a.name,
      exchange: a.exchange,
      assetClass: a.assetClass,
      status: a.status,
      // An untradable asset can still be worth *finding* — it is only ranked
      // below tradable ones — but a delisted shell should not be offered as a
      // watchlist suggestion, so the flag is carried through honestly.
      tradable: a.tradable !== false && a.status !== "inactive",
      source: "alpaca" as const,
    }));
}

/**
 * Yahoo's search endpoint. Keyless, and the only name→ticker source that works
 * with no configuration at all.
 *
 * Failures are swallowed to an empty list rather than thrown: a lookup that
 * finds nothing is a normal outcome the UI already handles, and a search box
 * should never 500 because a third party is having a bad minute.
 */
export async function searchYahoo(query: string, limit = 10): Promise<SymbolRow[]> {
  const params = new URLSearchParams({
    q: query,
    quotesCount: String(Math.min(20, Math.max(1, limit))),
    newsCount: "0",
    listsCount: "0",
  });
  try {
    const res = await fetch(`${YAHOO_SEARCH}?${params}`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return [];
    const body = (await res.json()) as { quotes?: unknown };
    const quotes = Array.isArray(body.quotes) ? body.quotes : [];
    return quotes.flatMap((raw) => {
      const q = raw as Record<string, unknown>;
      const symbol = typeof q.symbol === "string" ? q.symbol : "";
      const name =
        (typeof q.longname === "string" && q.longname) ||
        (typeof q.shortname === "string" && q.shortname) ||
        "";
      const type = String(q.quoteType ?? "").toUpperCase();
      if (!name || !USEFUL_TYPES.has(type)) return [];
      const canonical = toDotClass(symbol);
      // Shape check first — cheap, and rejects the obvious junk.
      if (!/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(canonical)) return [];
      // Then the venue, which is the only thing that separates a class suffix
      // (BRK.B, wanted) from a foreign cross-listing (RIVN.MX, not).
      const exchange = typeof q.exchDisp === "string" ? normalizeExchange(q.exchDisp) : "";
      if (!US_EXCHANGES.has(exchange)) return [];
      return [{
        symbol: canonical,
        name,
        exchange,
        assetClass: type === "ETF" ? "us_etf" : "us_equity",
        status: "active",
        tradable: true,
        source: "yahoo" as const,
      }];
    });
  } catch {
    return [];
  }
}

/**
 * Yahoo writes class shares with a hyphen (BRK-B); Alpaca and every symbol
 * check in this app use a dot (BRK.B). Without this, searching "berkshire
 * hathaway" returned nothing at all — the right answer was fetched and then
 * discarded by the shape check.
 */
export function toDotClass(symbol: string): string {
  return symbol.toUpperCase().replace(/^([A-Z]{1,5})-([A-Z]{1,2})$/, "$1.$2");
}

/** Match the exchange spelling the Alpaca rows use, so ranking treats them alike. */
function normalizeExchange(display: string): string {
  const n = display.toUpperCase();
  if (n.includes("NASDAQ")) return "NASDAQ";
  if (n.includes("NYSEARCA") || n.includes("ARCA")) return "ARCA";
  if (n.includes("NYSE")) return "NYSE";
  if (n.includes("AMERICAN") || n.includes("AMEX")) return "AMEX";
  if (n.includes("BATS") || n.includes("CBOE")) return "BATS";
  if (n.includes("OTC") || n.includes("PINK")) return "OTC";
  return display.slice(0, 24);
}
