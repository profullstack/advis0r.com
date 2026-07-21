/**
 * Validated structured-output schema (PRD §8.3).
 *
 * Every AI analysis MUST validate against this. Values that must come from
 * deterministic providers (prices, market cap, volume, dates) are NOT part of
 * the free-form model output beyond interpretation — see §8.4 grounding rules.
 */
import { z } from "zod";

export const ScenarioSchema = z.object({
  name: z.enum(["bull", "base", "bear"]),
  probability: z.number().min(0).max(1),
  assumptions: z.array(z.string()),
  expectedCatalysts: z.array(z.string()),
  invalidationConditions: z.array(z.string()),
  estimatedRange: z
    .object({
      low: z.number(),
      high: z.number(),
      methodology: z.string(),
    })
    .optional(),
});

export const TranscriptSignalSchema = z.object({
  id: z.string(),
  ticker: z.string(),
  speaker: z.string(),
  speakerTitle: z.string().optional(),
  eventDate: z.string(),
  eventType: z.string(),
  signalType: z.string(),
  direction: z.enum(["positive", "negative", "mixed", "neutral"]),
  strength: z.number().min(0).max(1),
  novelty: z.number().min(0).max(1),
  specificity: z.number().min(0).max(1),
  quote: z.string(),
  contextBefore: z.string(),
  contextAfter: z.string(),
  sourceUrl: z.string(),
  evidenceHash: z.string(),
});

export const ContradictionSchema = z.object({
  id: z.string(),
  ticker: z.string(),
  description: z.string(),
  claimEvidenceId: z.string(),
  counterEvidenceId: z.string(),
  severity: z.number().min(0).max(1),
});

export const StockAnalysisSchema = z.object({
  ticker: z.string(),
  companyName: z.string(),
  asOf: z.string(),
  horizonQuarters: z.union([z.literal(1), z.literal(2)]),
  thesis: z.string(),
  catalystSummary: z.array(z.string()),
  riskSummary: z.array(z.string()),
  transcriptSignals: z.array(TranscriptSignalSchema),
  contradictions: z.array(ContradictionSchema),
  catalystScore: z.number().min(0).max(100),
  managementCredibilityScore: z.number().min(0).max(100),
  executionScore: z.number().min(0).max(100),
  financialQualityScore: z.number().min(0).max(100),
  valuationScore: z.number().min(0).max(100),
  marketAttentionScore: z.number().min(0).max(100),
  dilutionRiskScore: z.number().min(0).max(100),
  liquidityRiskScore: z.number().min(0).max(100),
  overallScore: z.number().min(0).max(100),
  confidence: z.number().min(0).max(100),
  bullCase: ScenarioSchema,
  baseCase: ScenarioSchema,
  bearCase: ScenarioSchema,
  evidenceIds: z.array(z.string()),
  missingData: z.array(z.string()),
});

export type StockAnalysisParsed = z.infer<typeof StockAnalysisSchema>;

/** JSON Schema for providers that support native structured output. */
export const stockAnalysisJsonSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "ticker",
    "companyName",
    "asOf",
    "horizonQuarters",
    "thesis",
    "catalystSummary",
    "riskSummary",
    "transcriptSignals",
    "contradictions",
    "catalystScore",
    "managementCredibilityScore",
    "executionScore",
    "financialQualityScore",
    "valuationScore",
    "marketAttentionScore",
    "dilutionRiskScore",
    "liquidityRiskScore",
    "overallScore",
    "confidence",
    "bullCase",
    "baseCase",
    "bearCase",
    "evidenceIds",
    "missingData",
  ],
} as const;
