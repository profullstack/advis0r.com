/**
 * Provider interfaces (PRD §22). These decouple the pipeline from any
 * specific data source or model vendor.
 */
import type {
  AlpacaAsset,
  AnalysisRequest,
  AnalysisResult,
  BarsRequest,
  CalendarRequest,
  CompanyFacts,
  CostEstimate,
  DownloadedDocument,
  FilingMetadata,
  IndicatorConfig,
  LatestQuote,
  LatestTrade,
  MarketBar,
  MarketSession,
  MarketSnapshot,
  ModelDescriptor,
  NormalizedTranscript,
  ParsedTranscript,
  SourceDocument,
  TechnicalIndicatorSet,
  TechnicalScore,
  TranscriptQuery,
} from "../types.ts";

export interface TranscriptProvider {
  id: string;
  search(query: TranscriptQuery): Promise<SourceDocument[]>;
  download(document: SourceDocument): Promise<DownloadedDocument>;
  parse(document: DownloadedDocument): Promise<ParsedTranscript>;
  normalize(transcript: ParsedTranscript): Promise<NormalizedTranscript>;
}

export interface AlpacaMarketDataClient {
  getSnapshots(symbols: string[]): Promise<MarketSnapshot[]>;
  getLatestTrades(symbols: string[]): Promise<LatestTrade[]>;
  getLatestQuotes(symbols: string[]): Promise<LatestQuote[]>;
  getBars(request: BarsRequest): Promise<MarketBar[]>;
  getAssets(symbols?: string[]): Promise<AlpacaAsset[]>;
  getCalendar(request: CalendarRequest): Promise<MarketSession[]>;
}

export interface TechnicalAnalysisEngine {
  calculateIndicators(
    bars: MarketBar[],
    config: IndicatorConfig,
  ): Promise<TechnicalIndicatorSet>;
  scoreTechnicalSetup(
    indicators: TechnicalIndicatorSet,
    horizonQuarters: 1 | 2,
  ): Promise<TechnicalScore>;
}

export interface FundamentalsProvider {
  id: string;
  getCompanyFacts(symbol: string, asOf?: string): Promise<CompanyFacts>;
  getFilings(symbol: string, asOf?: string): Promise<FilingMetadata[]>;
}

export interface AnalysisProvider {
  id: string;
  listModels(): Promise<ModelDescriptor[]>;
  analyze(request: AnalysisRequest): Promise<AnalysisResult>;
  estimateCost(request: AnalysisRequest): Promise<CostEstimate>;
}
