/**
 * Ranking output renderers (PRD §16). Terminal, Markdown, and JSON.
 * Every rendering appends the mandatory disclaimer (PRD §27).
 */
import type { RankedCandidate } from "../types.ts";
import { DISCLAIMER } from "../compliance.ts";

export interface RankingHeader {
  topic: string;
  from?: string;
  to?: string;
  priceMin?: number;
  priceMax?: number;
  horizonQuarters: 1 | 2;
}

const money = (n?: number) => (n == null ? "n/a" : `$${n.toFixed(2)}`);
const cap = (n?: number) => {
  if (n == null) return "n/a";
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
};

export function renderTerminal(
  candidates: RankedCandidate[],
  header: RankingHeader,
): string {
  const lines: string[] = [];
  lines.push("TOP TRANSCRIPT-DERIVED WATCHLIST");
  lines.push(`Topic: ${header.topic}`);
  if (header.from || header.to) lines.push(`Window: ${header.from ?? "…"} to ${header.to ?? "…"}`);
  if (header.priceMin != null || header.priceMax != null)
    lines.push(`Price filter: ${money(header.priceMin)}–${money(header.priceMax)}`);
  lines.push(`Horizon: ${header.horizonQuarters} quarter(s)`);
  lines.push("");

  candidates.forEach((c) => {
    lines.push(`${c.rank}. ${c.ticker} — ${c.companyName}`);
    lines.push(`   Last price: ${money(c.lastPrice)}${c.priceTimestamp ? ` (${c.priceTimestamp})` : ""}`);
    lines.push(`   Market cap: ${cap(c.marketCap)}`);
    lines.push(`   Overall score: ${c.overallScore}/100`);
    lines.push(`   Confidence: ${c.confidence}/100`);
    lines.push(`   Classification: ${labelClass(c.classification)}`);
    if (c.primaryCatalyst) lines.push(`   Primary catalyst: ${c.primaryCatalyst}`);
    if (c.independentConfirmation)
      lines.push(`   Independent confirmation: ${c.independentConfirmation}`);
    if (c.mainRisk) lines.push(`   Main risk: ${c.mainRisk}`);
    lines.push(`   AI: ${c.provider}:${c.model}  Analyzed: ${c.analyzedAt}`);
    lines.push("");
  });

  lines.push("─".repeat(72));
  lines.push(DISCLAIMER);
  return lines.join("\n");
}

export function renderMarkdown(
  candidates: RankedCandidate[],
  header: RankingHeader,
): string {
  const lines: string[] = [];
  lines.push(`# Transcript-Derived Watchlist: ${header.topic}`);
  lines.push("");
  lines.push(`- **Window:** ${header.from ?? "…"} → ${header.to ?? "…"}`);
  lines.push(`- **Price filter:** ${money(header.priceMin)}–${money(header.priceMax)}`);
  lines.push(`- **Horizon:** ${header.horizonQuarters} quarter(s)`);
  lines.push("");
  lines.push("| # | Ticker | Company | Last | Mkt Cap | Score | Conf | Class |");
  lines.push("|---|--------|---------|------|---------|-------|------|-------|");
  for (const c of candidates) {
    lines.push(
      `| ${c.rank} | ${c.ticker} | ${c.companyName} | ${money(c.lastPrice)} | ${cap(c.marketCap)} | ${c.overallScore} | ${c.confidence} | ${labelClass(c.classification)} |`,
    );
  }
  lines.push("");
  for (const c of candidates) {
    lines.push(`## ${c.rank}. ${c.ticker} — ${c.companyName}`);
    lines.push("");
    lines.push(`**Thesis:** ${c.analysis.thesis}`);
    lines.push("");
    if (c.analysis.catalystSummary.length) {
      lines.push(`**Catalysts:**`);
      for (const x of c.analysis.catalystSummary) lines.push(`- ${x}`);
    }
    if (c.analysis.riskSummary.length) {
      lines.push(`**Risks:**`);
      for (const x of c.analysis.riskSummary) lines.push(`- ${x}`);
    }
    if (c.analysis.contradictions.length) {
      lines.push(`**Contradictory evidence:**`);
      for (const x of c.analysis.contradictions) lines.push(`- ${x.description}`);
    }
    lines.push(`**Scenarios:** bull ${pct(c.analysis.bullCase.probability)} · base ${pct(c.analysis.baseCase.probability)} · bear ${pct(c.analysis.bearCase.probability)}`);
    lines.push(`**Evidence IDs:** ${c.analysis.evidenceIds.join(", ") || "—"}`);
    if (c.analysis.missingData.length)
      lines.push(`**Missing data:** ${c.analysis.missingData.join(", ")}`);
    lines.push(`**AI provider/model:** ${c.provider}:${c.model} — analyzed ${c.analyzedAt}`);
    lines.push("");
  }
  lines.push("---");
  lines.push("");
  lines.push(`> ${DISCLAIMER.split("\n").join("\n> ")}`);
  return lines.join("\n");
}

export function renderJson(
  candidates: RankedCandidate[],
  header: RankingHeader,
  extras: { includeEvidence?: boolean; includeScoreBreakdown?: boolean } = {},
): string {
  return JSON.stringify(
    {
      header,
      disclaimer: DISCLAIMER,
      generatedAt: new Date().toISOString(),
      candidates: candidates.map((c) => ({
        ...c,
        analysis: extras.includeEvidence
          ? c.analysis
          : { ...c.analysis, transcriptSignals: undefined },
      })),
    },
    null,
    2,
  );
}

function labelClass(x: RankedCandidate["classification"]): string {
  return x === "high-risk speculative"
    ? "High-risk speculative"
    : x === "speculative"
      ? "Speculative"
      : "Conservative";
}
function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
