/**
 * Offline analysis provider — deterministic, no external LLM (PRD §8, §13).
 *
 * Produces a StockAnalysis purely from the deterministic evidence set
 * (extracted transcript signals + market/fundamental facts). It performs NO
 * interpretation beyond aggregation, cites every evidence item it used, and is
 * fully reproducible. Use it for zero-dependency runs, CI, and as a triage tier
 * before spending on a hosted model (PRD §25). Selected via `--provider offline`.
 */
import type {
  AnalysisRequest,
  AnalysisResult,
  CostEstimate,
  ModelDescriptor,
  Scenario,
  StockAnalysis,
  TranscriptSignal,
} from "../types.ts";
import type { AnalysisProvider } from "./interfaces.ts";
import { promptHash, inputHash, SYSTEM_PROMPT, buildUserPrompt } from "../analysis/prompt.ts";

export class OfflineAnalysisProvider implements AnalysisProvider {
  readonly id = "offline";

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "offline-deterministic-v1", provider: this.id }];
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    // Reconstruct sentiment from the deterministic evidence tags. Transcript
    // evidence text form: "[date] speaker (signal_type/direction): quote".
    const positives = request.evidence.filter((e) => /positive/i.test(tagOf(e.text)));
    const negatives = request.evidence.filter((e) => /negative/i.test(tagOf(e.text)));

    const posCount = positives.length;
    const negCount = negatives.length;
    const total = Math.max(1, posCount + negCount);

    const catalystScore = clamp((posCount / total) * 100, 0, 100);
    const dilutionRiskScore = clamp(
      (request.evidence.filter((e) => /atm|dilut|reverse_split|financing_need|going_concern/i.test(e.text)).length /
        total) * 100,
      0,
      100,
    );
    const liquidityRiskScore = request.technical?.avgDollarVolume
      ? clamp(100 - Math.log10((request.technical.avgDollarVolume || 1) / 1e5) * 25, 0, 100)
      : 60;

    const executionScore = clamp(30 + posCount * 8, 0, 100);
    const financialQualityScore = request.facts?.runwayMonths
      ? clamp(request.facts.runwayMonths * 4, 0, 100)
      : 45;
    const valuationScore = 50;
    const marketAttentionScore = request.technicalScore?.score ?? 50;
    const managementCredibilityScore = 50;

    const overall = clamp(
      catalystScore * 0.35 +
        executionScore * 0.2 +
        marketAttentionScore * 0.15 +
        financialQualityScore * 0.1 -
        dilutionRiskScore * 0.2 -
        liquidityRiskScore * 0.1 +
        50 * 0.1,
      0,
      100,
    );
    const confidence = clamp(
      35 + Math.min(30, request.evidence.length * 3) - (negCount > posCount ? 15 : 0),
      0,
      100,
    );

    const catalystSummary = dedupe(positives.map((e) => summarize(e.text))).slice(0, 6);
    const riskSummary = dedupe(negatives.map((e) => summarize(e.text))).slice(0, 6);
    if (dilutionRiskScore > 0 && !riskSummary.some((r) => /dilut|atm|financing/i.test(r)))
      riskSummary.push("Potential dilution / financing risk flagged in filings.");

    const scenario = (name: Scenario["name"], probability: number): Scenario => ({
      name,
      probability,
      assumptions:
        name === "bull"
          ? ["Catalysts in evidence convert to revenue within horizon."]
          : name === "bear"
            ? ["Financing/dilution risk materializes; catalysts slip."]
            : ["Mixed execution; catalysts partially realized."],
      expectedCatalysts: catalystSummary.slice(0, 3),
      invalidationConditions:
        name === "bull"
          ? ["Guidance cut or new dilutive raise."]
          : ["Confirmed customer/revenue acceleration."],
    });

    const analysis: StockAnalysis = {
      ticker: request.ticker,
      companyName: request.facts?.companyName ?? request.ticker,
      asOf: request.asOf,
      horizonQuarters: request.horizonQuarters,
      thesis:
        posCount > negCount
          ? `Transcript evidence shows ${posCount} positive vs ${negCount} negative signal(s) related to "${request.topic}". Deterministic offline assessment — corroborate with a hosted model before acting.`
          : `Transcript evidence is mixed-to-negative (${posCount} positive / ${negCount} negative) for "${request.topic}". Treat as low-conviction.`,
      catalystSummary,
      riskSummary,
      transcriptSignals: [] as TranscriptSignal[],
      contradictions: [],
      catalystScore: round(catalystScore),
      managementCredibilityScore,
      executionScore: round(executionScore),
      financialQualityScore: round(financialQualityScore),
      valuationScore,
      marketAttentionScore: round(marketAttentionScore),
      dilutionRiskScore: round(dilutionRiskScore),
      liquidityRiskScore: round(liquidityRiskScore),
      overallScore: round(overall),
      confidence: round(confidence),
      bullCase: scenario("bull", 0.3),
      baseCase: scenario("base", 0.45),
      bearCase: scenario("bear", 0.25),
      evidenceIds: request.evidence.map((e) => e.id),
      missingData: request.snapshot ? [] : ["Alpaca market/technical data"],
    };

    const user = buildUserPrompt(request);
    return {
      provider: this.id,
      model: "offline-deterministic-v1",
      promptHash: promptHash(SYSTEM_PROMPT, user),
      inputHash: inputHash(request),
      analysis,
    };
  }

  async estimateCost(): Promise<CostEstimate> {
    return {
      provider: this.id,
      model: "offline-deterministic-v1",
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: 0,
    };
  }
}

function tagOf(text: string): string {
  const m = text.match(/\(([^)]*)\):/);
  return m ? m[1]! : "";
}
function summarize(text: string): string {
  // Evidence text form: "[date] speaker (signal/direction): quote"
  const m = text.match(/\):\s*(.+)$/);
  const body = m ? m[1]! : text;
  return body.replace(/\s+/g, " ").trim().slice(0, 160);
}
function dedupe(xs: string[]): string[] {
  return [...new Set(xs.map((s) => s.trim()).filter(Boolean))];
}
function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function round(x: number): number {
  return Math.round(x * 100) / 100;
}
