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

-- Persisted ticker reports, one current snapshot per ticker, served at
-- /ticker/<SYMBOL>. Before this every view recomputed bars, SEC facts, evidence
-- and the offline analysis; the snapshot makes a report a thing that exists
-- rather than something regenerated on each visit. The generation history stays
-- in `analyses`, which is append-only, so overwriting here loses nothing.
CREATE TABLE IF NOT EXISTS reports (
  ticker            TEXT PRIMARY KEY,
  payload_json      TEXT NOT NULL,   -- the full /api/ticker payload
  -- Denormalized so the index page and sitemap never parse the payloads.
  company_name      TEXT,
  last_price        REAL,
  overall_score     REAL,
  confidence        REAL,
  classification    TEXT,
  ai_provider       TEXT,
  ai_model          TEXT,
  ai_generated_at   TEXT,
  source_count      INTEGER NOT NULL DEFAULT 0,
  signal_count      INTEGER NOT NULL DEFAULT 0,
  generated_at      TEXT NOT NULL,   -- when THIS snapshot was captured
  first_generated_at TEXT NOT NULL,  -- when the ticker was first covered
  generated_by      TEXT             -- user id that triggered it, when known
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

-- Authentication (PRD v3 §7). Accounts only — no existing route is gated.
CREATE TABLE IF NOT EXISTS users (
  id                TEXT PRIMARY KEY,
  email             TEXT NOT NULL UNIQUE,   -- stored lowercased/trimmed
  password_hash     TEXT NOT NULL,          -- argon2id via Bun.password
  email_verified_at TEXT,
  display_name      TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT,
  last_login_at     TEXT,
  disabled          INTEGER NOT NULL DEFAULT 0,
  -- Watchlist email digests. Daily by default, per product decision; the digest
  -- only goes to verified addresses that actually have a watchlist.
  digest_frequency  TEXT NOT NULL DEFAULT 'daily',   -- daily | weekly | off
  digest_last_sent_at TEXT,
  -- Plaintext by design: it has to be printable in every email and its only
  -- capability is turning mail off. Nothing readable or changeable hangs off it.
  digest_unsub_token  TEXT
);

-- Opaque session tokens. Only the SHA-256 of the token is stored, so a database
-- leak does not yield usable sessions.
CREATE TABLE IF NOT EXISTS sessions (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  revoked_at    TEXT,
  user_agent    TEXT,
  ip            TEXT
);

-- Single-use email tokens: address verification and password reset. Hashed at
-- rest for the same reason as sessions.
CREATE TABLE IF NOT EXISTS auth_tokens (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  kind          TEXT NOT NULL,            -- verify_email | reset_password
  token_hash    TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  consumed_at   TEXT
);

-- Per-user saved watchlist (PRD v3 §7.1). One row per (user, ticker); the
-- UNIQUE constraint makes "add" idempotent rather than duplicating entries.
CREATE TABLE IF NOT EXISTS watchlist_items (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  ticker        TEXT NOT NULL,
  note          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(user_id, ticker)
);

-- Credits (PRD v3 §8). Append-only ledger: the balance is always SUM(delta),
-- never a stored mutable number that can drift from its own history.
CREATE TABLE IF NOT EXISTS credits_ledger (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  delta         INTEGER NOT NULL,          -- positive = granted/purchased, negative = spent
  reason        TEXT NOT NULL,             -- monthly_grant | purchase | spend:<op> | adjustment
  -- Idempotency key. For a monthly grant this is the YYYY-MM period; for a
  -- purchase it is the CoinPay payment id. UNIQUE(user_id, reason, idem) makes
  -- double-granting and double-crediting impossible even under a retry.
  idem          TEXT,
  note          TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(user_id, reason, idem)
);

-- Credit purchases via CoinPayPortal.
CREATE TABLE IF NOT EXISTS credit_purchases (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  payment_id    TEXT NOT NULL UNIQUE,      -- CoinPayPortal payment id
  package_id    TEXT NOT NULL,
  credits       INTEGER NOT NULL,
  amount_usd    REAL NOT NULL,
  blockchain    TEXT,
  status        TEXT NOT NULL,             -- pending | confirmed | failed | expired
  payment_url   TEXT,
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

-- Digest delivery ledger. UNIQUE(user_id, period_key) is the interlock that
-- makes delivery at-most-once: a cron that fires twice, or two servers running
-- the scheduler, cannot both win the insert and mail the same summary twice.
CREATE TABLE IF NOT EXISTS digest_sends (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id),
  frequency     TEXT NOT NULL,            -- daily | weekly
  period_key    TEXT NOT NULL,            -- daily:2026-08-03 | weekly:2026-W31
  covering      TEXT NOT NULL,            -- session(s) summarized, e.g. 2026-07-27..2026-07-31
  tickers       INTEGER NOT NULL,
  status        TEXT NOT NULL,            -- sending | sent | failed
  transport     TEXT,
  error         TEXT,
  sent_at       TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE(user_id, period_key)
);

-- Throttling for auth endpoints (login, signup, reset requests).
CREATE TABLE IF NOT EXISTS auth_attempts (
  id            TEXT PRIMARY KEY,
  bucket        TEXT NOT NULL,            -- e.g. "login:a@b.com" / "reset:1.2.3.4"
  created_at    TEXT NOT NULL
);

-- Helpful indexes
CREATE INDEX IF NOT EXISTS idx_signals_ticker ON signals(ticker);
CREATE INDEX IF NOT EXISTS idx_corrob_ticker ON corroborations(ticker, relation);
CREATE INDEX IF NOT EXISTS idx_documents_publisher ON documents(publisher);
CREATE INDEX IF NOT EXISTS idx_riskflags_ticker ON risk_flags(ticker, flag);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id, expires_at);
CREATE INDEX IF NOT EXISTS idx_authtokens_user ON auth_tokens(user_id, kind);
CREATE INDEX IF NOT EXISTS idx_authattempts_bucket ON auth_attempts(bucket, created_at);
CREATE INDEX IF NOT EXISTS idx_watchlist_user ON watchlist_items(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_credits_user ON credits_ledger(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_digest_sends_period ON digest_sends(period_key, user_id);
CREATE INDEX IF NOT EXISTS idx_reports_generated ON reports(generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_reports_score ON reports(overall_score DESC);
CREATE INDEX IF NOT EXISTS idx_users_digest ON users(digest_frequency);
CREATE INDEX IF NOT EXISTS idx_purchases_user ON credit_purchases(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_bars_ticker_tf ON market_bars(ticker, timeframe, ts);
CREATE INDEX IF NOT EXISTS idx_analyses_ticker ON analyses(ticker, as_of);
CREATE INDEX IF NOT EXISTS idx_segments_transcript ON transcript_segments(transcript_id, seg_index);
