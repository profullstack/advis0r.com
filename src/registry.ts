/**
 * Provider registry — constructs concrete providers from config (PRD §21, §22).
 */
import type { AppConfig } from "./config.ts";
import { AlpacaClient } from "./providers/alpaca.ts";
import { YahooMarketDataClient } from "./providers/yahoo.ts";
import { FallbackMarketDataClient } from "./providers/market-fallback.ts";
import { SecFundamentalsProvider } from "./providers/sec.ts";
import type { AlpacaMarketDataClient } from "./providers/interfaces.ts";
import { OpenAIProvider } from "./providers/openai.ts";
import { AnthropicProvider } from "./providers/anthropic.ts";
import { OfflineAnalysisProvider } from "./providers/offline.ts";
import { buildTranscriptProviders } from "./providers/transcripts/index.ts";
import { NewsProvider } from "./providers/news/index.ts";
import type { AnalysisProvider } from "./providers/interfaces.ts";

export function buildRegistry(config: AppConfig) {
  const ai = new Map<string, AnalysisProvider>();
  ai.set("openai", new OpenAIProvider(config));
  ai.set("anthropic", new AnthropicProvider(config));
  ai.set("offline", new OfflineAnalysisProvider());

  // Use Alpaca when credentials are present (real-time/IEX), but wrap it so any
  // auth/error/empty result transparently falls back to the keyless Yahoo
  // end-of-day source — pricing/technicals keep working even if the Alpaca keys
  // are invalid, expired, or rate-limited.
  const yahoo = new YahooMarketDataClient();
  const hasAlpaca = Boolean(config.secrets.alpacaKeyId && config.secrets.alpacaSecretKey);
  const market: AlpacaMarketDataClient = hasAlpaca
    ? new FallbackMarketDataClient(new AlpacaClient(config), yahoo, (op, err) =>
        console.error(`[market] Alpaca ${op} failed, using Yahoo fallback: ${String(err).slice(0, 120)}`),
      )
    : yahoo;

  // News is registered separately from `transcripts` rather than folded into
  // it: it requires tickers to be meaningful and can spend metered search
  // credits, so it runs only when explicitly asked for (`transcripts news`).
  const news = new NewsProvider({
    downloadsDir: config.downloadsDir,
    valueSerpKey: config.secrets.valueSerpApiKey,
  });

  return {
    alpaca: market,
    marketSource: hasAlpaca ? "alpaca (yahoo fallback)" : "yahoo",
    fundamentals: new SecFundamentalsProvider(config),
    transcripts: buildTranscriptProviders(config),
    news,
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
