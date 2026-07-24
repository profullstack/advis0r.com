/**
 * Configuration loading (PRD §23).
 *
 * Resolution order:
 *   1. Built-in defaults (below).
 *   2. TOML file at ~/.config/transcripts/config.toml (or $TRANSCRIPTS_CONFIG).
 *   3. Environment variables for secrets (never stored in TOML).
 *
 * Secrets (API keys, DB auth token) come ONLY from the environment.
 */
import { parse as parseToml } from "smol-toml";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface AppConfig {
  databaseUrl: string;
  databaseAuthToken: string;
  downloadsDir: string;

  ai: {
    defaultProvider: "openai" | "anthropic";
    defaultModelAlias: string;
    consensusProviders: string[];
    temperature: number;
    requireStructuredOutput: boolean;
    requireCitations: boolean;
  };

  alpaca: {
    feed: "iex" | "sip" | "otc";
    adjustment: "raw" | "split" | "dividend" | "all";
    cacheSeconds: number;
    requestTimeoutMs: number;
    maxRetries: number;
    useMarketCalendar: boolean;
    dataUrl: string;
  };

  technical: {
    barTimeframes: string[];
    lookbackDays: number;
    movingAverages: number[];
    emaPeriods: number[];
    rsiPeriod: number;
    macdFast: number;
    macdSlow: number;
    macdSignal: number;
    bollingerPeriod: number;
    bollingerStddev: number;
    atrPeriod: number;
    relativeVolumePeriod: number;
  };

  screen: {
    priceMin: number;
    priceMax: number;
    marketCapMin: number;
    marketCapMax: number;
    avgVolumeMin: number;
    avgDollarVolumeMin: number;
    excludeOtc: boolean;
    excludeBankrupt: boolean;
    excludeGoingConcern: boolean;
  };

  risk: {
    maxBidAskSpreadPercent: number;
    maxShareGrowthPercent: number;
    reverseSplitLookbackDays: number;
    minimumRunwayMonths: number;
  };

  analysis: {
    horizonQuarters: 1 | 2;
    minimumIndependentSources: number;
    minimumEvidenceItems: number;
    includeContradictions: boolean;
    includeCrossCompanyConfirmation: boolean;
  };

  secrets: {
    openaiApiKey: string;
    anthropicApiKey: string;
    alpacaKeyId: string;
    alpacaSecretKey: string;
    secUserAgent: string;
    /** ValueSERP news discovery (PRD v3 §3.1). Optional; RSS works without it. */
    valueSerpApiKey: string;
    /** Groq API key for Whisper ASR of audio/video sources (PRD v3 §2.2). */
    groqApiKey: string;
    /**
     * ElevenLabs Scribe — the preferred ASR backend: word-level timestamps
     * plus speaker diarization. Anthropic offers no speech-to-text endpoint,
     * so audio transcription is always a third-party call.
     */
    elevenLabsApiKey: string;
  };
}

function expandHome(p: string): string {
  if (p.startsWith("~")) return join(homedir(), p.slice(1));
  return p;
}

const defaults: AppConfig = {
  databaseUrl: "file:./data/transcripts.sqlite",
  databaseAuthToken: "",
  downloadsDir: "./data/downloads",
  ai: {
    defaultProvider: "openai",
    defaultModelAlias: "latest",
    consensusProviders: ["openai", "anthropic"],
    temperature: 0,
    requireStructuredOutput: true,
    requireCitations: true,
  },
  alpaca: {
    feed: "iex",
    adjustment: "all",
    cacheSeconds: 60,
    requestTimeoutMs: 15000,
    maxRetries: 3,
    useMarketCalendar: true,
    dataUrl: "https://data.alpaca.markets",
  },
  technical: {
    barTimeframes: ["1Day", "1Hour", "15Min"],
    lookbackDays: 365,
    movingAverages: [20, 50, 200],
    emaPeriods: [9, 21],
    rsiPeriod: 14,
    macdFast: 12,
    macdSlow: 26,
    macdSignal: 9,
    bollingerPeriod: 20,
    bollingerStddev: 2,
    atrPeriod: 14,
    relativeVolumePeriod: 20,
  },
  screen: {
    priceMin: 0.5,
    priceMax: 10,
    marketCapMin: 25_000_000,
    marketCapMax: 5_000_000_000,
    avgVolumeMin: 250_000,
    avgDollarVolumeMin: 500_000,
    excludeOtc: true,
    excludeBankrupt: true,
    excludeGoingConcern: false,
  },
  risk: {
    maxBidAskSpreadPercent: 5,
    maxShareGrowthPercent: 30,
    reverseSplitLookbackDays: 365,
    minimumRunwayMonths: 6,
  },
  analysis: {
    horizonQuarters: 2,
    minimumIndependentSources: 2,
    minimumEvidenceItems: 3,
    includeContradictions: true,
    includeCrossCompanyConfirmation: true,
  },
  secrets: {
    openaiApiKey: "",
    anthropicApiKey: "",
    alpacaKeyId: "",
    alpacaSecretKey: "",
    secUserAgent: "transcript-search research",
    valueSerpApiKey: "",
    groqApiKey: "",
    elevenLabsApiKey: "",
  },
};

export function configPath(): string {
  return (
    process.env.TRANSCRIPTS_CONFIG ??
    join(homedir(), ".config", "transcripts", "config.toml")
  );
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mergeToml(base: AppConfig, toml: Record<string, any>): AppConfig {
  const c: AppConfig = structuredClone(base);
  if (toml.database) c.databaseUrl = String(toml.database);
  if (toml.downloads) c.downloadsDir = expandHome(String(toml.downloads));

  const assign = (target: any, src: any) => {
    if (!src) return;
    for (const [k, v] of Object.entries(src)) {
      const camel = k.replace(/_([a-z])/g, (_, ch) => ch.toUpperCase());
      if (v !== undefined) target[camel] = v;
    }
  };
  assign(c.ai, toml.ai);
  assign(c.alpaca, toml.alpaca);
  assign(c.technical, toml.technical);
  assign(c.screen, toml.screen);
  assign(c.risk, toml.risk);
  assign(c.analysis, toml.analysis);
  return c;
}

function applyEnv(c: AppConfig): AppConfig {
  const env = process.env;
  if (env.DATABASE_URL) c.databaseUrl = env.DATABASE_URL;
  if (env.DATABASE_AUTH_TOKEN) c.databaseAuthToken = env.DATABASE_AUTH_TOKEN;
  if (env.APCA_API_DATA_URL) c.alpaca.dataUrl = env.APCA_API_DATA_URL;
  c.secrets = {
    openaiApiKey: env.OPENAI_API_KEY ?? "",
    anthropicApiKey: env.ANTHROPIC_API_KEY ?? "",
    alpacaKeyId: env.APCA_API_KEY_ID ?? "",
    alpacaSecretKey: env.APCA_API_SECRET_KEY ?? "",
    secUserAgent: env.SEC_USER_AGENT ?? c.secrets.secUserAgent,
    valueSerpApiKey: env.VALUESERP_API_KEY ?? "",
    groqApiKey: env.GROQ_API_KEY ?? "",
    elevenLabsApiKey: env.ELEVENLABS_API_KEY ?? "",
  };
  c.databaseUrl = expandHome(c.databaseUrl);
  return c;
}

export function loadConfig(): AppConfig {
  let cfg = defaults;
  const path = configPath();
  if (existsSync(path)) {
    try {
      const toml = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
      cfg = mergeToml(defaults, toml);
    } catch (err) {
      console.error(`Warning: failed to parse config at ${path}: ${String(err)}`);
    }
  }
  return applyEnv(cfg);
}
