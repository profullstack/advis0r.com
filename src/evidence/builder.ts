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
  independentSources: number;
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
  const sources = new Set<string>();

  // Transcript signals from the DB (populated by `sync`/`search` ingestion).
  const rs = await db.execute({
    sql: `SELECT id, quote, source_url, event_date, signal_type, direction, speaker
          FROM signals
          WHERE ticker = ?
            AND (? IS NULL OR event_date >= ?)
            AND (? IS NULL OR event_date <= ?)
          ORDER BY event_date DESC
          LIMIT 100`,
    args: [ticker, opts.from ?? null, opts.from ?? null, opts.to ?? null, opts.to ?? null],
  });
  for (const row of rs.rows) {
    const text = `[${row.event_date}] ${row.speaker ?? "?"} (${row.signal_type}/${row.direction}): ${row.quote}`;
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
    if (url) sources.add(new URL(url).host);
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
    sources.add("alpaca");
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
    sources.add(opts.facts.source);
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
    sources.add("alpaca-technical");
  }

  return { items, independentSources: sources.size };
}
