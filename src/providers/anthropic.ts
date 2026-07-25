/**
 * Anthropic analysis provider (PRD §8, §28 Phase 1).
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
import {
  StockAnalysisSchema,
  coerceAnalysisShape,
  stockAnalysisJsonSchema,
} from "../analysis/schema.ts";
import { resolveModel } from "../analysis/aliases.ts";
import { estimateTokens } from "../analysis/cost.ts";
import type { StockAnalysis } from "../types.ts";

const BASE = "https://api.anthropic.com/v1";

/**
 * Hard ceiling for one interactive analyze call. Railway's edge terminates a
 * long request with a 502 and no body, which is indistinguishable from a hang
 * in the UI — failing here instead produces an error we can actually show.
 */
export const ANALYZE_TIMEOUT_MS = Number(process.env.ANALYZE_TIMEOUT_MS ?? 90_000);

/** Depth/latency trade-off for the interactive path. */
export const ANALYZE_EFFORT = process.env.ANALYZE_EFFORT ?? "low";

/**
 * `output_config.effort` is not accepted by every model — Haiku rejects the
 * request outright — so it is sent only where supported rather than failing the
 * whole analysis for an unsupported knob.
 */
export function supportsEffort(model: string): boolean {
  return /opus|sonnet|fable|mythos/i.test(model);
}
const API_VERSION = "2023-06-01";

export class AnthropicProvider implements AnalysisProvider {
  readonly id = "anthropic";
  private readonly key: string;
  private readonly temperature: number;
  private modelCache: ModelDescriptor[] | null = null;

  constructor(config: AppConfig) {
    this.key = config.secrets.anthropicApiKey;
    this.temperature = config.ai.temperature;
  }

  private headers(): Record<string, string> {
    if (!this.key) throw new Error("ANTHROPIC_API_KEY is not set.");
    return {
      "x-api-key": this.key,
      "anthropic-version": API_VERSION,
      "Content-Type": "application/json",
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (this.modelCache) return this.modelCache;
    const res = await fetch(`${BASE}/models?limit=100`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Anthropic models ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as { data: any[] };
    this.modelCache = body.data.map((m) => ({
      id: m.id,
      provider: this.id,
      displayName: m.display_name,
      createdAt: m.created_at,
    }));
    return this.modelCache;
  }

  private async resolve(model: string): Promise<string> {
    const models = await this.listModels();
    return resolveModel(model, models, {
      deep: /opus/,
      fast: /haiku/,
      balanced: /sonnet/,
    });
  }

  async analyze(request: AnalysisRequest): Promise<AnalysisResult> {
    const model = await this.resolve(request.model);
    const user = buildUserPrompt(request);
    // Force structured output via tool use: the model must call this tool with
    // arguments conforming to the schema — guarantees a complete, valid object.
    const res = await fetch(`${BASE}/messages`, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(ANALYZE_TIMEOUT_MS),
      body: JSON.stringify({
        model,
        // Thinking shares this budget with the emitted tool call on models
        // where it is on by default, so it must be well above the size of the
        // analysis itself or the response truncates mid-object.
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        tools: [
          {
            name: "emit_stock_analysis",
            description: "Emit the grounded StockAnalysis for the ticker. Every field is required.",
            // NOTE: `strict: true` would guarantee schema conformance, but the
            // API cannot compile a grammar this large ("compiled grammar is too
            // large"). Shape repair therefore happens client-side via
            // `coerceAnalysisShape` before Zod validation.
            input_schema: stockAnalysisJsonSchema,
          },
        ],
        tool_choice: { type: "tool", name: "emit_stock_analysis" },
        // This path is interactive — the UI promises ~20s. Effort is the lever
        // that controls depth and latency. Thinking is deliberately left at the
        // model default rather than disabled: with thinking off, current models
        // can emit a tool call as plain text, which would silently produce no
        // analysis at all.
        ...(supportsEffort(model) ? { output_config: { effort: ANALYZE_EFFORT } } : {}),
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!res.ok) throw new Error(`Anthropic analyze ${res.status}: ${await res.text()}`);
    const body = (await res.json()) as any;
    const toolUse = (body.content ?? []).find((b: any) => b.type === "tool_use");
    if (!toolUse?.input) throw new Error("Anthropic returned no tool_use block");
    const analysis = StockAnalysisSchema.parse(coerceAnalysisShape(toolUse.input)) as StockAnalysis;
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
      estimatedUsd: (inputTokens / 1e6) * 3 + (outputTokens / 1e6) * 15,
    };
  }
}

