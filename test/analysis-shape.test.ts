/**
 * Tool-output shape repair (the "Sharpen failed / spins forever" bug).
 *
 * Models intermittently emit a plain string where the schema requires an array
 * of strings. That failed Zod, discarded an otherwise-good response, and — since
 * each model call takes ~45-70s — pushed the request past the edge proxy, which
 * surfaced as an indefinite spinner ending in a 502.
 */
import { describe, expect, test } from "bun:test";
import {
  coerceAnalysisShape,
  toStrictJsonSchema,
} from "../src/analysis/schema.ts";
import { supportsEffort } from "../src/providers/anthropic.ts";

const shape = (o: Record<string, unknown>) => coerceAnalysisShape(o) as Record<string, unknown>;

describe("analysis shape coercion", () => {
  test("widens a lone string into a one-element array", () => {
    const out = shape({ catalystSummary: "Aerospace separation on track for 2026." });
    expect(out.catalystSummary).toEqual(["Aerospace separation on track for 2026."]);
  });

  test("splits newline- and semicolon-delimited lists", () => {
    expect(shape({ riskSummary: "Dilution risk;  Margin pressure" }).riskSummary)
      .toEqual(["Dilution risk", "Margin pressure"]);
    expect(shape({ missingData: "- No bars\n- No float" }).missingData)
      .toEqual(["No bars", "No float"]);
  });

  test("does NOT split on commas — figures and prose contain them", () => {
    const out = shape({ catalystSummary: "Revenue of $1,200,000, up 47% YoY" });
    expect(out.catalystSummary).toEqual(["Revenue of $1,200,000, up 47% YoY"]);
  });

  test("leaves correctly-typed arrays untouched", () => {
    const arr = ["a", "b"];
    expect(shape({ evidenceIds: arr }).evidenceIds).toBe(arr);
  });

  test("an empty string becomes an empty array, not [''] ", () => {
    expect(shape({ missingData: "   " }).missingData).toEqual([]);
  });

  test("never invents fields or touches unrelated ones", () => {
    const out = shape({ thesis: "unchanged", overallScore: 60 });
    expect(out.thesis).toBe("unchanged");
    expect(out.overallScore).toBe(60);
    expect("catalystSummary" in out).toBe(false);
  });

  test("non-object input passes through", () => {
    expect(coerceAnalysisShape(null)).toBeNull();
    expect(coerceAnalysisShape("x")).toBe("x");
  });
});

describe("strict JSON schema conversion", () => {
  const src = {
    type: "object",
    properties: {
      score: { type: "number", minimum: 0, maximum: 100 },
      nested: { type: "object", properties: { s: { type: "string", maxLength: 5 } } },
      list: { type: "array", items: { type: "string" }, minItems: 1 },
    },
  };

  test("stamps additionalProperties:false on every object node", () => {
    const out = toStrictJsonSchema(src) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.nested.additionalProperties).toBe(false);
  });

  test("strips keywords strict mode rejects", () => {
    const out = toStrictJsonSchema(src) as any;
    expect(out.properties.score.minimum).toBeUndefined();
    expect(out.properties.score.maximum).toBeUndefined();
    expect(out.properties.nested.properties.s.maxLength).toBeUndefined();
    expect(out.properties.list.minItems).toBeUndefined();
  });

  test("preserves types and structure", () => {
    const out = toStrictJsonSchema(src) as any;
    expect(out.properties.score.type).toBe("number");
    expect(out.properties.list.items.type).toBe("string");
  });
});

describe("effort support gating", () => {
  test("sent to models that accept it", () => {
    expect(supportsEffort("claude-opus-5")).toBe(true);
    expect(supportsEffort("claude-sonnet-5")).toBe(true);
  });

  test("withheld from Haiku, which rejects the request outright", () => {
    expect(supportsEffort("claude-haiku-4-5")).toBe(false);
  });
});
