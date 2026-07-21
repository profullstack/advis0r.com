/**
 * OpenAI analysis provider (PRD §8, §28 Phase 1).
 */
import type { AppConfig } from "../config.ts";
import type {
  AnalysisRequest,
  AnalysisResult,
  CostEstimate,
  ModelDescriptor,
} from "../types.ts";
import type { AnalysisProvider } from "./interfaces.ts";
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  inputHash,
  promptHash,
} from "../analysis/prompt.ts";
import { analyzeWithRepair } from "../analysis/validate.ts";
import { resolveModel } from "../analysis/aliases.ts";
import { estimateTokens } from "../analysis/cost.ts";

const BASE = "https://api.openai.com/v1";

export class OpenAIProvider implements AnalysisProvider {
  readonly id = "openai";
  private readonly key: string;
  private readonly temperature: number;
  private modelCache: ModelDescriptor[] | null = null;

  constructor(config: AppConfig) {
    this.key = config.secrets.openaiApiKey;
    this.temperature = config.ai.temperature;
  }

  private headers(): Record<string, string> {
    if (!this.key) throw new Error("OPENAI_API_KEY is not set.");
    return {
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.modelCache) return this.modelCache;
    const res = await fetch(`${BASE}/models`, { headers: this.headers() });
    if (!res.ok) throw new Error(`OpenAI models ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: any[] };
    this.modelCache = body.data
      .filter((m) => /^(gpt|o[0-9]|chatgpt)/.test(m.id))
      .map((m) => ({
        id: m.id,
        provider: this.id,
        createdAt: m.created ? new Date(m.created * 1000).toISOString() : undefined,
      }));
    return this.modelCache;
  }

  private async resolve(model: string): Promise<string> {
    const models = await this.listModels();
    return resolveModel(model, models, {
      deep: /^(o[0-9]|gpt-[0-9]+(\.[0-9]+)?$)/,
      fast: /mini|nano|turbo/,
      balanced: /gpt-[0-9]/,
    });
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    const model = await this.resolve(request.model);
    const user = buildUserPrompt(request);
    const call = async (repairHint?: string): Promise<string> => {
      const messages: any[] = [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: user },
      ];
      if (repairHint) messages.push({ role: "user", content: repairHint });
      const res = await fetch(`${BASE}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          model,
          temperature: this.temperature,
          response_format: { type: "json_object" },
          messages,
        }),
      });
      if (!res.ok) throw new Error(`OpenAI analyze ${res.status}: ${await res.text()}`);
      const body = (await res.json()) as any;
      return body.choices?.[0]?.message?.content ?? "{}";
    };
    const analysis = await analyzeWithRepair(call);
    return {
      provider: this.id,
      model,
      promptHash: promptHash(SYSTEM_PROMPT, user),
      inputHash: inputHash(request),
      analysis,
    };
  }

  async estimateCost(request: AnalysisRequest): Promise<CostEstimate> {
    const model = await this.resolve(request.model);
    const user = buildUserPrompt(request);
    const inputTokens = estimateTokens(SYSTEM_PROMPT + user);
    const outputTokens = 2000;
    return {
      provider: this.id,
      model,
      inputTokens,
      outputTokens,
      // Placeholder pricing; wire real per-model pricing before budgeting.
      estimatedUsd: (inputTokens / 1e6) * 5 + (outputTokens / 1e6) * 15,
    };
  }
}
