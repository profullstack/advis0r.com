/**
 * c0mpute leads the analysis providers and returns the same StockAnalysis the
 * vendor tool paths do, from plain JSON text.
 */
import { describe, expect, test } from "bun:test";
import type { TextProvider } from "@profullstack/ai-providers";
import { C0mputeAnalysisProvider } from "../src/providers/c0mpute.ts";
import { OfflineAnalysisProvider } from "../src/providers/offline.ts";
import { buildRegistry } from "../src/registry.ts";
import { loadConfig } from "../src/config.ts";
import type { AnalysisRequest } from "../src/types.ts";

const request: AnalysisRequest = {
  ticker: "ACME",
  topic: "ACME",
  asOf: "2026-11-07T00:00:00.000Z",
  horizonQuarters: 2,
  model: "balanced",
  evidence: [
    {
      id: "ev1",
      kind: "transcript",
      ticker: "ACME",
      text: "Management raised full-year guidance on strong demand.",
      hash: "h1",
      observedAt: "2026-11-01T00:00:00.000Z",
    },
  ],
};

function fakeProvider(text: string): TextProvider & { calls: number } {
  return {
    name: "c0mpute",
    calls: 0,
    async generate() {
      this.calls++;
      return { text, model: "qwen-test", usage: { inputTokens: 0, outputTokens: 0, estimated: true } };
    },
  };
}

describe("C0mputeAnalysisProvider", () => {
  test("parses a fenced JSON answer into a StockAnalysis", async () => {
    const reference = (await new OfflineAnalysisProvider().analyze(request)).analysis;
    const fake = fakeProvider("Here you go:\n```json\n" + JSON.stringify(reference) + "\n```");
    const result = await new C0mputeAnalysisProvider(fake).analyze(request);
    expect(result.provider).toBe("c0mpute");
    expect(result.model).toBe("qwen-test");
    expect(result.analysis.ticker).toBe(reference.ticker);
    expect(fake.calls).toBe(1);
  });

  test("throws on an unusable answer so the route falls through to the paid tier", async () => {
    const fake = fakeProvider("not json at all");
    await expect(new C0mputeAnalysisProvider(fake).analyze(request)).rejects.toThrow();
  });

  test("is registered first, ahead of the vendors", async () => {
    const config = await loadConfig();
    const keys = [...buildRegistry(config).ai.keys()];
    expect(keys[0]).toBe("c0mpute");
    expect(config.ai.defaultProvider).toBe("c0mpute");
  });
});
