/**
 * Overall & confidence score composition (PRD §13.2, §13.3).
 *
 * The LLM returns component sub-scores grounded in evidence; this module
 * combines them deterministically with the versioned weights so the final
 * ranking is transparent and reproducible.
 */
import type { RiskClassification, StockAnalysis } from "../types.ts";
import { DEFAULT_WEIGHTS, type ScoreWeights } from "./weights.ts";

export interface CompositeScore {
  overall: number; // 0-100
  confidence: number; // 0-100
  positiveContribution: number;
  riskPenalty: number;
  missingDataPenalty: number;
  modelDisagreementPenalty: number;
  breakdown: Record<string, number>;
}

export interface ScoreInputs {
  analysis: StockAnalysis;
  technicalScore?: number; // 0-100, deterministic
  independentSources: number;
  missingDataCount: number;
  modelDisagreement?: number; // 0-1
}

export function composeScore(
  inputs: ScoreInputs,
  weights: ScoreWeights = DEFAULT_WEIGHTS,
): CompositeScore {
  const a = inputs.analysis;
  const breakdown: Record<string, number> = {};

  // Positive weighted factors (each sub-score is 0-100).
  breakdown.transcriptCatalyst = a.catalystScore * weights.transcriptCatalyst;
  breakdown.independentConfirmation =
    clamp((inputs.independentSources / 3) * 100, 0, 100) * weights.independentConfirmation;
  breakdown.revenueBacklogAcceleration =
    a.executionScore * weights.revenueBacklogAcceleration;
  breakdown.managementExecution = a.managementCredibilityScore * weights.managementExecution;
  breakdown.financialHealth = a.financialQualityScore * weights.financialHealth;
  breakdown.valuationContext = a.valuationScore * weights.valuationContext;
  breakdown.priceVolumeConfirmation =
    (inputs.technicalScore ?? a.marketAttentionScore) * weights.priceVolumeConfirmation;
  breakdown.eventCalendar = a.marketAttentionScore * weights.eventCalendar;

  const positiveContribution = sum(Object.values(breakdown));

  // Risk penalties (scaled by their sub-scores, 0-100 -> fraction of max).
  const dilutionPenalty = (a.dilutionRiskScore / 100) * weights.dilutionRisk * 100;
  const liquidityPenalty = (a.liquidityRiskScore / 100) * weights.liquidityManipulationRisk * 100;
  const contradictionSeverity =
    a.contradictions.reduce((m, c) => Math.max(m, c.severity), 0) || 0;
  const contradictionPenalty = contradictionSeverity * weights.contradictoryEvidence * 100;
  const riskPenalty = dilutionPenalty + liquidityPenalty + contradictionPenalty;
  breakdown.dilutionPenalty = -dilutionPenalty;
  breakdown.liquidityPenalty = -liquidityPenalty;
  breakdown.contradictionPenalty = -contradictionPenalty;

  const missingDataPenalty = Math.min(15, inputs.missingDataCount * 3);
  const modelDisagreementPenalty = (inputs.modelDisagreement ?? 0) * 20;

  const overall = clamp(
    positiveContribution - riskPenalty - missingDataPenalty - modelDisagreementPenalty,
    0,
    100,
  );

  // Confidence (PRD §13.3).
  let confidence = a.confidence; // model self-report as a baseline
  confidence += Math.min(15, inputs.independentSources * 5);
  confidence -= missingDataPenalty;
  confidence -= modelDisagreementPenalty;
  confidence -= contradictionSeverity * 15;
  confidence = clamp(confidence, 0, 100);

  return {
    overall: round(overall),
    confidence: round(confidence),
    positiveContribution: round(positiveContribution),
    riskPenalty: round(riskPenalty),
    missingDataPenalty: round(missingDataPenalty),
    modelDisagreementPenalty: round(modelDisagreementPenalty),
    breakdown: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, round(v)])),
  };
}

export function classifyRisk(
  overall: number,
  confidence: number,
  lastPrice?: number,
): RiskClassification {
  const cheapAndUncertain = (lastPrice ?? 99) < 5 || confidence < 60;
  if (cheapAndUncertain) return "high-risk speculative";
  if (confidence < 75) return "speculative";
  return "conservative";
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}
function sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function round(x: number): number {
  return Math.round(x * 100) / 100;
}
