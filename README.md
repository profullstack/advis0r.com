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
- **Persistent report pages** at `/ticker/<SYMBOL>` — every generated report is
  stored and served from storage rather than rebuilt on each view. See
  [Report pages](#report-pages).
- **Watchlist email digests** — a market summary of the previous session (or the
  previous week) delivered as pre-market trading opens, 04:00 ET. See
  [Email digests](#email-digests).

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

- **News** — `transcripts news <TICKERS...>`, and automatically on every AI
  analysis (see below). Keyless discovery (Yahoo per-ticker RSS, Bing News RSS,
  Google News RSS, newswire feeds) plus optional ValueSERP search; article
  bodies are fetched and parsed by us, never taken from a vendor summary. A
  headline must name the company for the article to be ingested — a per-ticker
  feed is otherwise half syndicated market commentary about other issuers. Every
  document carries a **reputation tier** (0 primary / 1 reputable press /
  2 analysis / 3 excluded) that decides its evidentiary weight. `robots.txt` is
  honoured and publishers that block automated access degrade to
  headline + snippet rather than being routed around.

  **On-demand refresh.** `/api/analyze` and `/api/analyze/stream` top up news
  for the ticker being analyzed immediately before the model call, so "Sharpen
  with AI" reasons over current coverage instead of whatever a past CLI run left
  behind. That path is keyless (RSS only — an interactive click never spends
  search credits), skipped when the ticker was refreshed in the last 6 hours,
  and abandoned after 25s so a slow publisher cannot hold up an analysis.
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
curl localhost:8080/crypto/BTC-USD   # crypto: see below
```

## Crypto

Crypto market data is served from **the same Alpaca account as equities** — the
crypto feed carries no additional subscription and needs no additional vendor,
so `APCA_API_KEY_ID` / `APCA_API_SECRET_KEY` are the only credentials involved.
The feed also answers **unauthenticated**, so `/crypto/**` keeps working on a
deployment where those keys are missing, expired, or rate-limited; requests are
signed when the keys are present and unsigned when they are not. That is why
there is no Yahoo-style fallback on this path — the primary source degrades to
itself rather than to a second vendor with different provenance.

In the web dashboard this is the **Crypto** tab: a live grid of the majors
(click any pair for candles, indicators and depth), a name-or-symbol picker, and
an opt-in 30s auto-refresh that only ticks while that tab is actually on screen.
Prices are fetched when the tab is first opened rather than on boot, so a
visitor who never looks at it costs no upstream calls. Deep link one pair with
`/?pair=BTC-USD`.

Everything crypto is namespaced under **`/crypto/**`**. `/api/crypto/**` is an
alias for the identical surface.

| Endpoint | Returns |
| --- | --- |
| `GET /crypto` | index of the crypto surface, including which auth mode is in effect |
| `GET /crypto/assets` | the 49 supported pairs, each marked `live`/`idle` from a real probe |
| `GET /crypto/lookup?q=bitcoin` | name or ticker → pair (`BTC/USD`) |
| `GET /crypto/snapshot?symbols=BTC/USD,ETH/USD` | latest trade, quote, daily + previous bars, session change |
| `GET /crypto/quote?symbol=BTC/USD` | latest trade/quote with spread and spread in basis points |
| `GET /crypto/bars?symbol=&timeframe=&start=&end=&limit=` | historical OHLCV (`1Min`…`1Week`) |
| `GET /crypto/orderbook?symbol=&depth=` | top of book, both sides |
| `GET /crypto/technicals?symbol=&horizon=1\|2` | locally computed indicators + technical score |
| `GET /crypto/report?symbol=` | snapshot + technicals + score in one call |
| `GET /crypto/<PAIR>` | the same report by path, e.g. `/crypto/BTC-USD` |

```bash
curl "localhost:8080/crypto/lookup?q=bitcoin"
curl "localhost:8080/crypto/quote?symbols=btc,ETH-USD,SOLUSD"
curl "localhost:8080/crypto/BTC-USD"
```

### Symbols

Alpaca writes pairs `BASE/QUOTE`, and a slash is hostile in a URL path, so every
route accepts four spellings and answers with the canonical one:

| You send | Resolves to |
| --- | --- |
| `BTC/USD` | `BTC/USD` (canonical) |
| `BTC-USD` | `BTC/USD` (URL-safe — use this in paths) |
| `BTC` | `BTC/USD` (bare asset defaults to the USD pair) |
| `BTCUSD` | `BTC/USD` (longest quote wins, so `BTCUSDT` → `BTC/USDT`) |

A pair Alpaca does not serve is rejected with a suggestion rather than forwarded
upstream (`?symbol=bitcoin` → 400 with `didYouMean: BTC/USD`). In a multi-symbol
basket the valid symbols still return, and the dropped ones are named in
`rejected` — a basket that silently returned 2 of 3 would read as "no data for
that pair" when the truth is "we did not accept that spelling".

The pair directory in [`src/crypto/pairs.ts`](src/crypto/pairs.ts) is a probed
seed, not a guess: every entry returned a real bar from Alpaca on 2026-08-06.
`/crypto/assets` re-probes hourly and marks each pair `live` or `idle`, so a
delisting surfaces without a code change; if the probe itself fails the response
says `liveness: unverified` rather than reporting everything idle.

### Reading the technical score

The indicator and scoring engines are shared with equities and every value is
still computed locally — but two components mean something different here, and
each crypto response repeats this in its `caveats`:

- **Volume-derived values** (`relativeVolume`, `avgDollarVolume`, and hence the
  score's `liquidity` component) reflect **Alpaca's US venue alone**, not
  aggregate market volume. A low liquidity component here is not evidence that
  the asset is thinly traded.
- **Calendar windows.** Crypto trades 24/7, so a 200-day window spans fewer
  market events per bar than 200 equity sessions.

Crypto responses carry `CRYPTO_DISCLAIMER` rather than the equity one: no
issuer, no listing standards, no circuit breakers, and venue-specific pricing.

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
| `RESEND_API_KEY` / `MAILGUN_API_KEY` | Transactional + digest email transport |
| `APP_URL` | Public base URL used for links in emails |
| `DIGEST_SCHEDULER` | `0` disables the built-in 04:00 ET digest scheduler |

## Ticker lookup

Type a company name anywhere a ticker is asked for and it resolves: **`rivian` → RIVN**.

Before this, knowing the ticker was a precondition for using a tool whose job is
to find tickers. `rivian` was rejected by the watchlist (over five letters),
unusable in the signals box (which wants an exact symbol), and answered by
full-text search with *Amazon's 10-Q* — because that filing mentions their
Rivian stake.

```bash
curl "localhost:8080/api/lookup?q=rivian"      # -> RIVN
curl "localhost:8080/api/lookup?q=coca+cola"   # -> KO
bun run cli symbols find "berkshire hathaway"  # -> BRK.A, BRK.B
```

The watchlist and signals boxes are typeaheads over this, and the recovery paths
are wired too: `/ticker/rivian` redirects to `/ticker/RIVN`, and
`/api/ticker?symbol=rivian` answers with a `didYouMean` instead of a bare error.

**Local-first.** `bun run cli symbols sync` loads the full tradable-asset list
(~11k rows, Alpaca) so lookup is one indexed query with no third-party call —
fast enough for a typeahead. Without Alpaca credentials it still works: a keyless
Yahoo search covers the miss and the result is cached, so a given gap is paid for
once. Single-character queries never leave the box.

Ranking is the feature — exact symbol > symbol prefix > name prefix > word
prefix > substring, with ties broken toward the primary listing (preferred
exchange, then shorter symbol). That is what puts RIVN above its warrants, AAPL
above Apple Hospitality REIT, and KO above Coca-Cola Consolidated.

| Command | |
|---|---|
| `symbols sync` | Load the full asset list into the directory |
| `symbols find <query>` | Look up a ticker by name or symbol |
| `symbols status` | Directory size and freshness |

## Report pages

Every ticker that has been looked at has a report at **`/ticker/<SYMBOL>`** — a
server-rendered page you can share, bookmark, or hand to a crawler.

A report is a **stored snapshot**, not a live view. Building one costs a bars
fetch, a quote snapshot, an asset lookup, a SEC EDGAR company-facts call, an
evidence build and an offline analysis — seconds of latency and a handful of
third-party requests. The snapshot is written once and read back thereafter:

```
first view of NVDA   1.86s   (builds and stores)
every view after     0.19s   (one row read, zero external calls)
```

| Route | What it is |
|---|---|
| `GET /ticker/<SYMBOL>` | The report as a shareable page. `404` + a build CTA when none exists |
| `GET /reports?sort=recent\|score\|ticker` | Index of every stored report |
| `GET /sitemap.xml`, `/robots.txt` | Report URLs for crawlers |
| `GET /api/ticker?symbol=` | The same snapshot as JSON |
| `GET /api/reports?limit=&sort=` | The index as JSON |
| `POST /api/report/regenerate` | Rebuild one snapshot — **watchlist members only** |

**A snapshot is never refreshed on a timer.** Rebuilding on a cache age would
reintroduce exactly the cost this removes. It is rebuilt when it does not exist,
when a watchlist member asks, or automatically after a paid AI analysis (so the
page reflects the new run). What keeps that honest is that every surface —
page, modal, index — renders how old the snapshot is. A stale price is fine;
a stale price dressed up as a live one is not.

Reading is public and free. Writing is not, so regeneration requires a signed-in
user, a ticker **on their own watchlist**, and survives a per-account throttle
(30/hour). The button is a courtesy; the server check is the control.

The pages need no JavaScript — the price history is inline SVG — so they work in
a crawler, a link preview, or a text browser. The interactive candlestick view
stays in the app's modal, one click away.

In the app, watchlist rows link to `/ticker/<SYMBOL>` (so middle-click and
"open in new tab" work) but open the modal on click. The modal shows the
snapshot age, a permalink, and — for watchlist tickers — a **↻ Regenerate**
button. Regenerating refreshes the report's *data* and is free; re-running the
LLM is the separate, credit-metered **Re-run AI** button, so a free action never
silently spends a credit.

## Email digests

Signed-in users get a market summary of the tickers on their saved watchlist,
delivered when US pre-market trading opens (**04:00 America/New_York**) on
trading days. Frequency is set on the Watchlist tab:

| Choice | When it arrives | What it covers |
|---|---|---|
| `daily` (**default**) | Every trading day | The previous trading session |
| `weekly` | The week's first trading day | Every session of the week just closed |
| `off` | — | Nothing |

Each message contains broad-market context (SPY/QQQ/IWM/DIA), a per-ticker table
(close, change vs. the pre-window close, volume or weekly range), any indexed
news for those tickers, the mandatory disclaimer, and a working unsubscribe link
plus RFC 8058 one-click headers.

Delivery rules, all enforced server-side:

- Only **verified, enabled accounts with a non-empty watchlist** are mailed.
- Delivery is **at-most-once per period** — `digest_sends` has a
  `UNIQUE(user_id, period_key)` interlock, so a duplicated cron run, a restart,
  or two servers cannot send the same summary twice.
- A run more than 6 hours past the open is **skipped rather than sent late**.
- A failed send releases its claim so a later run inside that window retries.
- A ticker with no market data is reported as unavailable; nothing is
  interpolated.

The server runs the schedule itself — no cron needed. Set `DIGEST_SCHEDULER=0`
to drive it externally instead:

```cron
# Every 15 minutes; the ledger makes the extra runs no-ops.
*/15 8-14 * * 1-5  cd /srv/advis0r && bun run cli digest send >> /var/log/digest.log 2>&1
```

```bash
bun run cli digest send                       # send whatever is due now
bun run cli digest send --dry-run --force     # build it, send nothing
bun run cli digest preview you@example.com    # print the exact email
bun run cli digest status                     # subscriber counts
bun run cli digest status you@example.com     # one account's history
bun run cli digest set you@example.com weekly # change a frequency
```

The API surface is `GET /api/digest` and `POST /api/digest {frequency}` (both
require a session), plus `GET|POST /unsubscribe?token=…`, which deliberately
needs no sign-in.

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
