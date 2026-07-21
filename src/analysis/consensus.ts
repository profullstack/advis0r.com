/**
 * Consensus mode (PRD §8.2). Independently runs the analysis with multiple
 * models, then reports agreement/disagreement and a variance-penalized score.
 * No model sees another's answer before independent scoring completes.
 */
import type { AnalysisProvider } from "../providers/interfaces.ts";
import type { AnalysisRequest, AnalysisResult } from "../types.ts";

export interface ConsensusSpec {
  provider: AnalysisProvider;
  model: string;
}

export interface ConsensusReport {
  runs: AnalysisResult[];
  meanOverall: number;
  scoreVariance: number;
  scoreStdDev: number;
  agreementNote: string;
  consensusScore: number;
  disagreementPenalty: number; // 0-1, feeds score composition
}

export async function runConsensus(
  specs: ConsensusSpec[],
  baseRequest: Omit<AnalysisRequest, "model">,
): Promise<ConsensusReport> {
  // Independent, parallel runs — no cross-contamination.
  const runs = await Promise.all(
    specs.map((s) => s.provider.analyze({ ...baseRequest, model: s.model })),
  );

  const scores = runs.map((r) => r.analysis.overallScore);
  const mean = scores.reduce((a, b) => a + b, 0) / (scores.length || 1);
  const variance =
    scores.reduce((a, b) => a + (b - mean) ** 2, 0) / (scores.length || 1);
  const stdDev = Math.sqrt(variance);

  // Normalize disagreement: stdDev of 0 -> 0 penalty, stdDev >= 25 -> 1.
  const disagreementPenalty = Math.min(1, stdDev / 25);
  const consensusScore = Math.max(0, mean - disagreementPenalty * 20);

  const agreementNote =
    stdDev < 5
      ? "Strong agreement between models."
      : stdDev < 15
        ? "Moderate agreement; some divergence in sub-scores."
        : "Significant disagreement; treat with elevated caution.";

  return {
    runs,
    meanOverall: round(mean),
    scoreVariance: round(variance),
    scoreStdDev: round(stdDev),
    agreementNote,
    consensusScore: round(consensusScore),
    disagreementPenalty: round(disagreementPenalty),
  };
}

function round(x: number): number {
  return Math.round(x * 100) / 100;
}
