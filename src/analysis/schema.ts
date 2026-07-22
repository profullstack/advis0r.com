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
  // Data-derived; the model need not emit these (we attach signals separately).
  transcriptSignals: z.array(TranscriptSignalSchema).default([]),
  contradictions: z.array(ContradictionSchema).default([]),
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

/** Complete JSON Schema for provider structured output (tool use). */
const score = { type: "number", minimum: 0, maximum: 100 } as const;
const strArr = { type: "array", items: { type: "string" } } as const;
const scenarioJsonSchema = {
  type: "object",
  properties: {
    name: { type: "string", enum: ["bull", "base", "bear"] },
    probability: { type: "number", minimum: 0, maximum: 1 },
    assumptions: strArr,
    expectedCatalysts: strArr,
    invalidationConditions: strArr,
    estimatedRange: {
      type: "object",
      properties: { low: { type: "number" }, high: { type: "number" }, methodology: { type: "string" } },
      required: ["low", "high", "methodology"],
    },
  },
  required: ["name", "probability", "assumptions", "expectedCatalysts", "invalidationConditions"],
} as const;

export const stockAnalysisJsonSchema = {
  type: "object",
  properties: {
    ticker: { type: "string" },
    companyName: { type: "string" },
    asOf: { type: "string" },
    horizonQuarters: { type: "integer", enum: [1, 2] },
    thesis: { type: "string" },
    catalystSummary: strArr,
    riskSummary: strArr,
    catalystScore: score,
    managementCredibilityScore: score,
    executionScore: score,
    financialQualityScore: score,
    valuationScore: score,
    marketAttentionScore: score,
    dilutionRiskScore: score,
    liquidityRiskScore: score,
    overallScore: score,
    confidence: score,
    bullCase: scenarioJsonSchema,
    baseCase: scenarioJsonSchema,
    bearCase: scenarioJsonSchema,
    evidenceIds: strArr,
    missingData: strArr,
  },
  required: [
    "ticker", "companyName", "asOf", "horizonQuarters", "thesis", "catalystSummary",
    "riskSummary", "catalystScore", "managementCredibilityScore", "executionScore",
    "financialQualityScore", "valuationScore", "marketAttentionScore", "dilutionRiskScore",
    "liquidityRiskScore", "overallScore", "confidence", "bullCase", "baseCase", "bearCase",
    "evidenceIds", "missingData",
  ],
} as const;
