/**
 * c0mpute analysis provider: the peer network through @profullstack/ai-providers.
 *
 * First in the provider order. Anthropic and OpenAI stay registered behind it
 * as the paid tier, so the existing per-provider loop in the analyze routes is
 * the fallback chain. c0mpute has no tool calling, so the structured output
 * comes back as JSON and goes through the same `coerceAnalysisShape` + Zod
 * repair the vendor tool paths use.
 */
import { getAi, generateObjectOn, type TextProvider } from "@profullstack/ai-providers";
import type {
  AnalysisRequest,
  AnalysisResult,
  CostEstimate,
  ModelDescriptor,
  StockAnalysis,
} from "../types.ts";
import type { AnalysisProvider } from "./interfaces.ts";
import { SYSTEM_PROMPT, buildUserPrompt, inputHash, promptHash } from "../analysis/prompt.ts";
import {
  StockAnalysisSchema,
  coerceAnalysisShape,
  stockAnalysisJsonSchema,
} from "../analysis/schema.ts";
import { estimateTokens } from "../analysis/cost.ts";

/**
 * Peer nodes write about 2 tokens a second, so the vendor's 90 s interactive
 * ceiling would cut every analysis off. The SSE route keeps the connection
 * alive with a heartbeat while this runs.
 */
export const C0MPUTE_ANALYZE_TIMEOUT_MS = Number(process.env.C0MPUTE_ANALYZE_TIMEOUT_MS ?? 240_000);

/** The env-configured c0mpute provider, or null when C0MPUTE_DISABLED is set. */
export function c0mputeTextProvider(): TextProvider | null {
  return getAi().primary.find((p) => p.name === "c0mpute") ?? null;
}

export class C0mputeAnalysisProvider implements AnalysisProvider {
  readonly id = "c0mpute";

  constructor(private readonly provider: TextProvider) {}

  async listModels(): Promise<ModelDescriptor[]> {
    return [{ id: "c0mpute", provider: this.id, displayName: "c0mpute peer network" }];
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    const user = buildUserPrompt(request);
    const { object, model } = await generateObjectOn(this.provider, {
      feature: "advis0r.analyze",
      name: "StockAnalysis",
      system: SYSTEM_PROMPT,
      user,
      jsonSchema: stockAnalysisJsonSchema as Record<string, unknown>,
      schema: (v: unknown) => StockAnalysisSchema.parse(coerceAnalysisShape(v)) as StockAnalysis,
      maxTokens: 8000,
      temperature: 0,
      timeoutMs: C0MPUTE_ANALYZE_TIMEOUT_MS,
    });
    return {
      provider: this.id,
      model,
      promptHash: promptHash(SYSTEM_PROMPT, user),
      inputHash: inputHash(request),
      analysis: object,
    };
  }

  async estimateCost(request: AnalysisRequest): Promise<CostEstimate> {
    const user = buildUserPrompt(request);
    const inputTokens = estimateTokens(SYSTEM_PROMPT + user);
    const outputTokens = 2000;
    return {
      provider: this.id,
      model: "c0mpute",
      inputTokens,
      outputTokens,
      // Per-job metering on the peer network; a short JSON job is ~5 micro-USD.
      estimatedUsd: 0,
    };
  }
}
