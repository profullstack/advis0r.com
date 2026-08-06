/**
 * OpenAI analysis provider (PRD §8, §28 Phase 1).
 *
 * Uses function-calling structured output so the model must return a complete,
 * schema-valid StockAnalysis (mirrors the Anthropic tool-use path), over the
 * Responses API — chat/completions refuses function tools on reasoning models.
 * Non-chat models (realtime/audio/image/embedding/…) are filtered out of model
 * listing so aliases like `latest`/`deep` resolve to a real chat model.
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
import {
  StockAnalysisSchema,
  coerceAnalysisShape,
  stockAnalysisJsonSchema,
} from "../analysis/schema.ts";
import { resolveModel } from "../analysis/aliases.ts";
import { estimateTokens } from "../analysis/cost.ts";

const BASE = "https://api.openai.com/v1";
// Models that can't do chat/function-calling for this task.
const NON_CHAT = /realtime|audio|transcribe|tts|image|dall-e|sora|whisper|embedding|moderation|search|computer-use|codex|instruct/i;

/** Shared with the Anthropic path — one ceiling for an interactive analyze. */
export const ANALYZE_TIMEOUT_MS = Number(process.env.ANALYZE_TIMEOUT_MS ?? 90_000);

/** Depth/latency trade-off for the interactive path. */
export const ANALYZE_EFFORT = process.env.OPENAI_ANALYZE_EFFORT ?? process.env.ANALYZE_EFFORT ?? "low";

/**
 * `reasoning.effort` is only valid for reasoning models; sending it to a
 * GPT-4-era chat model fails the whole request, so it is gated rather than
 * assumed. o-series and GPT-5+ reason; earlier gpt-* do not.
 */
export function supportsReasoning(model: string): boolean {
  return /^o[0-9]/.test(model) || /^(chat)?gpt-([5-9]|[1-9][0-9])/.test(model);
}

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
    // Responses, not chat/completions: reasoning models reject function tools
    // there unless reasoning is switched off entirely ("Function tools with
    // reasoning_effort are not supported for <model> in /v1/chat/completions"),
    // and reasoning is what makes this analysis worth running.
    const res = await fetch(`${BASE}/responses`, {
      method: "POST",
      signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
      headers: this.headers(),
      // `temperature` is omitted — newer OpenAI models only accept the default.
      body: JSON.stringify({
        model,
        instructions: SYSTEM_PROMPT,
        input: user,
        // Reasoning tokens are drawn from this same budget, so it must sit well
        // above the size of the analysis itself or the tool call truncates.
        max_output_tokens: 16000,
        tools: [
          {
            type: "function",
            name: "emit_stock_analysis",
            description: "Emit the grounded StockAnalysis for the ticker. Every field is required.",
            // `strict: true` would guarantee conformance but cannot compile a
            // schema this large, so shape repair happens client-side below —
            // same trade-off as the Anthropic path.
            strict: false,
            parameters: stockAnalysisJsonSchema,
          },
        ],
        tool_choice: { type: "function", name: "emit_stock_analysis" },
        // Effort is the depth/latency lever for this interactive path; only
        // reasoning models accept the knob at all.
        ...(supportsReasoning(model) ? { reasoning: { effort: ANALYZE_EFFORT } } : {}),
        store: false,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI analyze ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    const call = (body.output ?? []).find(
      (o: any) => o.type === "function_call" && o.name === "emit_stock_analysis",
    );
    if (!call?.arguments) {
      const why = body.incomplete_details?.reason ?? body.status ?? "no function_call in output";
      throw new Error(`OpenAI returned no tool call (${why})`);
    }
    const analysis = StockAnalysisSchema.parse(
      coerceAnalysisShape(JSON.parse(call.arguments)),
    ) as StockAnalysis;
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
