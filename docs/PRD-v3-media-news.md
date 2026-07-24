# PRD v3 — Multi-Source Ingestion: Media (audio/video) + News

**Status:** proposal · **Date:** 2026-07-24 · **Supersedes nothing; extends [`PRD.md`](PRD.md)**

> Goal: move advis0r from a single-source SEC-exhibit index to a corroborated,
> multi-source evidence graph — executive *speech* (calls, keynotes, conferences,
> podcasts, interviews) plus *reputable news* we fetch and parse ourselves.

---

## 1. Where the product actually stands today

Measured against the **live production Turso DB** on 2026-07-24, not from the README:

| Metric | Value | Implication |
|---|---|---|
| `documents` | 666 | — |
| ...by provider | **`sec-exhibits`: 666 (100%)** | Single-source corpus |
| ...by event type | **`sec_exhibit`: 666 (100%)** | Zero calls / video / podcast / news |
| `transcript_segments` | 42,193 | — |
| ...**with a speaker attributed** | **0 (0%)** | No executive is ever named |
| `signals` | 8,165 across 258 tickers | — |
| ...distinct `speaker` values | **1 — `"Company"`** | Product premise not delivered |
| ...distinct `novelty` values | **1 — `0.5`** | Novelty dimension is inert |
| `analyses` | 51 (35 Sonnet, 16 offline) | Working |
| `analysis_evidence` | **0** | Citations are not persisted |
| `market_bars`, `market_snapshots`, `fundamentals` | **0** | Nothing cached; backtest returns impossible |
| `quotes`, `guidance`, `relationships`, `contradictions`, `companies`, `backtests` | **0** | Schema exists, unused |

### 1.1 The headline problem

advis0r is branded **"Executive Transcript Stock Discovery"**. In production it
currently indexes **zero transcripts and zero executives**. Every document is an
SEC filing exhibit; every signal is attributed to the string `"Company"`.

What the user is asking for — calls, appearances, conferences, podcasts, news —
is not a nice-to-have feature. It is the thing that makes the product match its
own name.

### 1.2 Signal quality is degraded by filing boilerplate

The deterministic extractor in `src/signals/extract.ts` runs regexes over
sentences with no awareness of *document section*. SEC filings are mostly
disclaimer and risk-factor prose, so the rules fire on legalese:

| Contamination measure | Share of the 8,165 signals |
|---|---|
| Quote **or its stored context window** contains a boilerplate marker (`differ materially`, `risks and uncertainties`, `forward-looking`, `safe harbor`, `risk factors`, `incorporated by reference`, `Table of Contents`, `non-GAAP`, `no assurance`) | **20.0%** |
| Quote is **hedged / non-assertive** (`could`, `may`, `would`, `if we`, `intends to`, `expects to`) — i.e. not a claim of fact | **41.8%** |

Real examples pulled from production:

- `[DGX] litigation` → *"Risks and uncertainties that may affect the future results of the company include, but are not limited to…"* — the safe-harbor paragraph.
- `[NGTF] cashflow_improvement` → *"Among the factors that could cause actual results to differ materially…"* — the forward-looking-statements disclaimer.
- `[PRLB] material_weakness` → *"81 Table of Contents 10.31# Form of Restricted Stock Unit Agreement…"* — the **exhibit index**.
- `[TASK] litigation` → *"Adjusted Free Cash Flow is a non-GAAP liquidity measure…"* — a definitions footnote.

`litigation` (2,202) is the single largest signal type in the database and is
overwhelmingly risk-factor boilerplate. This directly poisons the ranking,
because `contradictoryEvidence` and the risk penalties carry the **largest
weights in the model** (0.25 / 0.20 / 0.20 in `src/scoring/weights.ts`).

### 1.3 15% of the score is structurally dead

`composeScore` allocates `independentConfirmation: 0.15`, computed in
`src/evidence/builder.ts` as `clamp(independentSources / 3 * 100)` where
`independentSources` is a `Set` of **URL hosts**. With a 100% `sec.gov` corpus
every ticker resolves to the same small constant. A weight that is identical for
every candidate cannot rank anything — it is 15% of the score doing no work.

**Multi-source ingestion is what switches this weight back on.** That is the
strongest architectural argument for this PRD: the scoring model was designed
for corroboration that the pipeline has never been able to supply.

---

## 2. Proposal A — Media ingestion (audio / video / appearances)

### 2.1 Validated source chain (live-tested 2026-07-24)

Discovery → feed → media → transcript, all keyless except ASR:

```
iTunes Search API (keyless)  →  podcast RSS  →  <enclosure> mp3  →  ASR  →  segments
   200 OK                        200 OK          77 MB verified
```

Verified end-to-end against BG2Pod (Brad Gerstner / Bill Gurley):
`itunes.apple.com/search?entity=podcast` returned `feedUrl`, the feed returned
`<enclosure url="…mp3" length="77556923" type="audio/mpeg"/>`.

| Source | Mechanism | Auth | Status |
|---|---|---|---|
| **Podcasts** | iTunes Search API → RSS `<enclosure>` | keyless | ✅ verified |
| **Podcasts (broader)** | [Podcast Index API](https://podcastindex.org) — ~4M feeds, free for any use | free key | ✅ recommended second index |
| **YouTube** (keynotes, conferences, interviews, IR channels) | `yt-dlp --write-auto-subs --skip-download` for captions; fall back to audio-only + ASR when captions are absent | keyless | ✅ supported in current yt-dlp |
| **Earnings calls** | Company IR pages (webcast/replay links) + `GenericHtmlProvider` seeds; commercial APIs (FMP, API Ninjas, EarningsCall.biz, Finnhub) as a paid shortcut | mixed | ⚠️ IR-page crawl is the keyless path |
| **Conference / investor day** | IR page seeds → HTML or media | keyless | ✅ existing provider handles HTML |

### 2.2 ASR: cost is a non-issue

Groq `whisper-large-v3-turbo` is **$0.04 per hour of audio** at ~216× realtime
(1 hour transcribes in ~15 seconds) — roughly 9× cheaper than OpenAI's Whisper
endpoint at $0.36/hr.

Budget math: covering 250 tickers × 4 calls/year ≈ 1,000 hours ≈ **$40/year**.
Adding 500 podcast episodes/month ≈ 500 hrs/mo ≈ **$20/month**. ASR cost is
immaterial; engineering time is the real cost.

Practical constraints to design around:
- Groq enforces a per-request file-size cap. Preprocess with
  `ffmpeg -i in.mp3 -ar 16000 -ac 1 -c:a flac` and **chunk at ~20 min with ~10 s
  overlap**, then stitch on the overlap.
- Billing has a 10-second minimum per request → batch short clips.
- **Do not retain the audio.** Store the source URL, a SHA-256 of the fetched
  bytes, duration, and the transcript. A single podcast episode is ~77 MB; the
  transcript is ~60 KB.

### 2.3 The differentiating feature: evidence you can *listen to*

`transcript_segments` already has unused `start_ms` / `end_ms` columns, and the
web app already ships an inline `<audio>` player (commit `55b18b1`) and inline
video (commit `d28a47e`). ASR output is natively timestamped.

Wiring these together gives every quote a **play-at-the-exact-second** link:

> *"We're raising full-year guidance"* — CEO, Q2 call, **▶ 34:12**

No competitor in the retail research tier lets you *hear the executive say it*.
This is the single highest-leverage product feature in this document, and it is
mostly plumbing that already exists.

### 2.4 Speaker attribution (fixes the 0% problem)

Deterministic-first, in priority order:

1. **Structured transcript patterns** — earnings-call text reliably contains
   `Operator:`, `Jensen Huang -- CEO`, `Q — Analyst Name, Firm`. Regex handles
   the majority of calls and is fully reproducible.
2. **Roster matching** — populate the empty `executives` / `speakers` tables
   from SEC DEF 14A (proxy) filings, which the ingester already pulls; match
   names against that roster to assign titles.
3. **Diarization for unstructured audio** (podcasts/interviews) — `pyannote`
   locally, or an ASR vendor with native diarization. Deferred; label these
   segments `speaker_confidence < 1` rather than guessing.

**Grounding invariant (PRD §8.4) must extend to ASR**: an ASR transcript is a
*derived* artifact. Persist `asr_model`, `asr_version`, audio checksum, and
per-segment confidence, and mark ASR-derived quotes visibly in the UI so a
mis-transcribed number is never presented as a verbatim executive statement.

---

## 3. Proposal B — News ingestion (self-scraped, reputation-tiered)

### 3.1 Discovery: ValueSERP is already paid for

`VALUESERP_API_KEY` exists in `~/src/tmp/.env` — plan **25k credits/month,
25,000 remaining, 250 req/min, resets 2026-08-13**. Verified live:

```
GET api.valueserp.com/search?search_type=news&q=SoundHound+AI+SOUN&time_period=last_month
→ 200, 6 dated results with source + title + link
```

At ~2 credits/ticker/day, 258 tickers is well inside the monthly budget. This is
the **discovery** layer — it yields URLs, publishers, and dates. Fetching and
parsing the article is ours, which is exactly what was asked for.

### 3.2 Fetchability is not uniform — measured, not assumed

| Outlet | HTTP | Verdict |
|---|---|---|
| AP News | 200 (807 KB text) | ✅ fetch full text |
| Yahoo Finance article | 200 (377 KB text) | ✅ fetch full text |
| Motley Fool article | 200 (226 KB text) | ✅ fetch, but Tier 2 (opinion) |
| Yahoo per-ticker RSS (`feeds.finance.yahoo.com/rss/2.0/headline?s=NVDA`) | 200 | ✅ free per-ticker firehose |
| Google News RSS (`news.google.com/rss/search?q=…`) | 200 (91 KB) | ✅ keyless discovery, complements ValueSERP |
| PR Newswire RSS | 200 (44 KB) | ✅ primary-source wire |
| Business Wire RSS | 200 but 993 B | ⚠️ needs a valid per-topic feed ID |
| GlobeNewswire RSS | timeout | ⚠️ flaky/blocked; retry with backoff |
| Nasdaq RSS | HTTP/2 INTERNAL_ERROR | ❌ blocked |
| **Reuters** | **401** | ❌ **blocked — headline+snippet only** |

**Design consequence:** the pipeline must degrade per-source, not fail. Where a
publisher blocks us (Reuters, Nasdaq), we keep the SERP-provided
**headline + snippet + date + publisher** as a low-weight corroboration record
and never fabricate body text. Where a publisher serves us, we parse the body.

### 3.3 Source tiering — what "reputable" means operationally

Evidence weight and permitted use depend on tier:

| Tier | Sources | Use |
|---|---|---|
| **0 — Primary** | SEC EDGAR, company IR pages, company-owned podcast/YouTube channels, wire releases (Business Wire, GlobeNewswire, PR Newswire) | Full evidentiary weight; may source facts |
| **1 — Reputable press** | AP, Reuters, Bloomberg, WSJ, FT, CNBC, Barron's, MarketWatch, Yahoo Finance (wire syndication) | Corroboration + facts; body text where fetchable, headline-only where blocked |
| **2 — Analysis / opinion** | Motley Fool, Seeking Alpha, Benzinga, Simply Wall St, Zacks | **Sentiment/attention context only — never a source of fact** |
| **3 — Excluded / adverse** | Stocktwits, paid-IR and stock-promotion newsletters, unattributed "PR" microcap blasts | Excluded from evidence; counted as a **risk signal** (see §3.5) |

The ValueSERP probe already returned a Tier-2 (Motley Fool), a Tier-3
(Stocktwits) and a Tier-1 (Yahoo/AP wire) result *in the same six hits* —
confirming that tiering has to happen at ingest, not as an afterthought.

### 3.4 The payoff: cross-source corroboration

This is what turns the dead 15% weight into the product's sharpest edge.

> An 8-K claims a *"major new customer win."*
> Independently, the **customer's own** press release names the vendor.
> Two Tier-0 sources, different issuers, 3 days apart → **corroborated**.

versus:

> An 8-K claims a *"major new customer win."*
> Nothing anywhere else. Only Tier-3 promo blogs amplify it.
> → **uncorroborated + promotion-flagged**.

Today advis0r ranks those two identically. That gap is the whole opportunity.

New table:

```sql
CREATE TABLE IF NOT EXISTS corroborations (
  id                      TEXT PRIMARY KEY,
  ticker                  TEXT NOT NULL,
  claim_signal_id         TEXT REFERENCES signals(id),
  corroborating_doc_id    TEXT REFERENCES documents(id),
  source_tier             INTEGER NOT NULL,
  lag_days                INTEGER,
  relation                TEXT,   -- confirms | contradicts | amplifies_only
  confidence              REAL,
  created_at              TEXT NOT NULL
);
```

`independentSources` then becomes a **tier-weighted count of distinct
issuers/publishers** rather than a count of URL hosts — and the existing
`contradictions` table (0 rows today) finally gets populated by the
`relation = 'contradicts'` case.

### 3.5 Promotion detection — a genuinely differentiated risk signal

advis0r targets exactly the microcap universe where **paid stock promotion** is
endemic. Once news is ingested with tiers, a high-value negative signal falls out
almost for free:

> A sudden burst of Tier-3 coverage with **no Tier-0/1 confirmation**, clustered
> in time, on a low-float ticker, is a classic pump pattern.

Emit `risk_flags.flag = 'promotional_coverage'` (the table already exists and is
empty). This pairs naturally with the existing `dilution` / `atm_offering` /
`reverse_split` signals to catch the promote-then-dilute cycle. Few retail tools
do this at all.

### 3.6 Storage: reuse `documents`, don't fork the schema

News fits the existing pipeline cleanly — `documents` → `transcripts` →
`transcript_segments` → `segments_fts` → `signals` — so full-text search,
signal extraction, and evidence assembly all work unchanged.

Additive columns only:

```sql
ALTER TABLE documents ADD COLUMN publisher     TEXT;
ALTER TABLE documents ADD COLUMN source_tier   INTEGER;   -- 0..3
ALTER TABLE documents ADD COLUMN paywalled     INTEGER DEFAULT 0;
ALTER TABLE documents ADD COLUMN media_url     TEXT;
ALTER TABLE documents ADD COLUMN media_type    TEXT;      -- audio|video|article|filing
ALTER TABLE documents ADD COLUMN duration_ms   INTEGER;
ALTER TABLE documents ADD COLUMN asr_model     TEXT;
ALTER TABLE documents ADD COLUMN asr_version   TEXT;

ALTER TABLE signals   ADD COLUMN source_tier   INTEGER;
ALTER TABLE signals   ADD COLUMN is_boilerplate INTEGER DEFAULT 0;
ALTER TABLE signals   ADD COLUMN speaker_confidence REAL;
```

Add `news_article`, `earnings_call_audio`, and `conference_talk` to the
`EventType` union in `src/types.ts` (which already declares `podcast`,
`keynote`, `fireside_chat`, `interview`, `conference`, `video` — all currently
unreachable because no provider emits them).

### 3.7 Legal / compliance posture

Publicly reachable, logged-out fetching for **research and analysis** is the
well-supported use; republication of article bodies is not. Concretely:

- Respect `robots.txt` and rate limits; keep the descriptive `User-Agent` with
  a contact address that `BaseTranscriptProvider` already sends.
- **Never republish article bodies.** Store them as *internal evidence*; the UI
  shows a short quote + attribution + link to the original. Note that an RSS
  feed does **not** imply a redistribution licence.
- Where a publisher blocks us (Reuters 401), do not route around the block.
  Degrade to headline + snippet + link.
- Extend the existing prompt-injection defence (PRD §26) — news and ASR text are
  *more* hostile than SEC filings, since article bodies can contain adversarial
  instructions.

---

## 4. What else should be fixed (independent of A and B)

Ranked by value per unit of effort.

1. **Section-aware boilerplate suppression** — highest ROI, ~a day's work.
   Three deterministic filters, no LLM:
   (a) suppress signals inside `Forward-Looking Statements` / `Risk Factors` /
   `Safe Harbor` / exhibit-index blocks, detected by heading regex;
   (b) require assertive voice — drop hedged sentences (41.8% of current
   signals);
   (c) **cross-ticker frequency filter** — hash every sentence corpus-wide; a
   near-identical sentence appearing under many distinct tickers is boilerplate
   by definition. Fully deterministic and self-tuning as the corpus grows.
2. **Persist `analysis_evidence`** (0 rows today). Analyses are stored but their
   citations are not — so the "every conclusion cites evidence" promise on the
   About page is not reproducible after the fact. This is a correctness gap in
   the compliance story, not a feature.
3. **Persist `market_bars` / `market_snapshots`** (0 rows). Bars are fetched live
   and discarded, so `transcripts backtest` can never compute realized returns —
   the README's remaining Phase-2 gap is really just a caching gap.
4. **Implement `novelty`** (hardcoded `0.5` for all 8,165 signals). Novelty is
   *language change across periods*: diff this quarter's phrasing against the
   same company's prior filings/calls. First-time claims are the alpha; repeated
   claims are noise. The corpus now spans 2025-07 → 2026-07, enough history to
   compute it.
5. **Populate `companies` / `executives` / `speakers`** from DEF 14A — unblocks
   speaker titles, management-turnover tracking, and `managementCredibility`
   scoring against a real roster.
6. **Track claim → outcome ("management credibility")** — the score already has a
   `managementCredibilityScore` input with no data behind it. With multi-period
   media + news, you can measure whether a CEO's guidance actually landed. This
   is a durable moat: it compounds with corpus age and cannot be copied quickly.
7. **Alerting** — "notify me when a Tier-0 source corroborates a new claim on a
   watchlist ticker." Turns a research tool into something with a reason to
   return daily. Mail infrastructure already exists in the wider estate.

---

## 5. Milestones

| M | Scope | Status |
|---|---|---|
| **M1** | Boilerplate suppression + assertive-voice filter + cross-issuer frequency filter; persist `analysis_evidence` | ✅ **shipped, applied to production** |
| **M2** | News: ValueSERP + Google News RSS + Yahoo per-ticker RSS discovery → tiered fetch/parse → `documents` | ✅ **shipped** |
| **M3** | Corroboration engine + `promotional_coverage` risk flag + tier-weighted `independentSources` | ✅ **shipped** |
| **M4** | Media: podcast (iTunes/Podcast Index) + YouTube captions → Groq ASR → timestamped segments | ✅ **shipped** (see §5.1 for the two operational prerequisites) |
| **M5** | Speaker attribution (regex → DEF 14A roster → diarization) | ◐ regex layer shipped; DEF 14A roster + diarization outstanding |
| **M6** | Novelty via cross-period language diff; claim→outcome credibility tracking | ☐ not started |

### 5.1 What M4 needs to run in production

The media pipeline is implemented and unit-tested end to end, and podcast and
video **discovery** were verified live. Two prerequisites are environmental, not
code:

1. **`GROQ_API_KEY` is not set.** Without it the podcast/ASR path cannot run
   (captions still work). Cost is ~$0.04/hour of audio.
2. **YouTube bot-blocks this host.** `yt-dlp` search works, but caption download
   returns *"Sign in to confirm you're not a bot"* — the standard datacenter-IP
   block. Set `YTDLP_COOKIES=/path/to/cookies.txt` or
   `YTDLP_COOKIES_FROM_BROWSER=<browser>`. The provider raises an explicit
   `YouTubeBlockedError` rather than reporting "no captions", because the two
   need very different operator responses.

### 5.2 Measured results

| Change | Before | After |
|---|---|---|
| Signals usable for ranking | 8,165 (43.8% boilerplate) | **4,591 usable**, 3,574 flagged |
| `litigation` signals (the noisiest type) | 2,202 | **995** |
| `analysis_evidence` rows | 0 | written on every persisted analysis |
| Corpus sources | 1 (`sec-exhibits`) | **3** providers (`sec-exhibits`, `news`, `media`) |
| `independentSources` | ~constant for every ticker | QBTS 2.0 · VST 0.75 · HON 1.0 |

---

## 6. Invariants this PRD must not break

Carried forward from [`PRD.md`](PRD.md):

- **§8.4 Grounding** — extended: ASR transcripts and news bodies are *derived/
  third-party* evidence. Tag provenance (`asr_model`, `publisher`,
  `source_tier`); never let Tier-2/3 text source a fact.
- **§12/§13 Deterministic-first** — tiering, boilerplate suppression,
  corroboration matching, and novelty are all deterministic and run **before**
  any LLM call.
- **§26 Security** — news and ASR text are untrusted and more adversarial than
  filings; sanitize and defend against prompt injection.
- **§27 Compliance** — never republish article bodies; show contradictory
  evidence; keep the research-aid disclaimer on every ranking.
