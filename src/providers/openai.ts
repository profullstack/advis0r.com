/**
 * OpenAI analysis provider (PRD §8, §28 Phase 1).
 *
 * Uses function-calling structured output so the model must return a complete,
 * schema-valid StockAnalysis (mirrors the Anthropic tool-use path). Non-chat
 * models (realtime/audio/image/embedding/…) are filtered out of model listing
 * so aliases like `latest`/`deep` resolve to a real chat model.
 */
import type { AppConfig } from "../config.ts";
import type {
  AnalysisRequest,
  AnalysisResult,
  CostEstimate,
  ModelDescriptor,
  StockAnalysis,
} from "../types.ts";
import type { AnalysisProvider } from "./interfaces.ts";
import {
  SYSTEM_PROMPT,
  buildUserPrompt,
  inputHash,
  promptHash,
} from "../analysis/prompt.ts";
import { StockAnalysisSchema, stockAnalysisJsonSchema } from "../analysis/schema.ts";
import { resolveModel } from "../analysis/aliases.ts";
import { estimateTokens } from "../analysis/cost.ts";

const BASE = "https://api.openai.com/v1";
// Models that can't do chat/function-calling for this task.
const NON_CHAT = /realtime|audio|transcribe|tts|image|dall-e|sora|whisper|embedding|moderation|search|computer-use|codex|instruct/i;

export class OpenAIProvider implements AnalysisProvider {
  readonly id = "openai";
  private readonly key: string;
  private modelCache: ModelDescriptor[] | null = null;

  constructor(config: AppConfig) {
    this.key = config.secrets.openaiApiKey;
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
      .filter((m) => /^(gpt-|o[0-9]|chatgpt)/.test(m.id) && !NON_CHAT.test(m.id))
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
      deep: /^o[0-9]|^gpt-[0-9]+(\.[0-9]+)?$/,
      fast: /mini|nano/,
      balanced: /^gpt-[0-9]/,
    });
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    const model = await this.resolve(request.model);
    const user = buildUserPrompt(request);
    const res = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      // `temperature` is omitted — newer OpenAI models only accept the default.
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        tools: [
          {
            type: "function",
            function: {
              name: "emit_stock_analysis",
              description: "Emit the grounded StockAnalysis for the ticker. Every field is required.",
              parameters: stockAnalysisJsonSchema,
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "emit_stock_analysis" } },
      }),
    });
    if (!res.ok) throw new Error(`OpenAI analyze ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    const args = body.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
    if (!args) throw new Error("OpenAI returned no tool call");
    const analysis = StockAnalysisSchema.parse(JSON.parse(args)) as StockAnalysis;
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
