-- transcript-search schema (PRD §20)
-- Compatible with libSQL / Turso and local SQLite. FTS5 required.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS companies (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  cik           TEXT,
  sector        TEXT,
  industry      TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS securities (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES companies(id),
  exchange      TEXT,
  asset_class   TEXT,
  tradable      INTEGER DEFAULT 1,
  status        TEXT
);

CREATE TABLE IF NOT EXISTS tickers (
  symbol        TEXT PRIMARY KEY,
  security_id   TEXT REFERENCES securities(id),
  company_id    TEXT REFERENCES companies(id),
  active        INTEGER DEFAULT 1
);

CREATE TABLE IF NOT EXISTS executives (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES companies(id),
  name          TEXT NOT NULL,
  title         TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES companies(id),
  event_type    TEXT NOT NULL,
  title         TEXT,
  event_date    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS documents (
  id            TEXT PRIMARY KEY,
  event_id      TEXT REFERENCES events(id),
  provider_id   TEXT NOT NULL,
  title         TEXT,
  url           TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  published_at  TEXT,
  content_type  TEXT,
  local_path    TEXT,
  checksum      TEXT,
  fetched_at    TEXT,
  meta_json     TEXT,
  created_at    TEXT NOT NULL,
  -- PRD v3: multi-source provenance (news, wire, audio, video).
  publisher     TEXT,
  source_tier   INTEGER,          -- 0 primary .. 3 excluded/adverse
  paywalled     INTEGER DEFAULT 0,-- 1 = headline/snippet only
  media_url     TEXT,
  media_type    TEXT,             -- audio|video|article|filing
  duration_ms   INTEGER,
  provenance    TEXT,             -- filing|published|captions|asr
  asr_model     TEXT,
  asr_version   TEXT
);

CREATE TABLE IF NOT EXISTS transcripts (
  id            TEXT PRIMARY KEY,
  document_id   TEXT REFERENCES documents(id),
  primary_ticker TEXT,
  event_date    TEXT,
  language      TEXT DEFAULT 'en',
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id            TEXT PRIMARY KEY,
  transcript_id TEXT REFERENCES transcripts(id),
  seg_index     INTEGER NOT NULL,
  speaker       TEXT,
  speaker_title TEXT,
  text          TEXT NOT NULL,
  start_ms      INTEGER,
  end_ms        INTEGER
);

-- Full-text search over transcript segments (PRD: SQLite + FTS5).
CREATE VIRTUAL TABLE IF NOT EXISTS segments_fts USING fts5(
  text,
  speaker,
  ticker,
  segment_id UNINDEXED,
  transcript_id UNINDEXED,
  event_date UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS speakers (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  title         TEXT,
  company_id    TEXT REFERENCES companies(id)
);

-- Corpus-derived boilerplate language (PRD v3 §4.1c). Word shingles that appear
-- under many distinct issuers are standard filing text, not company claims.
CREATE TABLE IF NOT EXISTS boilerplate_shingles (
  shingle       TEXT PRIMARY KEY,
  issuer_count  INTEGER NOT NULL,
  updated_at    TEXT NOT NULL
);

-- Cross-source corroboration (PRD v3 §3.4). Links a claim made in one document
-- to independent confirmation (or contradiction) in another.
CREATE TABLE IF NOT EXISTS corroborations (
  id                    TEXT PRIMARY KEY,
  ticker                TEXT NOT NULL,
  claim_signal_id       TEXT,
  claim_source_url      TEXT,
  corroborating_doc_id  TEXT,
  corroborating_url     TEXT,
  publisher             TEXT,
  source_tier           INTEGER NOT NULL,
  lag_days              INTEGER,
  relation              TEXT NOT NULL, -- confirms|contradicts|amplifies_only
  overlap               REAL,
  confidence            REAL,
  created_at            TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS quotes (
  id            TEXT PRIMARY KEY,
  segment_id    TEXT REFERENCES transcript_segments(id),
  ticker        TEXT,
  speaker       TEXT,
  quote         TEXT NOT NULL,
  source_url    TEXT,
  evidence_hash TEXT
);

CREATE TABLE IF NOT EXISTS signals (
  id            TEXT PRIMARY KEY,
  ticker        TEXT NOT NULL,
  speaker       TEXT,
  speaker_title TEXT,
  event_date    TEXT,
  event_type    TEXT,
  signal_type   TEXT,
  direction     TEXT,
  strength      REAL,
  novelty       REAL,
  specificity   REAL,
  quote         TEXT,
  context_before TEXT,
  context_after TEXT,
  source_url    TEXT,
  evidence_hash TEXT,
  created_at    TEXT NOT NULL,
  -- PRD v3: quality + provenance carried through from the source document.
  source_tier        INTEGER,
  is_boilerplate     INTEGER DEFAULT 0,
  boilerplate_reasons TEXT,
  speaker_confidence REAL,
  start_ms           INTEGER,
  provenance         TEXT
);

CREATE TABLE IF NOT EXISTS contradictions (
  id            TEXT PRIMARY KEY,
  ticker        TEXT NOT NULL,
  description   TEXT,
  claim_evidence_id TEXT,
  counter_evidence_id TEXT,
  severity      REAL
);

CREATE TABLE IF NOT EXISTS relationships (
  id            TEXT PRIMARY KEY,
  from_ticker   TEXT NOT NULL,
  to_ticker     TEXT NOT NULL,
  kind          TEXT NOT NULL, -- customer|supplier|competitor|channel|...
  confidence    REAL
);

CREATE TABLE IF NOT EXISTS market_snapshots (
  id            TEXT PRIMARY KEY,
  ticker        TEXT NOT NULL,
  feed          TEXT,
  delayed       INTEGER,
  last_price    REAL,
  bid           REAL,
  ask           REAL,
  prev_close    REAL,
  snapshot_json TEXT,
  request_id    TEXT,
  fetched_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS market_bars (
  id            TEXT PRIMARY KEY,
  ticker        TEXT NOT NULL,
  timeframe     TEXT NOT NULL,
  ts            TEXT NOT NULL,
  open          REAL,
  high          REAL,
  low           REAL,
  close         REAL,
  volume        REAL,
  vwap          REAL,
  adjustment    TEXT,
  feed          TEXT,
  UNIQUE(ticker, timeframe, ts, adjustment)
);

CREATE TABLE IF NOT EXISTS fundamentals (
  id            TEXT PRIMARY KEY,
  ticker        TEXT NOT NULL,
  as_of         TEXT NOT NULL,
  facts_json    TEXT NOT NULL,
  source        TEXT
);

CREATE TABLE IF NOT EXISTS guidance (
  id            TEXT PRIMARY KEY,
  ticker        TEXT NOT NULL,
  period        TEXT,
  metric        TEXT,
  value_json    TEXT,
  source_url    TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS corporate_actions (
  id            TEXT PRIMARY KEY,
  ticker        TEXT NOT NULL,
  kind          TEXT,      -- split|reverse_split|dividend|symbol_change
  ex_date       TEXT,
  detail_json   TEXT
);

CREATE TABLE IF NOT EXISTS risk_flags (
  id            TEXT PRIMARY KEY,
  ticker        TEXT NOT NULL,
  flag          TEXT NOT NULL, -- going_concern|bankrupt|delisting|atm|...
  detail        TEXT,
  observed_at   TEXT
);

CREATE TABLE IF NOT EXISTS analyses (
  id               TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL,
  ticker           TEXT NOT NULL,
  topic            TEXT NOT NULL,
  as_of            TEXT NOT NULL,
  horizon_quarters INTEGER NOT NULL,
  provider         TEXT NOT NULL,
  model            TEXT NOT NULL,
  prompt_hash      TEXT NOT NULL,
  input_hash       TEXT NOT NULL,
  output_json      TEXT NOT NULL,
  overall_score    REAL NOT NULL,
  confidence       REAL NOT NULL,
  created_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS analysis_evidence (
  id            TEXT PRIMARY KEY,
  analysis_id   TEXT REFERENCES analyses(id),
  evidence_id   TEXT NOT NULL,
  kind          TEXT,
  ticker        TEXT,
  source_url    TEXT,
  text          TEXT,
  hash          TEXT,
  observed_at   TEXT
);

CREATE TABLE IF NOT EXISTS model_runs (
  id            TEXT PRIMARY KEY,
  analysis_id   TEXT REFERENCES analyses(id),
  provider      TEXT NOT NULL,
  model         TEXT NOT NULL,
  input_tokens  INTEGER,
  output_tokens INTEGER,
  cost_usd      REAL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rankings (
  id            TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL,
  topic         TEXT NOT NULL,
  as_of         TEXT NOT NULL,
  horizon_quarters INTEGER NOT NULL,
  ranking_json  TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS strategies (
  version       TEXT PRIMARY KEY,
  weights_json  TEXT NOT NULL,
  prompt_hash   TEXT,
  notes         TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtests (
  id            TEXT PRIMARY KEY,
  strategy_version TEXT NOT NULL,
  topic         TEXT,
  as_of         TEXT,
  horizon_quarters INTEGER,
  metrics_json  TEXT,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS backtest_positions (
  id            TEXT PRIMARY KEY,
  backtest_id   TEXT REFERENCES backtests(id),
  ticker        TEXT NOT NULL,
  entry_date    TEXT,
  entry_price   REAL,
  exit_date     TEXT,
  exit_price    REAL,
  return_pct    REAL,
  score         REAL,
  confidence    REAL
);

CREATE TABLE IF NOT EXISTS providers (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL, -- transcript|market|fundamentals|ai
  enabled       INTEGER DEFAULT 1,
  config_json   TEXT
);

CREATE TABLE IF NOT EXISTS downloads (
  id            TEXT PRIMARY KEY,
  document_id   TEXT REFERENCES documents(id),
  url           TEXT NOT NULL,
  status        TEXT,
  checksum      TEXT,
  bytes         INTEGER,
  fetched_at    TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL,
  status        TEXT NOT NULL, -- pending|running|done|failed
  payload_json  TEXT,
  error         TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_corrob_ticker ON corroborations(ticker, relation);
CREATE INDEX IF NOT EXISTS idx_documents_publisher ON documents(publisher);
CREATE INDEX IF NOT EXISTS idx_riskflags_ticker ON risk_flags(ticker, flag);
CREATE INDEX IF NOT EXISTS idx_bars_ticker_tf ON market_bars(ticker, timeframe, ts);
CREATE INDEX IF NOT EXISTS idx_analyses_ticker ON analyses(ticker, as_of);
CREATE INDEX IF NOT EXISTS idx_segments_transcript ON transcript_segments(transcript_id, seg_index);
