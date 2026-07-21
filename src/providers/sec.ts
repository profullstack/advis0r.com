/**
 * SEC EDGAR fundamentals & filings provider (PRD §7.4, §7.5, §28 Phase 1).
 *
 * SEC is the source of record for regulatory filings and company facts.
 * Requires a descriptive User-Agent per SEC access rules.
 */
import type { AppConfig } from "../config.ts";
import type { CompanyFacts, FilingMetadata } from "../types.ts";
import type { FundamentalsProvider } from "./interfaces.ts";

const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

export class SecFundamentalsProvider implements FundamentalsProvider {
  readonly id = "sec";
  private readonly userAgent: string;
  private tickerMap: Map<string, { cik: string; name: string }> | null = null;

  constructor(config: AppConfig) {
    this.userAgent = config.secrets.secUserAgent;
  }

  private headers(): Record<string, string> {
    return { "User-Agent": this.userAgent, Accept: "application/json" };
  }

  private async loadTickerMap(): Promise<Map<string, { cik: string; name: string }>> {
    if (this.tickerMap) return this.tickerMap;
    const res = await fetch(TICKERS_URL, { headers: this.headers() });
    if (!res.ok) throw new Error(`SEC tickers ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as Record<string, any>;
    const map = new Map<string, { cik: string; name: string }>();
    for (const entry of Object.values(body)) {
      const cik = String(entry.cik_str).padStart(10, "0");
      map.set(String(entry.ticker).toUpperCase(), { cik, name: entry.title });
    }
    this.tickerMap = map;
    return map;
  }

  private async resolveCik(symbol: string): Promise<{ cik: string; name: string } | null> {
    const map = await this.loadTickerMap();
    return map.get(symbol.toUpperCase()) ?? null;
  }

  async getCompanyFacts(symbol: string, asOf?: string): Promise<CompanyFacts> {
    const resolved = await this.resolveCik(symbol);
    const nowIso = asOf ?? new Date().toISOString();
    if (!resolved) {
      return { symbol, asOf: nowIso, source: this.id };
    }
    const res = await fetch(
      `https://data.sec.gov/api/xbrl/companyfacts/CIK${resolved.cik}.json`,
      { headers: this.headers() },
    );
    if (!res.ok) {
      return { symbol, companyName: resolved.name, cik: resolved.cik, asOf: nowIso, source: this.id };
    }
    const body = (await res.json()) as any;
    const usd = body.facts?.["us-gaap"] ?? {};
    const shares = latestValue(body.facts?.dei?.EntityCommonStockSharesOutstanding, asOf);
    const publicFloat = latestValue(body.facts?.dei?.EntityPublicFloat, asOf);
    const revenueFact =
      usd.RevenueFromContractWithCustomerExcludingAssessedTax ?? usd.Revenues ?? usd.SalesRevenueNet;
    const revenue = latestValue(revenueFact, asOf);
    const revenueGrowth = yoyGrowth(revenueFact, asOf);
    const cash = latestValue(usd.CashAndCashEquivalentsAtCarryingValue, asOf);
    const debt =
      (latestValue(usd.LongTermDebtNoncurrent, asOf) ?? 0) +
      (latestValue(usd.LongTermDebtCurrent, asOf) ?? 0);
    const opCashFlow = latestValue(usd.NetCashProvidedByUsedInOperatingActivities, asOf);
    // Runway: cash divided by monthly operating cash burn (only when burning).
    const runwayMonths =
      cash != null && opCashFlow != null && opCashFlow < 0
        ? Math.round((cash / (Math.abs(opCashFlow) / 12)) * 10) / 10
        : undefined;

    return {
      symbol,
      companyName: resolved.name,
      cik: resolved.cik,
      sharesOutstanding: shares ?? undefined,
      publicFloat: publicFloat ?? undefined,
      revenue: revenue ?? undefined,
      revenueGrowth,
      cashBalance: cash ?? undefined,
      totalDebt: debt || undefined,
      freeCashFlow: opCashFlow ?? undefined,
      runwayMonths,
      asOf: nowIso,
      source: this.id,
    };
  }

  async getFilings(symbol: string, asOf?: string): Promise<FilingMetadata[]> {
    const resolved = await this.resolveCik(symbol);
    if (!resolved) return [];
    const res = await fetch(
      `https://data.sec.gov/submissions/CIK${resolved.cik}.json`,
      { headers: this.headers() },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as any;
    const recent = body.filings?.recent ?? {};
    const out: FilingMetadata[] = [];
    const forms: string[] = recent.form ?? [];
    for (let i = 0; i < forms.length; i++) {
      const filedAt: string = recent.filingDate?.[i] ?? "";
      if (asOf && filedAt > asOf.slice(0, 10)) continue; // point-in-time (§18.1)
      const accession: string = recent.accessionNumber?.[i] ?? "";
      const doc: string = recent.primaryDocument?.[i] ?? "";
      const accNoDash = accession.replace(/-/g, "");
      out.push({
        symbol,
        cik: resolved.cik,
        form: forms[i]!,
        filedAt,
        accessionNumber: accession,
        url: `https://www.sec.gov/Archives/edgar/data/${Number(resolved.cik)}/${accNoDash}/${doc}`,
      });
    }
    return out.slice(0, 50);
  }
}

/** Return the most recent numeric value on/before `asOf` from an XBRL fact. */
function latestValue(fact: any, asOf?: string): number | null {
  if (!fact?.units) return null;
  const unitKey = Object.keys(fact.units)[0];
  if (!unitKey) return null;
  const entries: any[] = fact.units[unitKey] ?? [];
  const cutoff = asOf?.slice(0, 10);
  const eligible = entries
    .filter((e) => e.end && (!cutoff || e.end <= cutoff))
    .sort((a, b) => String(a.end).localeCompare(String(b.end)));
  const last = eligible.at(-1);
  return typeof last?.val === "number" ? last.val : null;
}

/**
 * Year-over-year growth (%) from annual (FY) duration facts, point-in-time.
 * Uses the two most recent full-year (10-K) frames on/before `asOf`.
 */
function yoyGrowth(fact: any, asOf?: string): number | undefined {
  if (!fact?.units) return undefined;
  const unitKey = Object.keys(fact.units)[0];
  if (!unitKey) return undefined;
  const cutoff = asOf?.slice(0, 10);
  const annual = (fact.units[unitKey] as any[])
    .filter((e) => e.form === "10-K" && e.fp === "FY" && e.start && e.end)
    .filter((e) => !cutoff || e.end <= cutoff)
    .filter((e) => durationDays(e.start, e.end) >= 300)
    .sort((a, b) => String(a.end).localeCompare(String(b.end)));
  const latest = annual.at(-1);
  const prior = annual.at(-2);
  if (!latest || !prior || typeof latest.val !== "number" || !prior.val) return undefined;
  return Math.round(((latest.val - prior.val) / Math.abs(prior.val)) * 1000) / 10;
}

function durationDays(start: string, end: string): number {
  return (Date.parse(end) - Date.parse(start)) / 86_400_000;
}
