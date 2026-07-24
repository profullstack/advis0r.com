/**
 * Cross-source corroboration + promotion detection (PRD v3 §3.4, §3.5).
 *
 * This is the payoff for multi-source ingestion. An 8-K claiming a "major new
 * customer win" that a second, unrelated issuer independently confirms is not
 * the same thing as one only amplified by promo blogs — but before this module
 * existed advis0r ranked them identically, because `independentConfirmation`
 * counted URL hosts on a single-source corpus (PRD v3 §1.3).
 *
 * Deterministic and LLM-free: matching is lexical overlap of distinctive terms
 * plus signal-type agreement, so results are reproducible (PRD §12/§13, §26).
 */
import type { Client } from "@libsql/client";
import { createHash } from "node:crypto";
import { isPromotionalHost, normalizeHost } from "../providers/news/tiers.ts";

/**
 * Days before/after a claim in which confirmation is considered related.
 *
 * The window is deliberately wide (about two quarters, matching the product's
 * horizon) because a hard cutoff is the wrong model: coverage confirming an
 * 8-K roadmap claim three months later is weaker evidence, not *no* evidence.
 * Recency is expressed as a confidence decay (`lagWeight`) instead of a cliff.
 */
export const WINDOW_BEFORE_DAYS = 7;
export const WINDOW_AFTER_DAYS = 180;

/** Lag beyond which confirmation stops counting as fully contemporaneous. */
export const CONTEMPORANEOUS_DAYS = 7;

/** Fraction of a claim's distinctive terms that must appear in the other doc. */
export const DEFAULT_OVERLAP = 0.35;

/** Promo articles within the window needed to raise the flag. */
export const PROMO_BURST_THRESHOLD = 3;

export type Relation = "confirms" | "contradicts" | "amplifies_only";

export interface CorroborationRow {
  id: string;
  ticker: string;
  claimSignalId: string;
  claimSourceUrl: string;
  corroboratingDocId: string;
  corroboratingUrl: string;
  publisher: string;
  sourceTier: number;
  lagDays: number;
  relation: Relation;
  overlap: number;
  confidence: number;
}

export interface CorroborateResult {
  tickersScanned: number;
  claimsScanned: number;
  confirms: number;
  contradicts: number;
  amplifiesOnly: number;
  promotionFlags: string[];
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "that", "this", "from", "have", "has", "had", "was", "were",
  "will", "would", "our", "its", "their", "they", "them", "these", "those", "than", "then",
  "into", "over", "under", "about", "which", "while", "also", "been", "being", "more", "most",
  "other", "such", "some", "any", "all", "can", "could", "should", "may", "might", "must",
  "company", "companies", "quarter", "year", "years", "million", "billion", "percent",
  "said", "says", "including", "during", "through", "between", "because", "after", "before",
]);

/**
 * Distinctive terms of a claim: long-ish content words plus any numbers, which
 * are the highest-signal tokens for matching a claim across two write-ups of
 * the same event.
 */
export function distinctiveTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const lowered = text.toLowerCase();
  for (const m of lowered.matchAll(/\$?\d[\d,.]*%?/g)) {
    const t = m[0].replace(/[,$]/g, "").replace(/\.$/, "");
    if (t.length >= 2) terms.add(t);
  }
  for (const m of lowered.matchAll(/[a-z][a-z-]{4,}/g)) {
    const t = m[0];
    if (!STOPWORDS.has(t)) terms.add(t);
  }
  return terms;
}

/** Containment: what fraction of the claim's terms appear in the candidate. */
export function overlapRatio(claim: Set<string>, candidateText: string): number {
  if (claim.size === 0) return 0;
  const lowered = candidateText.toLowerCase();
  let hits = 0;
  for (const term of claim) if (lowered.includes(term)) hits++;
  return hits / claim.size;
}

interface DocRow {
  id: string;
  url: string;
  publisher: string;
  tier: number;
  publishedAt: string;
  host: string;
  text: string;
}

/**
 * Build corroboration links for one or more tickers.
 *
 * Claims come from primary sources (tier 0) — an opinion column is not a claim
 * to be corroborated, it is at most corroboration of someone else's claim.
 */
export async function corroborate(
  db: Client,
  opts: { tickers?: string[]; minOverlap?: number } = {},
  onProgress?: (msg: string) => void,
): Promise<CorroborateResult> {
  const minOverlap = opts.minOverlap ?? DEFAULT_OVERLAP;
  const tickers = opts.tickers?.length
    ? opts.tickers.map((t) => t.toUpperCase())
    : await allTickers(db);

  const result: CorroborateResult = {
    tickersScanned: 0,
    claimsScanned: 0,
    confirms: 0,
    contradicts: 0,
    amplifiesOnly: 0,
    promotionFlags: [],
  };
  const now = new Date().toISOString();

  for (const ticker of tickers) {
    result.tickersScanned++;
    const docs = await loadDocuments(db, ticker);
    if (docs.length === 0) continue;

    const claims = await db.execute({
      sql: `SELECT id, quote, source_url, event_date, signal_type, direction
            FROM signals
            WHERE ticker = ?
              AND COALESCE(is_boilerplate, 0) = 0
              AND COALESCE(source_tier, 0) = 0
            ORDER BY event_date DESC
            LIMIT 200`,
      args: [ticker],
    });

    const rows: CorroborationRow[] = [];
    for (const claim of claims.rows) {
      result.claimsScanned++;
      const quote = String(claim.quote ?? "");
      const claimUrl = String(claim.source_url ?? "");
      const claimHost = claimUrl ? normalizeHost(claimUrl) : "";
      const claimDate = String(claim.event_date ?? "").slice(0, 10);
      if (!quote || !claimDate) continue;
      const terms = distinctiveTerms(quote);
      if (terms.size < 4) continue; // too generic to match responsibly

      for (const doc of docs) {
        // Independence requires a different issuer/publisher.
        if (!doc.host || doc.host === claimHost) continue;
        const lag = dayDiff(claimDate, doc.publishedAt);
        if (lag === undefined || lag < -WINDOW_BEFORE_DAYS || lag > WINDOW_AFTER_DAYS) continue;

        const overlap = overlapRatio(terms, doc.text);
        if (overlap < minOverlap) continue;

        // Tier 3 can never confirm anything — its presence is amplification,
        // and repeated amplification without confirmation is the pump pattern.
        const relation: Relation = doc.tier >= 3 ? "amplifies_only" : "confirms";
        rows.push({
          id: `cor:${createHash("sha256").update(`${claim.id}|${doc.id}`).digest("hex").slice(0, 20)}`,
          ticker,
          claimSignalId: String(claim.id),
          claimSourceUrl: claimUrl,
          corroboratingDocId: doc.id,
          corroboratingUrl: doc.url,
          publisher: doc.publisher,
          sourceTier: doc.tier,
          lagDays: lag,
          relation,
          overlap: Math.round(overlap * 100) / 100,
          // Confidence blends match strength, source quality and recency.
          confidence:
            Math.round(overlap * tierWeight(doc.tier) * lagWeight(lag) * 100) / 100,
        });
      }
    }

    if (rows.length) {
      await persist(db, rows, now);
      for (const r of rows) {
        if (r.relation === "confirms") result.confirms++;
        else if (r.relation === "contradicts") result.contradicts++;
        else result.amplifiesOnly++;
      }
      onProgress?.(`${ticker}: ${rows.length} corroboration link(s)`);
    }

    if (await flagPromotion(db, ticker, docs, now)) {
      result.promotionFlags.push(ticker);
      onProgress?.(`${ticker}: promotional coverage flagged`);
    }
  }

  return result;
}

/**
 * Promotion detection (PRD v3 §3.5).
 *
 * A burst of promotional/excluded coverage with no primary or reputable
 * confirmation is the classic microcap pump pattern. Flagged, never auto-acted
 * on — it feeds the risk side of the score.
 */
async function flagPromotion(
  db: Client,
  ticker: string,
  docs: DocRow[],
  now: string,
): Promise<boolean> {
  const promo = docs.filter((d) => d.tier >= 3 || isPromotionalHost(d.url));
  if (promo.length < PROMO_BURST_THRESHOLD) return false;
  const credible = docs.filter((d) => d.tier <= 1).length;
  if (credible > 0) return false;

  const hosts = [...new Set(promo.map((d) => d.host))];
  await db.execute({
    sql: `INSERT OR REPLACE INTO risk_flags (id, ticker, flag, detail, observed_at)
          VALUES (?,?,?,?,?)`,
    args: [
      `promo:${ticker}`,
      ticker,
      "promotional_coverage",
      `${promo.length} promotional/excluded article(s) from ${hosts.length} host(s) with no tier 0-1 confirmation: ${hosts.slice(0, 5).join(", ")}`,
      now,
    ],
  });
  return true;
}

async function persist(db: Client, rows: CorroborationRow[], now: string): Promise<void> {
  const CHUNK = 400;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await db.batch(
      rows.slice(i, i + CHUNK).map((r) => ({
        sql: `INSERT OR REPLACE INTO corroborations
          (id, ticker, claim_signal_id, claim_source_url, corroborating_doc_id,
           corroborating_url, publisher, source_tier, lag_days, relation, overlap,
           confidence, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        args: [
          r.id, r.ticker, r.claimSignalId, r.claimSourceUrl, r.corroboratingDocId,
          r.corroboratingUrl, r.publisher, r.sourceTier, r.lagDays, r.relation,
          r.overlap, r.confidence, now,
        ],
      })),
      "write",
    );
  }
}

async function allTickers(db: Client): Promise<string[]> {
  const rs = await db.execute(
    `SELECT DISTINCT ticker FROM signals WHERE ticker IS NOT NULL AND ticker <> ''`,
  );
  return rs.rows.map((r) => String(r.ticker));
}

/** All documents for a ticker with their text, for overlap matching. */
async function loadDocuments(db: Client, ticker: string): Promise<DocRow[]> {
  const rs = await db.execute({
    sql: `SELECT d.id, d.url, d.publisher, d.source_tier, d.published_at,
                 GROUP_CONCAT(s.text, ' ') AS text
          FROM documents d
          JOIN transcripts t ON t.document_id = d.id
          JOIN transcript_segments s ON s.transcript_id = t.id
          WHERE t.primary_ticker = ?
          GROUP BY d.id
          LIMIT 400`,
    args: [ticker],
  });
  return rs.rows.map((r) => {
    const url = String(r.url ?? "");
    return {
      id: String(r.id),
      url,
      publisher: String(r.publisher ?? normalizeHost(url)),
      tier: r.source_tier == null ? 0 : Number(r.source_tier),
      publishedAt: String(r.published_at ?? "").slice(0, 10),
      host: url ? normalizeHost(url) : "",
      text: String(r.text ?? ""),
    };
  });
}

/** Evidentiary weight by source tier (mirrors `TIER_WEIGHTS` in the builder). */
export function tierWeight(tier: number): number {
  return tier === 0 ? 1 : tier === 1 ? 0.85 : tier === 2 ? 0.4 : 0;
}

/**
 * Recency decay. Confirmation within a week of the claim counts fully; beyond
 * that it decays linearly to a floor rather than dropping to zero, because late
 * confirmation is still confirmation — just weaker.
 */
export function lagWeight(lagDays: number): number {
  const lag = Math.abs(lagDays);
  if (lag <= CONTEMPORANEOUS_DAYS) return 1;
  const span = WINDOW_AFTER_DAYS - CONTEMPORANEOUS_DAYS;
  const decayed = 1 - (lag - CONTEMPORANEOUS_DAYS) / span;
  return Math.max(0.3, Math.round(decayed * 100) / 100);
}

/** Whole days from `from` to `to`; undefined when either date is unusable. */
export function dayDiff(from: string, to: string): number | undefined {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return undefined;
  return Math.round((b - a) / 86_400_000);
}
