# PRD: Executive Transcript Stock Discovery CLI

**Project:** `transcript-search` (product: advis0r.com)
**Runtime:** Bun · **Language:** TypeScript · **Primary interface:** CLI
**Storage:** SQLite/libSQL + FTS5 · **License:** MIT · **Version:** 2.0

> This document is the source of truth for the architecture implemented in this
> repository. It is reproduced here for offline reference; see the repository
> README for current implementation status. The sections below summarize the
> full PRD (Product Summary, Data Sources, AI Provider Architecture, Stock
> Universe & Filters, Signal Extraction, Alpaca Technical Analysis, Scoring,
> Scenario Analysis, Ranking Output, Research Profiles, Backtesting, Database
> Schema, Architecture, Provider Interfaces, Configuration, Commands, Caching &
> Cost Controls, Security & Reliability, Compliance, MVP Scope, Acceptance
> Criteria).

The complete PRD text (all 31 sections) is maintained alongside the code and
mirrors the numbered sections referenced throughout the source
(e.g. `// PRD §12.4`). Key invariants the implementation MUST preserve:

1. **Grounding (§8.4):** prices, financials, dates, quotes, market cap, volume,
   and estimates come ONLY from deterministic providers. The LLM interprets and
   must cite evidence IDs; it never invents facts.
2. **Deterministic-first (§12, §13):** technical indicators and the technical
   score are computed locally from Alpaca bars BEFORE any LLM call; filters run
   before LLM cost is incurred.
3. **No silent model fallback (§8.1):** a requested-but-unavailable model fails
   loudly. Aliases resolve dynamically against live model listings.
4. **Reproducibility (§26, §29.14):** analyses store provider, model, prompt
   hash, input hash, strategy version, Alpaca feed, and indicator config.
5. **Point-in-time backtests (§18):** only historically available data may be
   used; no look-ahead / survivorship / revised-filing leakage.
6. **Compliance (§27):** every ranking carries the research-aid disclaimer;
   speculative candidates are labeled; contradictory evidence and missing data
   are shown; prohibited "guaranteed" language is rejected.
7. **Security (§26):** downloaded/source text is untrusted; defend against
   prompt injection; validate all model output against JSON Schema.
