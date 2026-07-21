/**
 * Structured-output validation with one repair round (PRD §8.3, §26).
 *
 * Hosted models occasionally emit JSON that violates the schema. We validate
 * with Zod and, on failure, give the model exactly one corrective attempt with
 * the validation error. If it still fails, we throw — no unvalidated output is
 * ever returned.
 */
import { StockAnalysisSchema } from "./schema.ts";
import type { StockAnalysis } from "../types.ts";

export interface ParseAttempt {
  ok: boolean;
  data?: StockAnalysis;
  error?: string;
}

export function tryParse(raw: string): ParseAttempt {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${String(err)}` };
  }
  const result = StockAnalysisSchema.safeParse(json);
  if (result.success) return { ok: true, data: result.data as StockAnalysis };
  return {
    ok: false,
    error: result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; "),
  };
}

/**
 * Run `call(repairHint)` up to twice: first with no hint, then with the schema
 * error if the first output failed validation.
 */
export async function analyzeWithRepair(
  call: (repairHint?: string) => Promise<string>,
): Promise<StockAnalysis> {
  const first = tryParse(await call());
  if (first.ok && first.data) return first.data;

  const hint =
    `Your previous response failed schema validation: ${first.error}. ` +
    `Return ONLY a corrected JSON object that satisfies every required field.`;
  const second = tryParse(await call(hint));
  if (second.ok && second.data) return second.data;

  throw new Error(`Structured output failed schema validation after repair: ${second.error}`);
}
