/**
 * Evidence builder (PRD §21 pipeline step "Evidence Builder").
 *
 * Assembles the deterministic, hashed evidence set that grounds the LLM.
 * Every item carries a stable hash and (where applicable) a source URL so
 * conclusions can be cited and reproduced (PRD §8.4, §26).
 */
import { createHash } from "node:crypto";
import type { Client } from "@libsql/client";
import type {
  CompanyFacts,
  EvidenceItem,
  MarketSnapshot,
  TechnicalIndicatorSet,
} from "../types.ts";

export function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export interface EvidenceBundle {
  items: EvidenceItem[];
  /**
   * Tier-weighted count of distinct *narrative* issuers behind the evidence.
   *
   * Deterministic market/fundamental feeds are deliberately excluded: counting
   * "we also have a stock price" as independent confirmation is why this value
   * was previously near-constant across every candidate, rendering its 15%
   * scoring weight inert (PRD v3 §1.3).
   */
  independentSources: number;
  /** Count of deterministic data feeds present (market, fundamentals, technical). */
  dataSources: number;
  /** issuer host -> best (lowest) tier it appeared at, for transparency. */
  issuers: Record<string, number>;
}

export async function buildEvidence(
  db: Client,
  ticker: string,
  opts: {
    from?: string;
    to?: string;
    snapshot?: MarketSnapshot;
    facts?: CompanyFacts;
    technical?: TechnicalIndicatorSet;
  },
): Promise<EvidenceBundle> {
  const items: EvidenceItem[] = [];
  // Distinct issuers/publishers behind the evidence, keyed so the same outlet
  // never counts twice, with the best (lowest) tier it appeared at.
  const issuerTiers = new Map<string, number>();
  const dataSources = new Set<string>();
  const noteIssuer = (key: string, tier: number) => {
    const prev = issuerTiers.get(key);
    if (prev === undefined || tier < prev) issuerTiers.set(key, tier);
  };

  // Transcript / news signals from the DB (populated by `sync` ingestion).
  // Boilerplate is excluded here rather than at query time everywhere else:
  // this is the gate between the corpus and anything the model ever sees.
  const rs = await db.execute({
    sql: `SELECT id, quote, source_url, event_date, signal_type, direction, speaker,
                 speaker_title, source_tier, provenance, start_ms
          FROM signals
          WHERE ticker = ?
            AND COALESCE(is_boilerplate, 0) = 0
            AND (? IS NULL OR event_date >= ?)
            AND (? IS NULL OR event_date <= ?)
          ORDER BY event_date DESC
          LIMIT 100`,
    args: [ticker, opts.from ?? null, opts.from ?? null, opts.to ?? null, opts.to ?? null],
  });
  for (const row of rs.rows) {
    const speaker = String(row.speaker ?? "?");
    const title = row.speaker_title ? `, ${row.speaker_title}` : "";
    const tier = row.source_tier == null ? 0 : Number(row.source_tier);
    // ASR text is machine-derived: label it so the model never treats a
    // transcription as a verbatim executive quote (PRD §8.4, PRD v3 §2.4).
    const derived = row.provenance === "asr" ? " [machine transcript]" : "";
    const text = `[${row.event_date}] ${speaker}${title} (${row.signal_type}/${row.direction})${derived}: ${row.quote}`;
    const url = (row.source_url as string) ?? undefined;
    items.push({
      id: String(row.id),
      kind: "transcript",
      ticker,
      sourceUrl: url,
      text,
      hash: hashText(text),
      observedAt: String(row.event_date ?? ""),
    });
    if (url) noteIssuer(hostOf(url), tier);
  }

  // Cross-source corroboration (PRD v3 §3.4). Each confirming publisher is an
  // independent issuer for scoring purposes; amplification-only links are shown
  // to the model but contribute no weight.
  try {
    const cor = await db.execute({
      sql: `SELECT publisher, corroborating_url, source_tier, lag_days, relation,
                   overlap, confidence, claim_source_url
            FROM corroborations
            WHERE ticker = ?
            ORDER BY confidence DESC
            LIMIT 60`,
      args: [ticker],
    });
    for (const row of cor.rows) {
      const tier = Number(row.source_tier ?? 2);
      const publisher = String(row.publisher ?? "");
      const text =
        `Corroboration (${row.relation}): ${publisher} [tier ${tier}] ` +
        `${row.lag_days} day(s) after the claim, term overlap ${row.overlap}. ` +
        `Claim: ${row.claim_source_url} | Corroborating: ${row.corroborating_url}`;
      items.push({
        id: `cor:${hashText(text)}`,
        kind: "filing",
        ticker,
        sourceUrl: String(row.corroborating_url ?? ""),
        text,
        hash: hashText(text),
        observedAt: String(row.claim_source_url ?? ""),
      });
      if (row.relation === "confirms" && row.corroborating_url) {
        noteIssuer(hostOf(String(row.corroborating_url)), tier);
      }
    }
  } catch {
    // Table missing on a pre-migration database — corroboration is additive.
  }

  // Risk flags, notably promotional coverage (PRD v3 §3.5).
  try {
    const flags = await db.execute({
      sql: "SELECT flag, detail, observed_at FROM risk_flags WHERE ticker = ? LIMIT 20",
      args: [ticker],
    });
    for (const row of flags.rows) {
      const text = `Risk flag [${row.flag}]: ${row.detail ?? ""}`;
      items.push({
        id: `risk:${ticker}:${row.flag}`,
        kind: "filing",
        ticker,
        text,
        hash: hashText(text),
        observedAt: String(row.observed_at ?? ""),
      });
    }
  } catch {
    /* additive */
  }

  if (opts.snapshot) {
    const text = `Market snapshot: last=${opts.snapshot.latestTrade?.price ?? "n/a"} bid=${opts.snapshot.latestQuote?.bidPrice ?? "n/a"} ask=${opts.snapshot.latestQuote?.askPrice ?? "n/a"} feed=${opts.snapshot.feed} delayed=${opts.snapshot.delayed}`;
    items.push({
      id: `mkt:${ticker}:${opts.snapshot.fetchedAt}`,
      kind: "market",
      ticker,
      text,
      hash: hashText(text),
      observedAt: opts.snapshot.fetchedAt,
    });
    dataSources.add("alpaca");
  }

  if (opts.facts) {
    const text = `Fundamentals (${opts.facts.source}): revenue=${opts.facts.revenue ?? "n/a"} cash=${opts.facts.cashBalance ?? "n/a"} debt=${opts.facts.totalDebt ?? "n/a"} shares=${opts.facts.sharesOutstanding ?? "n/a"}`;
    items.push({
      id: `fund:${ticker}:${opts.facts.asOf}`,
      kind: "fundamental",
      ticker,
      text,
      hash: hashText(text),
      observedAt: opts.facts.asOf,
    });
    dataSources.add(opts.facts.source);
  }

  if (opts.technical) {
    const text = `Technicals asOf ${opts.technical.asOf}: trend=${opts.technical.trend} rsi=${opts.technical.rsi14?.toFixed(1) ?? "n/a"} relVol=${opts.technical.relativeVolume?.toFixed(2) ?? "n/a"}`;
    items.push({
      id: `tech:${ticker}:${opts.technical.asOf}`,
      kind: "technical",
      ticker,
      text,
      hash: hashText(text),
      observedAt: opts.technical.asOf,
    });
    dataSources.add("alpaca-technical");
  }

  return {
    items,
    independentSources: weightedIssuerCount(issuerTiers),
    dataSources: dataSources.size,
    issuers: Object.fromEntries(issuerTiers),
  };
}

/** Host of a URL, or the raw string when it will not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/**
 * Tier weights for corroboration (PRD v3 §3.3/§3.4).
 *
 * Ten opinion blogs repeating one press release is not ten independent
 * confirmations, so weight falls off sharply with tier and Tier 3 contributes
 * nothing at all.
 */
export const TIER_WEIGHTS: Record<number, number> = {
  0: 1, // primary — SEC, IR, company channels, newswires
  1: 0.75, // reputable press
  2: 0.25, // analysis / opinion
  3: 0, // excluded / adverse
};

export function weightedIssuerCount(issuerTiers: Map<string, number>): number {
  let total = 0;
  for (const tier of issuerTiers.values()) total += TIER_WEIGHTS[tier] ?? 0;
  return Math.round(total * 100) / 100;
}
