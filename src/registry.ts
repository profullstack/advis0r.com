/**
 * Provider registry — constructs concrete providers from config (PRD §21, §22).
 */
import type { AppConfig } from "./config.ts";
import { AlpacaClient } from "./providers/alpaca.ts";
import { YahooMarketDataClient } from "./providers/yahoo.ts";
import { SecFundamentalsProvider } from "./providers/sec.ts";
import type { AlpacaMarketDataClient } from "./providers/interfaces.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { OfflineAnalysisProvider } from "./providers/offline.ts";
import { buildTranscriptProviders } from "./providers/transcripts/index.ts";
import type { AnalysisProvider } from "./providers/interfaces.ts";

export function buildRegistry(config: AppConfig) {
  const ai = new Map<string, AnalysisProvider>();
  ai.set("openai", new OpenAIProvider(config));
  ai.set("anthropic", new AnthropicProvider(config));
  ai.set("offline", new OfflineAnalysisProvider());

  // Use Alpaca when credentials are present (real-time/IEX); otherwise fall back
  // to the keyless Yahoo end-of-day source so pricing/technicals still work.
  const hasAlpaca = Boolean(config.secrets.alpacaKeyId && config.secrets.alpacaSecretKey);
  const market: AlpacaMarketDataClient = hasAlpaca
    ? new AlpacaClient(config)
    : new YahooMarketDataClient();

  return {
    alpaca: market,
    marketSource: hasAlpaca ? "alpaca" : "yahoo",
    fundamentals: new SecFundamentalsProvider(config),
    transcripts: buildTranscriptProviders(config),
    ai,
  };
}

export function getAiProvider(
  registry: ReturnType<typeof buildRegistry>,
  id: string,
): AnalysisProvider {
  const p = registry.ai.get(id);
  if (!p) {
    throw new Error(
      `Unknown AI provider "${id}". Available: ${[...registry.ai.keys()].join(", ")}`,
    );
  }
  return p;
}
