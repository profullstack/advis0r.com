/**
 * Server-rendered report pages: `/ticker/<SYMBOL>` and the `/reports` index.
 *
 * These are real pages, not an SPA route, for three reasons that all follow from
 * the reports being persistent artifacts:
 *
 *   - **Shareable.** A URL that renders the report without running JavaScript
 *     can be pasted into a chat, an email digest, or a search index.
 *   - **Honest about time.** A snapshot is only meaningful with the moment it
 *     was taken attached, so `generatedAt` is rendered prominently rather than
 *     buried — never a stale price wearing the costume of a live one.
 *   - **Cheap.** Rendering reads one row. No market-data call, no SEC call.
 *
 * The price history is drawn as inline SVG rather than mounting the charting
 * library: the page then needs no script at all, which is what makes it work in
 * a crawler, a preview card, or a text browser. The interactive candlestick view
 * still lives in the app's modal, one click away.
 */
import { DISCLAIMER } from "../compliance.ts";
import { escapeHtml, escapeXml } from "../util/html.ts";
import type { ReportSummary, StoredReport } from "./store.ts";

const e = escapeHtml;

/* ---------------- formatting ---------------- */

function money(n: unknown): string {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return "—";
  return v < 1 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`;
}

function big(n: unknown): string {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (Math.abs(v) >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function num(n: unknown, digits = 2): string {
  const v = Number(n);
  return n == null || !Number.isFinite(v)
    ? "—"
    : v.toLocaleString("en-US", { maximumFractionDigits: digits });
}

function score(n: unknown): string {
  const v = Number(n);
  return n == null || !Number.isFinite(v) ? "—" : `${Math.round(v)}<span class="rp-of">/100</span>`;
}

/** "3 hours ago" — the single most important fact about a snapshot. */
export function relativeTime(iso: string, now = new Date()): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";
  const secs = Math.max(0, Math.round((now.getTime() - then) / 1000));
  const units: Array<[number, string]> = [
    [60, "second"], [3600, "minute"], [86_400, "hour"],
    [604_800, "day"], [2_629_800, "week"], [31_557_600, "month"],
  ];
  if (secs < 45) return "just now";
  let divisor = 1;
  for (const [limit, name] of units) {
    if (secs < limit) {
      const value = Math.round(secs / divisor);
      return `${value} ${name}${value === 1 ? "" : "s"} ago`;
    }
    divisor = limit;
  }
  const years = Math.round(secs / 31_557_600);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function absoluteTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleString("en-US", {
        timeZone: "America/New_York", month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit",
      }) + " ET";
}

const classBadge = (c: unknown): string => {
  const v = String(c ?? "");
  if (!v) return "";
  const cls = v === "high-risk speculative" ? "high" : v === "speculative" ? "speculative" : "conservative";
  return `<span class="rp-badge ${cls}">${e(v)}</span>`;
};

/* ---------------- price sparkline ---------------- */

interface Bar { t?: string; c?: number }

/**
 * Inline SVG close-price line. Returns "" for too few points rather than
 * drawing a degenerate chart that implies a trend from one dot.
 */
export function sparkline(bars: Bar[], opts: { width?: number; height?: number } = {}): string {
  const closes = bars.map((b) => Number(b.c)).filter((n) => Number.isFinite(n));
  if (closes.length < 2) return "";
  const w = opts.width ?? 720;
  const h = opts.height ?? 160;
  const pad = 4;
  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || 1;
  const x = (i: number) => pad + (i / (closes.length - 1)) * (w - pad * 2);
  const y = (v: number) => h - pad - ((v - min) / span) * (h - pad * 2);

  const line = closes.map((v, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const area = `${line}L${x(closes.length - 1).toFixed(1)},${h - pad}L${x(0).toFixed(1)},${h - pad}Z`;
  const up = closes.at(-1)! >= closes[0]!;
  const stroke = up ? "#35d07f" : "#ff6b6b";
  const first = bars.find((b) => b.t)?.t ?? "";
  const last = [...bars].reverse().find((b) => b.t)?.t ?? "";

  return `<figure class="rp-spark">
    <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img"
         aria-label="Closing price from ${e(first)} to ${e(last)}: ${money(closes[0])} to ${money(closes.at(-1))}">
      <defs><linearGradient id="rpg" x1="0" x2="0" y1="0" y2="1">
        <stop offset="0%" stop-color="${stroke}" stop-opacity=".28"/>
        <stop offset="100%" stop-color="${stroke}" stop-opacity="0"/>
      </linearGradient></defs>
      <path d="${area}" fill="url(#rpg)"/>
      <path d="${line}" fill="none" stroke="${stroke}" stroke-width="2"
            stroke-linejoin="round" stroke-linecap="round"/>
    </svg>
    <figcaption>${e(String(first).slice(0, 10))} → ${e(String(last).slice(0, 10))} · low ${money(min)} · high ${money(max)}</figcaption>
  </figure>`;
}

/* ---------------- page chrome ---------------- */

export interface PageMeta {
  title: string;
  description: string;
  canonical: string;
  /** Emitted as <meta name="robots"> when set. */
  robots?: string;
  jsonLd?: unknown;
}

function shell(meta: PageMeta, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#0a0e14">
<title>${e(meta.title)}</title>
<meta name="description" content="${e(meta.description)}">
<link rel="canonical" href="${e(meta.canonical)}">
${meta.robots ? `<meta name="robots" content="${e(meta.robots)}">` : ""}
<meta property="og:type" content="article">
<meta property="og:title" content="${e(meta.title)}">
<meta property="og:description" content="${e(meta.description)}">
<meta property="og:url" content="${e(meta.canonical)}">
<meta property="og:site_name" content="advis0r.com">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${e(meta.title)}">
<meta name="twitter:description" content="${e(meta.description)}">
<link rel="icon" href="/icon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-192.png">
<link rel="stylesheet" href="/styles.css">
${meta.jsonLd ? `<script type="application/ld+json">${JSON.stringify(meta.jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
</head>
<body class="rp-body">
<header class="rp-top">
  <a class="rp-brand" href="/"><img src="/icon.svg" alt="" width="26" height="26"><span>advis0r<span class="dim">.com</span></span></a>
  <nav class="rp-nav"><a href="/reports">All reports</a><a href="/#watchlist">Watchlist</a><a href="/#about">About</a></nav>
</header>
<main class="rp-main">
${body}
</main>
<footer class="rp-foot">
  <p class="rp-disclaimer">${e(DISCLAIMER.replace(/\s+/g, " "))}</p>
  <p><a href="/">advis0r.com</a> · <a href="/reports">All reports</a> · <a href="/api">API</a></p>
</footer>
</body>
</html>`;
}

/* ---------------- report page ---------------- */

const kv = (k: string, v: string, cls = "") =>
  `<div class="rp-kv"><dt>${e(k)}</dt><dd class="${cls}">${v}</dd></div>`;

function chips(items: unknown, cls: string, mark: string): string {
  if (!Array.isArray(items) || !items.length) return "";
  return `<ul class="rp-chips">${items
    .slice(0, 8)
    .map((x) => `<li class="rp-chip ${cls}">${mark} ${e(x)}</li>`)
    .join("")}</ul>`;
}

function analysisSection(payload: Record<string, any>): string {
  const ai = payload.aiAnalysis;
  const src = ai ? ai.analysis : payload.analysis;
  if (!src?.thesis) return "";
  const overall = ai ? ai.overallScore : payload.overallScore;
  const conf = ai ? ai.confidence : payload.confidence;
  const provenance = ai
    ? `<span class="rp-badge ai">AI · ${e(ai.provider)}:${e(ai.model)}</span>${
        ai.createdAt ? `<span class="rp-when">run ${e(absoluteTime(String(ai.createdAt)))}</span>` : ""
      }`
    : `<span class="rp-badge conservative">offline · deterministic</span>`;

  const pct = (s: any) => (s?.probability != null ? `${Math.round(s.probability * 100)}%` : "—");
  const scenarios = src.bullCase || src.bearCase
    ? `<h3>Scenarios</h3>
       <p class="rp-scen">Bull ${pct(src.bullCase)} · Base ${pct(src.baseCase)} · Bear ${pct(src.bearCase)}</p>
       ${src.bullCase?.assumptions?.[0] ? `<p class="rp-scen-line"><span class="pos">Bull</span> ${e(src.bullCase.assumptions[0])}</p>` : ""}
       ${src.bearCase?.assumptions?.[0] ? `<p class="rp-scen-line"><span class="neg">Bear</span> ${e(src.bearCase.assumptions[0])}</p>` : ""}`
    : "";

  return `<section class="rp-section">
    <h2>Analysis ${provenance}</h2>
    <p class="rp-thesis">${e(src.thesis)}</p>
    <dl class="rp-grid">
      ${kv("Overall", score(overall))}
      ${kv("Confidence", score(conf))}
    </dl>
    ${Array.isArray(src.catalystSummary) && src.catalystSummary.length ? `<h3>Catalysts</h3>${chips(src.catalystSummary, "pos", "▲")}` : ""}
    ${Array.isArray(src.riskSummary) && src.riskSummary.length ? `<h3>Risks</h3>${chips(src.riskSummary, "neg", "▼")}` : ""}
    ${scenarios}
    ${Array.isArray(src.missingData) && src.missingData.length ? `<h3>Missing data</h3><p class="rp-note">${src.missingData.map((x: unknown) => e(x)).join(" · ")}</p>` : ""}
  </section>`;
}

const EVENT_LABELS: Record<string, string> = {
  earnings_call: "Earnings call", investor_day: "Investor day", conference: "Conference",
  keynote: "Keynote", fireside_chat: "Fireside chat", interview: "Interview",
  shareholder_meeting: "Shareholder meeting", product_launch: "Product launch",
  press_conference: "Press conference", podcast: "Podcast", presentation: "Presentation",
  sec_exhibit: "SEC exhibit", blog_post: "Blog post", video: "Video",
  news_article: "News", press_release: "Press release",
};

function sourcesSection(payload: Record<string, any>): string {
  const sources: any[] = Array.isArray(payload.sources) ? payload.sources : [];
  if (!sources.length) return "";
  const items = sources
    .slice(0, 40)
    .map((s) => {
      const said = (Array.isArray(s.said) ? s.said : [])
        .slice(0, 4)
        .map(
          (q: any) => `<li class="rp-said"><span class="rp-dir ${e(q.direction)}">${
            q.direction === "positive" ? "▲" : q.direction === "negative" ? "▼" : "•"
          } ${e(String(q.signalType ?? "").replace(/_/g, " "))}</span>
          <q>${e(String(q.quote ?? "").slice(0, 240))}</q></li>`,
        )
        .join("");
      return `<li class="rp-source">
        <div class="rp-source-head">
          <span class="rp-kind rp-kind-${e(s.kind ?? "transcript")}">${e(EVENT_LABELS[String(s.eventType)] ?? "Document")}</span>
          ${s.publisher ? `<span class="rp-pub">${e(s.publisher)}</span>` : ""}
          ${s.publishedAt ? `<time datetime="${e(String(s.publishedAt))}">${e(String(s.publishedAt).slice(0, 10))}</time>` : ""}
          <a class="rp-source-link" href="${e(s.url)}" rel="nofollow noopener" target="_blank">Open ↗</a>
        </div>
        ${s.title ? `<a class="rp-source-title" href="${e(s.url)}" rel="nofollow noopener" target="_blank">${e(s.title)}</a>` : ""}
        ${said ? `<ul class="rp-saids">${said}</ul>` : ""}
      </li>`;
    })
    .join("");
  return `<section class="rp-section">
    <h2>Sources <span class="rp-count">${sources.length}</span></h2>
    <ul class="rp-sources">${items}</ul>
  </section>`;
}

export interface ReportPageOptions {
  appUrl: string;
  now?: Date;
}

/** Render a stored report as a standalone page. */
export function renderReportPage(report: StoredReport, opts: ReportPageOptions): string {
  const p = report.payload as Record<string, any>;
  const ticker = report.ticker;
  const base = opts.appUrl.replace(/\/$/, "");
  const canonical = `${base}/ticker/${encodeURIComponent(ticker)}`;
  const t = p.technical ?? {};
  const f = p.facts ?? {};
  const ai = p.aiAnalysis;
  const src = ai ? ai.analysis : p.analysis;
  const bars: Bar[] = Array.isArray(p.bars) ? p.bars : [];

  const change = bars.length > 1 && bars.at(-2)?.c
    ? ((Number(bars.at(-1)!.c) - Number(bars.at(-2)!.c)) / Number(bars.at(-2)!.c)) * 100
    : null;

  const name = String(p.companyName ?? ticker);
  const thesis = String(src?.thesis ?? "").slice(0, 200);
  const description = thesis
    ? `${ticker} — ${thesis}`
    : `Evidence-backed research report for ${ticker} (${name}) built from executive transcripts, news and market data.`;

  const body = `
<article class="rp-report">
  <header class="rp-head">
    <div class="rp-id">
      <h1>${e(ticker)}</h1>
      ${classBadge(p.classification)}
      <p class="rp-company">${e(name)}${p.exchange ? ` · ${e(p.exchange)}` : ""}</p>
    </div>
    <div class="rp-price">
      <div class="rp-last">${money(p.lastPrice)}</div>
      <div class="rp-sub">
        ${change != null ? `<span class="${change >= 0 ? "pos" : "neg"}">${change >= 0 ? "+" : ""}${change.toFixed(2)}%</span> · ` : ""}
        ${p.delayed ? "delayed" : "live"} · ${e(p.marketSource ?? "market data")}
      </div>
    </div>
  </header>

  <p class="rp-stamp">
    Snapshot taken <strong>${e(relativeTime(report.generatedAt, opts.now))}</strong>
    <span class="rp-when">(${e(absoluteTime(report.generatedAt))})</span>.
    Stored, not recomputed — prices are as of that moment.
    <a class="rp-open" href="/?ticker=${encodeURIComponent(ticker)}">Open in the app ↗</a>
  </p>

  ${sparkline(bars)}

  ${analysisSection(p)}

  <section class="rp-section">
    <h2>Technical</h2>
    <dl class="rp-grid">
      ${kv("Trend", e(t.trend ?? "—"), t.trend === "bullish" ? "pos" : t.trend === "bearish" ? "neg" : "")}
      ${kv("Tech score", t.score != null ? score(t.score) : score(p.technicalScore?.score))}
      ${kv("RSI(14)", num(t.rsi14, 1))}
      ${kv("SMA 20/50/200", `${num(t.sma?.[20])} / ${num(t.sma?.[50])} / ${num(t.sma?.[200])}`)}
      ${kv("MACD", num(t.macd?.macd, 3))}
      ${kv("ATR(14)", num(t.atr14, 3))}
      ${kv("Rel volume", num(t.relativeVolume))}
      ${kv("Avg $ volume", big(t.avgDollarVolume))}
      ${kv("Momentum 20/60/120d", `${num(t.momentum?.[20], 1)}% / ${num(t.momentum?.[60], 1)}% / ${num(t.momentum?.[120], 1)}%`)}
      ${kv("From 52w high", t.distanceFrom52WeekHigh != null ? `${num(t.distanceFrom52WeekHigh, 1)}%` : "—")}
      ${kv("Golden cross", t.goldenCross ? "yes" : "no", t.goldenCross ? "pos" : "")}
      ${kv("Volatility", e(t.volatilityRegime ?? "—"))}
    </dl>
  </section>

  <section class="rp-section">
    <h2>Fundamentals <span class="rp-count">SEC</span></h2>
    <dl class="rp-grid">
      ${kv("Market cap", big(f.marketCap))}
      ${kv("Shares outstanding", num(f.sharesOutstanding, 0))}
      ${kv("Public float", num(f.publicFloat, 0))}
      ${kv("Revenue", big(f.revenue))}
      ${kv("Revenue growth", f.revenueGrowth != null ? `${num(f.revenueGrowth, 1)}%` : "—", Number(f.revenueGrowth) >= 0 ? "pos" : "neg")}
      ${kv("Cash", big(f.cashBalance))}
      ${kv("Debt", big(f.totalDebt))}
      ${kv("Runway", f.runwayMonths != null ? `${num(f.runwayMonths, 1)} mo` : "—")}
    </dl>
    ${p.factsError ? `<p class="rp-note">SEC EDGAR was unavailable when this snapshot was taken (${e(p.factsError)}). Regenerate to fill these in.</p>` : ""}
  </section>

  ${sourcesSection(p)}

  <p class="rp-note">
    Prices from ${e(p.marketSource ?? "market data")} (${p.delayed ? "delayed" : "real-time"}).
    Fundamentals from SEC EDGAR. Indicators computed locally.
    First covered ${e(absoluteTime(report.firstGeneratedAt))}.
  </p>
</article>`;

  return shell(
    {
      title: `${ticker}${p.companyName ? ` — ${name}` : ""} research report · advis0r.com`,
      description,
      canonical,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "Report",
        name: `${ticker} research report`,
        about: name,
        datePublished: report.firstGeneratedAt,
        dateModified: report.generatedAt,
        url: canonical,
        publisher: { "@type": "Organization", name: "advis0r.com" },
        // The disclaimer is part of the machine-readable record too: this is
        // research output, and nothing should be able to strip that framing.
        disclaimer: DISCLAIMER.replace(/\s+/g, " "),
      },
    },
    body,
  );
}

/**
 * Page for a ticker with no stored report yet.
 *
 * Deliberately `noindex`: an empty placeholder for every conceivable symbol
 * would otherwise be a few thousand thin pages inviting a crawler to generate
 * reports on our dime.
 */
export function renderMissingReportPage(ticker: string, opts: ReportPageOptions): string {
  const base = opts.appUrl.replace(/\/$/, "");
  return shell(
    {
      title: `${ticker} — no report yet · advis0r.com`,
      description: `No research report has been generated for ${ticker} yet.`,
      canonical: `${base}/ticker/${encodeURIComponent(ticker)}`,
      robots: "noindex, follow",
    },
    `<article class="rp-report rp-empty">
      <h1>${e(ticker)}</h1>
      <p class="rp-lede">No report has been generated for this ticker yet.</p>
      <p>Open it in the app to build one — the first view gathers market data, SEC
         fundamentals and indexed coverage, then this page serves that snapshot from
         then on.</p>
      <p><a class="rp-cta" href="/?ticker=${encodeURIComponent(ticker)}">Generate the ${e(ticker)} report</a></p>
      <p class="rp-note">
        Not the right symbol? <a href="/?lookup=${encodeURIComponent(ticker)}">Search by company name</a>
        · <a href="/reports">Browse existing reports</a>
      </p>
    </article>`,
  );
}

/* ---------------- index page ---------------- */

export function renderReportIndex(
  reports: ReportSummary[],
  opts: ReportPageOptions & { total: number; sort: string },
): string {
  const base = opts.appUrl.replace(/\/$/, "");
  const rows = reports
    .map(
      (r) => `<li class="rp-row">
        <a class="rp-row-tick" href="/ticker/${encodeURIComponent(r.ticker)}">${e(r.ticker)}</a>
        <span class="rp-row-name">${e(r.companyName ?? "")}</span>
        <span class="rp-row-price">${money(r.lastPrice)}</span>
        <span class="rp-row-score">${r.overallScore != null ? score(r.overallScore) : "—"}</span>
        <span class="rp-row-meta">${r.aiProvider ? `<span class="rp-badge ai">AI</span>` : ""}${r.sourceCount} src</span>
        <time class="rp-row-when" datetime="${e(r.generatedAt)}">${e(relativeTime(r.generatedAt, opts.now))}</time>
      </li>`,
    )
    .join("");

  const tab = (key: string, label: string) =>
    `<a class="rp-tab${opts.sort === key ? " on" : ""}" href="/reports?sort=${key}">${label}</a>`;

  return shell(
    {
      title: "All research reports · advis0r.com",
      description: `${opts.total} evidence-backed stock research reports built from executive transcripts, news and market data.`,
      canonical: `${base}/reports`,
    },
    `<div class="rp-index">
      <h1>Research reports</h1>
      <p class="rp-lede">${opts.total} ticker${opts.total === 1 ? "" : "s"} covered. Each report is a stored
        snapshot — opening one costs nothing and changes nothing.</p>
      <nav class="rp-tabs">${tab("recent", "Newest")}${tab("score", "Highest score")}${tab("ticker", "A–Z")}</nav>
      ${reports.length
        ? `<ol class="rp-rows">${rows}</ol>`
        : `<p class="rp-note">No reports yet. Open any ticker in the app to generate the first one.</p>`}
    </div>`,
  );
}

/* ---------------- sitemap ---------------- */

export function renderSitemap(
  refs: Array<{ ticker: string; generatedAt: string }>,
  appUrl: string,
): string {
  const base = appUrl.replace(/\/$/, "");
  const urls = [
    `<url><loc>${escapeXml(base)}/</loc><changefreq>daily</changefreq><priority>1.0</priority></url>`,
    `<url><loc>${escapeXml(base)}/reports</loc><changefreq>daily</changefreq><priority>0.8</priority></url>`,
    ...refs.map(
      (r) =>
        `<url><loc>${escapeXml(base)}/ticker/${encodeURIComponent(r.ticker)}</loc>` +
        `<lastmod>${escapeXml(r.generatedAt.slice(0, 10))}</lastmod>` +
        `<changefreq>weekly</changefreq><priority>0.6</priority></url>`,
    ),
  ].join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>`;
}
