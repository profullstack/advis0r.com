# advis0r.com — Executive Transcript Stock Discovery CLI

> **Research aid, not financial advice.** This tool converts public executive
> communications into a reproducible, evidence-backed stock *research* workflow.
> It never guarantees a stock will rise, executes trades, or uses non-public
> information. Small-cap and low-priced stocks are especially risky. See
> [Compliance](#compliance).

A [Bun](https://bun.sh) + TypeScript CLI that discovers, downloads, normalizes,
indexes, and analyzes public communications from leaders of publicly traded
technology companies — earnings calls, investor days, keynotes, fireside chats,
interviews, podcasts, SEC exhibits, blog posts, and captioned video — then
combines transcript-derived signals with **Alpaca** market data and **SEC**
fundamentals to produce a ranked, cited research watchlist for a one- to
two-quarter horizon.

CLI binary: **`transcripts`**.

## Live

- **Web dashboard + PWA:** https://advis0r.up.railway.app (Watchlist / Search /
  Signals / About; installable). API root at `/api`.
- Deployed on Railway (Bun, `src/server.ts`), backed by the same Turso database
  the CLI uses.

## Status

This repository implements the architecture in [`docs/PRD.md`](docs/PRD.md).
What is **fully implemented and working end-to-end**:

- **Live transcript ingestion** via SEC EDGAR full-text search (`transcripts
  sync "<topic>"`) — keyless; indexes real 8-K/EX-99 exhibits & prepared remarks
  into Turso with FTS5 and deterministic signal extraction.
- **Offline analysis provider** (`--provider offline`): zero-dependency,
  grounded, reproducible `StockAnalysis` from extracted signals — `discover`,
  `analyze-company`, and the web watchlist produce real ranked output with no
  external LLM keys.
- **Web dashboard + PWA** and read-only HTTP API (`src/server.ts`).

What is **fully implemented**:

- Bun CLI with the full command surface (`init`, `search`, `discover`,
  `analyze-company`, `compare`, `screen`, `models`, `providers`, `stats`,
  `export`, `backtest`).
- libSQL / Turso storage with the full schema + **FTS5** (works locally as an
  embedded file or against a remote Turso DB).
- **Alpaca Market Data** client (snapshots, trades, quotes, bars, assets,
  calendar) with provenance tagging (feed, delayed flag, request id).
- **Local, deterministic technical-indicator engine** (SMA/EMA/RSI/MACD/
  Bollinger/ATR/momentum/relative-volume/trend) — the LLM never computes these.
- Deterministic **filter engine** (price, market cap, liquidity, exchange,
  technical, risk) and **scoring engine** (versioned weights, overall +
  confidence, risk penalties).
- **SEC EDGAR** fundamentals/filings provider (ticker→CIK, company facts,
  point-in-time filings).
- **OpenAI** and **Anthropic** analysis providers behind a provider-neutral
  interface, with **dynamic model listing**, alias resolution
  (`fast`/`balanced`/`deep`/`latest`), **no silent fallback**, validated
  structured output (Zod), grounding rules, and consensus mode.
- Ranked watchlist rendering in **terminal / Markdown / JSON** with the
  mandatory disclaimer.

### Multi-source ingestion (PRD v3)

Beyond SEC filings, the index now ingests:

- **News** — `transcripts news <TICKERS...>`. Keyless discovery (Yahoo per-ticker
  RSS, Google News RSS, newswire feeds) plus optional ValueSERP search; article
  bodies are fetched and parsed by us, never taken from a vendor summary. Every
  document carries a **reputation tier** (0 primary / 1 reputable press /
  2 analysis / 3 excluded) that decides its evidentiary weight. `robots.txt` is
  honoured and publishers that block automated access degrade to
  headline + snippet rather than being routed around.
- **Media** — `transcripts media <TICKERS...>`. Earnings calls, keynotes,
  conference talks and podcasts via YouTube captions (free, already timestamped)
  with ASR as the fallback. Segments keep millisecond offsets, so a quote can
  link to the exact second it was said.

  ASR is provider-neutral and picks the best available credential:
  **ElevenLabs Scribe** (`ELEVENLABS_API_KEY`, preferred — word-level
  timestamps *and* speaker diarization), Groq `whisper-large-v3-turbo`
  (`GROQ_API_KEY`, cheapest), or OpenAI `whisper-1` (`OPENAI_API_KEY`).
  Anthropic has no speech-to-text endpoint, so transcription is always a
  third-party call. On a datacenter host YouTube also needs `YTDLP_COOKIES`.
- **Corroboration** — `transcripts corroborate [TICKERS...]`. Links a primary
  claim to independent confirmation in other sources, weighted by tier and
  recency, and raises a `promotional_coverage` risk flag when a burst of
  promo-tier coverage has no primary or reputable confirmation.
- **Signal quality** — `transcripts reclassify`. Deterministic boilerplate model
  (disclaimer sections, hypothetical framing, and language repeated across
  issuers). Applied to the production corpus it flagged **43.8% of stored
  signals** as filing boilerplate rather than executive claims.

See [`docs/PRD-v3-media-news.md`](docs/PRD-v3-media-news.md).

What is **partial / Phase 2**: the point-in-time backtest engine is implemented
and ranks candidates deterministically (`transcripts backtest`); realized-return
metrics need Alpaca historical bars (set `APCA_*`). YouTube caption import is the
one remaining ingestion source still stubbed. The OpenAI/Anthropic analysis
providers are complete (dynamic model listing, alias resolution, schema-repair
retry) but require a funded key; without one, use `--provider offline`.

### Quick web/API tour

```bash
bun run start                        # serve dashboard + API on :8080 (PORT)
curl localhost:8080/api/stats
curl "localhost:8080/api/discover?topic=AI%20infrastructure&limit=10"
```

## Quick start

```bash
bun install
cp .env.example .env   # fill in keys (see below)

bun run cli init                    # create schema (FTS5)
bun run cli providers               # list configured providers
bun run cli models list --provider openai
bun run cli screen --tickers NVDA,AMD --price-max 2000

# Discover from an explicit candidate set (transcript crawlers land in Phase 1):
bun run cli discover "AI infrastructure" \
  --tickers SOUN,BBAI,AITX \
  --price-max 10 --market-cap-min 25m --horizon-quarters 2 \
  --provider openai --model latest
```

Install globally as `transcripts`:

```bash
bun link      # then: transcripts discover "robotics" --price-max 5
```

## Configuration

Config file (TOML) at `~/.config/transcripts/config.toml` (override with
`$TRANSCRIPTS_CONFIG`). See [`config.example.toml`](config.example.toml) for
all options and profiles. **Secrets are never stored in TOML** — they come from
environment variables (see `.env.example`):

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI analysis provider |
| `ANTHROPIC_API_KEY` | Anthropic analysis provider |
| `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` | Alpaca Market Data |
| `DATABASE_URL` | `file:./data/transcripts.sqlite` or `libsql://…` (Turso) |
| `DATABASE_AUTH_TOKEN` | Turso auth token (remote only) |
| `SEC_USER_AGENT` | Required descriptive UA for SEC EDGAR |

## Architecture

```
CLI → Query Planner → Transcript/SEC/Media providers → Downloader/Extractor
  → Normalizer → SQLite+FTS5 → Entity Resolver → Alpaca/SEC data
  → Deterministic Filter Engine → Evidence Builder → OpenAI/Anthropic
  → Consensus & Scoring → Risk/Contradiction checks → Ranked Watchlist
```

Grounding contract (PRD §8.4): prices, financials, dates, quotes, market cap,
volume, and estimates come **only** from deterministic providers. The model
interprets that evidence and must cite stored evidence IDs; it may never invent
facts. Source text is treated as untrusted input (prompt-injection defense).

## Development

```bash
bun test          # deterministic unit tests (indicators, parsing)
bun run typecheck # tsc --noEmit
```

## Compliance

Every ranking includes:

> This output is generated from public information and automated analysis. It
> is a research aid, not a guarantee, personalized recommendation, or substitute
> for professional financial advice. Small-cap and low-priced stocks may be
> highly volatile, illiquid, subject to dilution, manipulation, delisting, and
> total loss.

## License

[MIT](LICENSE) © Profullstack, Inc.
