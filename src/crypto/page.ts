/**
 * Server-rendered crypto pages: `/crypto/<PAIR>`.
 *
 * Same reasoning as the stock report pages, and the same chrome — a URL that
 * renders without running JavaScript is what makes a link shareable into a
 * chat, an email, or a search index. The interactive candlestick view is a
 * progressive enhancement, not the only way to see the data.
 *
 * One deliberate difference from the stock page: a stock report is a *stored
 * snapshot* and says when it was taken. Crypto trades 24/7 and is rendered
 * live on each request, so this page states the fetch time instead. Neither
 * page ever shows a stale price wearing the costume of a live one.
 */
import { CRYPTO_DISCLAIMER } from "../compliance.ts";
import { escapeHtml, escapeXml } from "../util/html.ts";
import { absoluteTime, num, score, shell, sparkline } from "../reports/page.ts";
import type { CryptoAnalysis } from "./analysis.ts";
import type { CryptoOrderbook, CryptoSnapshot } from "./client.ts";
import type { CryptoPerformance } from "./performance.ts";
import type { CryptoPair } from "./pairs.ts";
import type { MarketBar, TechnicalIndicatorSet, TechnicalScore } from "../types.ts";

const e = escapeHtml;

/**
 * Crypto spans $0.00001 to $60,000; the equity formatter's 2dp renders the
 * bottom of that range as "$0.00". Precision scales with magnitude instead.
 */
export function cryptoMoney(n: unknown): string {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
}

const kv = (k: string, v: string, cls = "") =>
  `<div class="rp-kv"><dt>${e(k)}</dt><dd class="${cls}">${v}</dd></div>`;

const chips = (items: string[], cls: string, mark: string): string =>
  !items.length
    ? ""
    : `<ul class="rp-chips">${items.slice(0, 8).map((x) => `<li class="rp-chip ${cls}">${mark} ${e(x)}</li>`).join("")}</ul>`;

export interface CryptoPageData {
  pair: CryptoPair;
  snapshot?: CryptoSnapshot;
  bars: MarketBar[];
  technical?: TechnicalIndicatorSet;
  technicalScore?: TechnicalScore;
  analysis: CryptoAnalysis | null;
  performance?: CryptoPerformance;
  /** Top of book, when the upstream returned one. */
  orderbook?: CryptoOrderbook;
  caveats: readonly string[];
  fetchedAt: string;
  /** Set when market data could not be reached, so the page can say so. */
  marketError?: string;
}

export interface CryptoPageOptions {
  appUrl: string;
  now?: Date;
}

const signed = (n: number, dp = 2) => `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`;

/** Multi-period performance — what the pair has been doing, not just its spread. */
function performanceSection(p: CryptoPerformance | undefined, quote: string): string {
  if (!p) return "";
  const cells = p.changes
    .map((c) =>
      kv(
        c.label,
        c.percent == null ? "—" : signed(c.percent),
        c.percent == null ? "" : c.percent >= 0 ? "pos" : "neg",
      ),
    )
    .join("");
  const thin = p.changes.some((c) => c.percent == null);
  return `<section class="rp-section">
    <h2>Performance</h2>
    <dl class="rp-grid">${cells}</dl>
    <dl class="rp-grid">
      ${kv("52-week high", `${cryptoMoney(p.high52)}${p.high52At ? ` <span class="rp-when">${e(p.high52At)}</span>` : ""}`)}
      ${kv("52-week low", `${cryptoMoney(p.low52)}${p.low52At ? ` <span class="rp-when">${e(p.low52At)}</span>` : ""}`)}
      ${kv(`Session volume (${e(quote)})`, p.volumeQuote == null ? "—" : cryptoMoney(p.volumeQuote))}
      ${kv("Daily bars", String(p.barCount))}
    </dl>
    ${thin ? `<p class="rp-note">A period showing “—” has less history than it needs. Measuring it from the oldest bar available would report a change over a window that does not exist.</p>` : ""}
    <p class="rp-note">Market capitalisation, circulating supply and all-time high are not shown: Alpaca's market-data API does not carry them, and deriving them would mean inventing a supply figure or mixing in a second vendor.</p>
  </section>`;
}

/** Top of book, the one thing the old in-app modal had that the page did not. */
function orderbookSection(ob: CryptoOrderbook | undefined): string {
  if (!ob || (!ob.bids?.length && !ob.asks?.length)) return "";
  const side = (levels: Array<{ price: number; size: number }>, cls: string) =>
    levels.slice(0, 8)
      .map((l) => `<div class="ob-row ${cls}"><span class="ob-p">${cryptoMoney(l.price)}</span><span class="ob-s">${num(l.size, 4)}</span></div>`)
      .join("");
  return `<section class="rp-section">
    <h2>Order book</h2>
    <div class="obgrid">
      <div><div class="ob-head">Bids</div>${side(ob.bids ?? [], "bid")}</div>
      <div><div class="ob-head">Asks</div>${side(ob.asks ?? [], "ask")}</div>
    </div>
    <p class="rp-note">Top of book as of ${e(String(ob.timestamp ?? "").slice(11, 19))} UTC. A book moves continuously — this one is as of page load, not live.</p>
  </section>`;
}

function analysisSection(a: CryptoAnalysis | null): string {
  if (!a) {
    // An empty Analysis heading reads as a broken feature; saying why it is
    // absent is the honest version and costs one sentence.
    return `<section class="rp-section">
      <h2>Analysis</h2>
      <p class="rp-note">Not enough price history to compute indicators for this pair yet, so there is nothing to analyze. Nothing is inferred in the meantime.</p>
    </section>`;
  }
  return `<section class="rp-section">
    <h2>Analysis <span class="rp-badge conservative">deterministic · technical only</span></h2>
    <p class="rp-thesis">${e(a.thesis)}</p>
    <dl class="rp-grid">
      ${kv("Technical score", a.technicalScore != null ? score(a.technicalScore) : "—")}
      ${kv("Indicators read", a.basedOn.length ? e(a.basedOn.join(", ")) : "—")}
    </dl>
    ${a.supportSummary.length ? `<h3>Constructive</h3>${chips(a.supportSummary, "pos", "▲")}` : ""}
    ${a.riskSummary.length ? `<h3>Cautionary</h3>${chips(a.riskSummary, "neg", "▼")}` : ""}
    <h3>What this cannot see</h3>
    <ul class="rp-gaps">${a.missingData.map((x) => `<li>${e(x)}</li>`).join("")}</ul>
  </section>`;
}

export function renderCryptoPage(data: CryptoPageData, opts: CryptoPageOptions): string {
  const { pair, snapshot: s, technical: t, analysis } = data;
  const base = opts.appUrl.replace(/\/$/, "");
  const canonical = `${base}/crypto/${pair.slug}`;

  const price = s?.latestTrade?.price ?? s?.dailyBar?.close ?? data.bars.at(-1)?.close ?? null;
  const prev = s?.prevDailyBar?.close ?? null;
  const changePct = price != null && prev ? ((price - prev) / prev) * 100 : null;
  const q = s?.latestQuote;
  const mid = q ? (q.askPrice + q.bidPrice) / 2 : null;
  const spreadBps = q && mid ? ((q.askPrice - q.bidPrice) / mid) * 10_000 : null;

  // The sparkline speaks the {t,c} shape the stock page already uses.
  const sparkBars = data.bars.map((b) => ({ t: String(b.timestamp).slice(0, 10), c: b.close }));

  const description = analysis
    ? `${pair.symbol} — ${analysis.thesis.slice(0, 180)}`
    : `Live ${pair.name} (${pair.symbol}) price, technical indicators and order book from Alpaca's US crypto venue.`;

  const body = `
<article class="rp-report">
  <header class="rp-head">
    <div class="rp-id">
      <h1>${e(pair.symbol)}</h1>
      <span class="rp-badge conservative">crypto</span>
      <p class="rp-company">${e(pair.name)} · Alpaca US crypto venue</p>
    </div>
    <div class="rp-price">
      <div class="rp-last">${cryptoMoney(price)}</div>
      <div class="rp-sub">
        ${changePct != null ? `<span class="${changePct >= 0 ? "pos" : "neg"}">${changePct >= 0 ? "+" : ""}${changePct.toFixed(2)}%</span> · ` : ""}
        live · trades 24/7
      </div>
    </div>
  </header>

  <p class="rp-stamp">
    Fetched <strong>${e(absoluteTime(data.fetchedAt))}</strong>.
    Rendered live on request — crypto has no market close, so there is no daily
    snapshot to store.
    <a class="rp-open" href="/#crypto">Back to the crypto grid ↗</a>
  </p>

  ${data.marketError ? `<p class="rp-note">Market data was unavailable for part of this page (${e(data.marketError)}).</p>` : ""}

  ${sparkline(sparkBars as any, { format: cryptoMoney })}

  <section class="rp-section">
    <h2>Market</h2>
    <dl class="rp-grid">
      ${kv("Last trade", cryptoMoney(s?.latestTrade?.price))}
      ${kv("Bid", cryptoMoney(q?.bidPrice))}
      ${kv("Ask", cryptoMoney(q?.askPrice))}
      ${kv("Mid", cryptoMoney(mid))}
      ${kv("Spread", spreadBps != null ? `${spreadBps.toFixed(1)} bps` : "—")}
      ${kv("Day high", cryptoMoney(s?.dailyBar?.high))}
      ${kv("Day low", cryptoMoney(s?.dailyBar?.low))}
      ${kv("Previous close", cryptoMoney(prev))}
      ${kv("Venue volume", num(s?.dailyBar?.volume, 4))}
    </dl>
  </section>

  ${performanceSection(data.performance, pair.quote)}

  ${analysisSection(analysis)}

  ${orderbookSection(data.orderbook)}

  <section class="rp-section">
    <h2>Technical</h2>
    <dl class="rp-grid">
      ${kv("Trend", e(t?.trend ?? "—"), t?.trend === "bullish" ? "pos" : t?.trend === "bearish" ? "neg" : "")}
      ${kv("Technical score", data.technicalScore?.score != null ? score(data.technicalScore.score) : "—")}
      ${kv("RSI(14)", num(t?.rsi14, 1))}
      ${kv("SMA 20/50/200", `${num(t?.sma?.[20])} / ${num(t?.sma?.[50])} / ${num(t?.sma?.[200])}`)}
      ${kv("MACD", num(t?.macd?.macd, 3))}
      ${kv("ATR(14)", num(t?.atr14, 3))}
      ${kv("Momentum 20/60/120d", `${num(t?.momentum?.[20], 1)}% / ${num(t?.momentum?.[60], 1)}% / ${num(t?.momentum?.[120], 1)}%`)}
      ${kv("From 52w high", t?.distanceFrom52WeekHigh != null ? `${num(t.distanceFrom52WeekHigh, 1)}%` : "—")}
      ${kv("Golden cross", t?.goldenCross ? "yes" : "no", t?.goldenCross ? "pos" : "")}
      ${kv("Volatility", e(t?.volatilityRegime ?? "—"))}
    </dl>
    ${data.caveats.length ? `<h3>How to read these</h3><ul class="rp-gaps">${data.caveats.map((c) => `<li>${e(c)}</li>`).join("")}</ul>` : ""}
  </section>

  <p class="rp-note">
    Prices from Alpaca's US crypto venue. Indicators computed locally from daily
    bars — no model produces a number on this page. JSON for this pair:
    <a href="/api/crypto/${e(pair.slug)}">/api/crypto/${e(pair.slug)}</a>.
  </p>
  <p class="rp-disclaimer">${e(CRYPTO_DISCLAIMER.replace(/\s+/g, " "))}</p>
</article>`;

  return shell(
    {
      title: `${pair.symbol} — ${pair.name} price & technicals | advis0r.com`,
      description,
      canonical,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "FinancialProduct",
        name: `${pair.name} (${pair.symbol})`,
        category: "Cryptocurrency",
        url: canonical,
      },
    },
    body,
  );
}

/**
 * `/crypto` — every supported pair, linked. Prices are best-effort: the page
 * is useful as a directory even when the upstream is down, so a missing price
 * renders as a dash rather than failing the request.
 */
export function renderCryptoIndexPage(
  pairs: CryptoPair[],
  prices: Map<string, { price: number; changePct: number | null }>,
  opts: CryptoPageOptions,
): string {
  const base = opts.appUrl.replace(/\/$/, "");
  const byQuote = new Map<string, CryptoPair[]>();
  for (const p of pairs) {
    (byQuote.get(p.quote) ?? byQuote.set(p.quote, []).get(p.quote)!).push(p);
  }

  const row = (p: CryptoPair) => {
    const q = prices.get(p.symbol);
    const chg = q?.changePct;
    return `<li class="rp-row">
      <a class="rp-row-tick" href="/crypto/${e(p.slug)}">${e(p.symbol)}</a>
      <span class="rp-row-name">${e(p.name)}</span>
      <span class="rp-row-score">${q ? cryptoMoney(q.price) : "—"}</span>
      <span class="rp-row-when ${chg == null ? "" : chg >= 0 ? "pos" : "neg"}">${
        chg == null ? "" : `${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%`
      }</span>
    </li>`;
  };

  const sections = [...byQuote.entries()]
    .sort(([a], [b]) => (a === "USD" ? -1 : b === "USD" ? 1 : a.localeCompare(b)))
    .map(
      ([quote, list]) =>
        `<section class="rp-section"><h2>Quoted in ${e(quote)} <span class="rp-count">${list.length}</span></h2>
         <ul class="rp-list">${list.map(row).join("")}</ul></section>`,
    )
    .join("");

  const body = `<article class="rp-report">
    <header class="rp-head">
      <div class="rp-id">
        <h1>Crypto</h1>
        <p class="rp-company">${pairs.length} pairs · Alpaca US crypto venue · trades 24/7</p>
      </div>
    </header>
    <p class="rp-stamp">
      Every pair links to a live page with price, technicals and analysis.
      <a class="rp-open" href="/#crypto">Open the interactive grid ↗</a>
    </p>
    ${sections}
    <p class="rp-note">JSON for this directory: <a href="/api/crypto/assets">/api/crypto/assets</a>.</p>
    <p class="rp-disclaimer">${e(CRYPTO_DISCLAIMER.replace(/\s+/g, " "))}</p>
  </article>`;

  return shell(
    {
      title: "Crypto prices & technicals | advis0r.com",
      description: `Live prices, technical indicators and analysis for ${pairs.length} crypto pairs.`,
      canonical: `${base}/crypto`,
    },
    body,
  );
}

/** Shown when the pair is not one Alpaca serves. */
export function renderMissingCryptoPage(
  raw: string,
  suggestion: CryptoPair | undefined,
  opts: CryptoPageOptions,
): string {
  const base = opts.appUrl.replace(/\/$/, "");
  const body = `<article class="rp-report rp-missing">
    <h1>${e(raw)}</h1>
    <p class="rp-company">Not a crypto pair advis0r covers.</p>
    ${suggestion ? `<p class="rp-thesis">Did you mean <a href="/crypto/${e(suggestion.slug)}">${e(suggestion.symbol)}</a> (${e(suggestion.name)})?</p>` : ""}
    <p><a class="rp-open" href="/api/crypto/assets">See every supported pair</a> · <a class="rp-open" href="/#crypto">Browse the crypto tab</a></p>
  </article>`;
  return shell(
    {
      title: `${raw} — not a supported crypto pair | advis0r.com`,
      description: `advis0r.com does not cover ${raw}.`,
      canonical: `${base}/crypto/${encodeURIComponent(raw)}`,
      robots: "noindex",
    },
    body,
  );
}

/** Sitemap entries for every supported pair, so the pages are discoverable. */
export function cryptoSitemapEntries(pairs: CryptoPair[], appUrl: string): string {
  const base = appUrl.replace(/\/$/, "");
  return pairs
    .map(
      (p) =>
        `<url><loc>${escapeXml(base)}/crypto/${escapeXml(p.slug)}</loc>` +
        `<changefreq>hourly</changefreq><priority>0.6</priority></url>`,
    )
    .join("");
}
