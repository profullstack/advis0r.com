"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path) {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

/* ---- Tab routing ---- */
function showView(name) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  location.hash = name;
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) showView(b.dataset.view);
});

/* ---- Health + about stats ---- */
async function loadHealthAndStats() {
  const dot = $("#statusdot");
  try {
    await api("/health");
    dot.className = "statusdot ok";
    dot.title = "online";
  } catch {
    dot.className = "statusdot bad";
    dot.title = "offline";
  }
  try {
    const s = await api("/api/stats");
    $("#about-stats").innerHTML = [
      ["documents", "Documents"],
      ["signals", "Signals"],
      ["transcripts", "Transcripts"],
      ["analyses", "Analyses"],
    ]
      .map(([k, lab]) => `<div class="stat"><b>${s[k] ?? 0}</b><span>${lab}</span></div>`)
      .join("");
  } catch {}
  try {
    const { tickers } = await api("/api/tickers");
    $("#ticker-list").innerHTML = tickers.map((t) => `<option value="${esc(t.ticker)}">`).join("");
  } catch {}
}

/* ---- Watchlist ---- */
const classClass = (c) =>
  c === "high-risk speculative" ? "high" : c === "speculative" ? "speculative" : "conservative";
const cardRisk = (c) =>
  c === "high-risk speculative" ? "risk-high" : c === "speculative" ? "risk-spec" : "";

function candidateCard(c) {
  const a = c.analysis || {};
  const cats = (a.catalystSummary || []).slice(0, 3).map((x) => `<span class="chip pos">▲ ${esc(x)}</span>`).join("");
  const risks = (a.riskSummary || []).slice(0, 3).map((x) => `<span class="chip neg">▼ ${esc(x)}</span>`).join("");
  const price = c.lastPrice != null ? `$${Number(c.lastPrice).toFixed(2)}` : "—";
  const mcap = c.marketCap != null ? fmtCap(c.marketCap) : "—";
  const ev = (a.evidenceIds || []).length;
  return `
    <article class="card ${cardRisk(c.classification)}">
      <div class="card-head">
        <span class="rank">#${c.rank}</span>
        <span class="tkr tlink" data-ticker="${esc(c.ticker)}">${esc(c.ticker)}</span>
        <span class="cname">${esc(c.companyName || "")}</span>
        <span class="spacer"></span>
        <span class="badge ${classClass(c.classification)}">${esc(c.classification)}</span>
      </div>
      <div class="scores">
        ${scoreBlock("Overall", c.overallScore)}
        ${scoreBlock("Confidence", c.confidence)}
        <div class="score"><span class="lab">Last / Mkt cap</span><span class="val">${price} · ${mcap}</span></div>
      </div>
      <p class="thesis">${esc(a.thesis || "")}</p>
      <div class="chips">${cats}${risks}</div>
      <details class="evidence">
        <summary>Evidence (${ev}) &amp; scenarios</summary>
        <div class="ev">Scenarios — bull ${pct(a.bullCase)} · base ${pct(a.baseCase)} · bear ${pct(a.bearCase)}</div>
        ${(a.missingData || []).length ? `<div class="ev">Missing data: ${esc(a.missingData.join(", "))}</div>` : ""}
        <div class="ev">AI: ${esc(c.provider)}:${esc(c.model)}</div>
      </details>
    </article>`;
}
const pct = (s) => (s && s.probability != null ? Math.round(s.probability * 100) + "%" : "—");
function scoreBlock(lab, v) {
  const n = Math.round(Number(v) || 0);
  return `<div class="score"><span class="lab">${lab}</span><span class="val">${n}/100</span><div class="bar"><i style="width:${n}%"></i></div></div>`;
}
function fmtCap(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}M`;
  return `$${n.toFixed(0)}`;
}

async function runWatchlist() {
  const topic = $("#wl-topic").value.trim();
  const horizon = $("#wl-horizon").value;
  const btn = $("#wl-run");
  const list = $("#wl-list");
  btn.disabled = true;
  list.innerHTML = `<div class="spinner"></div>`;
  $("#wl-summary").textContent = "";
  try {
    const qs = new URLSearchParams({ horizon, limit: "12" });
    if (topic) qs.set("topic", topic);
    const data = await api(`/api/discover?${qs}`);
    const cs = data.candidates || [];
    $("#wl-summary").textContent = `topic: ${data.topic || "(whole index)"} · ${cs.length} candidates · ${data.provider} analyzer · ${data.horizonQuarters}Q horizon`;
    list.innerHTML = cs.length ? cs.map(candidateCard).join("") : `<div class="empty">No candidates. Index some transcripts first (CLI: <code>transcripts sync "&lt;topic&gt;"</code>).</div>`;
  } catch (e) {
    list.innerHTML = `<div class="empty">Failed to load watchlist (${esc(e.message)}).</div>`;
  } finally {
    btn.disabled = false;
  }
}
$("#wl-run").addEventListener("click", runWatchlist);
$("#wl-topic").addEventListener("keydown", (e) => e.key === "Enter" && runWatchlist());

/* ---- Search ---- */
async function runSearch() {
  const q = $("#sq").value.trim();
  const out = $("#search-results");
  if (!q) return;
  out.innerHTML = `<div class="spinner"></div>`;
  try {
    const data = await api(`/api/search?q=${encodeURIComponent(q)}&limit=30`);
    const r = data.results || [];
    out.innerHTML = r.length
      ? r.map((x) => `<div class="res"><div class="meta"><span class="t tlink" data-ticker="${esc(x.ticker || "")}">${esc(x.ticker || "?")}</span><span>${esc(x.event_date || "")}</span><span>${esc(x.speaker || "")}</span></div><div class="txt">${esc((x.text || "").slice(0, 320))}…</div></div>`).join("")
      : `<div class="empty">No matches for “${esc(q)}”.</div>`;
  } catch (e) {
    out.innerHTML = `<div class="empty">Search failed (${esc(e.message)}).</div>`;
  }
}
$("#sq-run").addEventListener("click", runSearch);
$("#sq").addEventListener("keydown", (e) => e.key === "Enter" && runSearch());

/* ---- Signals ---- */
async function runSignals() {
  const ticker = $("#sig-ticker").value.trim().toUpperCase();
  const out = $("#signals-out");
  if (!ticker) return;
  out.innerHTML = `<div class="spinner"></div>`;
  try {
    const data = await api(`/api/signals?ticker=${encodeURIComponent(ticker)}`);
    const s = data.signals || [];
    out.innerHTML = s.length
      ? s.map((x) => `<div class="res"><div class="meta"><span class="t tlink" data-ticker="${esc(x.ticker)}">${esc(x.ticker)}</span><span>${esc(x.event_date || "")}</span><span class="sig-dir ${esc(x.direction)}">${esc(x.signal_type)} · ${esc(x.direction)}</span><span>str ${Number(x.strength).toFixed(2)}</span></div><div class="txt">${esc((x.quote || "").slice(0, 300))}</div>${x.source_url ? `<div class="meta"><a href="${esc(x.source_url)}" target="_blank" rel="noopener">source ↗</a></div>` : ""}</div>`).join("")
      : `<div class="empty">No signals for ${esc(ticker)}.</div>`;
  } catch (e) {
    out.innerHTML = `<div class="empty">Failed (${esc(e.message)}).</div>`;
  }
}
$("#sig-run").addEventListener("click", runSignals);
$("#sig-ticker").addEventListener("keydown", (e) => e.key === "Enter" && runSignals());

/* ---- Boot ---- */
async function boot() {
  await loadHealthAndStats();
  const disc = "This output is generated from public information and automated analysis. It is a research aid, not a guarantee, personalized recommendation, or substitute for professional financial advice. Small-cap and low-priced stocks may be highly volatile, illiquid, subject to dilution, manipulation, delisting, and total loss.";
  $("#disclaimer").textContent = disc;
  const start = (location.hash || "#watchlist").slice(1);
  showView(["watchlist", "search", "signals", "about"].includes(start) ? start : "watchlist");
  runWatchlist();
}
boot();

/* ---- Ticker detail + charts ---- */
function sma(vals, period) {
  const out = new Array(vals.length).fill(null);
  let sum = 0;
  for (let i = 0; i < vals.length; i++) {
    sum += vals[i];
    if (i >= period) sum -= vals[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function rsiSeries(vals, period = 14) {
  const out = new Array(vals.length).fill(null);
  if (vals.length <= period) return out;
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = vals[i] - vals[i - 1]; d >= 0 ? (g += d) : (l -= d); }
  let ag = g / period, al = l / period;
  out[period] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  for (let i = period + 1; i < vals.length; i++) {
    const d = vals[i] - vals[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = al === 0 ? 100 : 100 - 100 / (1 + ag / al);
  }
  return out;
}
function emaSeries(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (vals.length < period) return out;
  const k = 2 / (period + 1);
  let prev = vals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < vals.length; i++) { prev = vals[i] * k + prev * (1 - k); out[i] = prev; }
  return out;
}
function bollinger(vals, period = 20, mult = 2) {
  const upper = new Array(vals.length).fill(null), mid = new Array(vals.length).fill(null), lower = new Array(vals.length).fill(null);
  for (let i = period - 1; i < vals.length; i++) {
    const slice = vals.slice(i - period + 1, i + 1);
    const m = slice.reduce((a, b) => a + b, 0) / period;
    const sd = Math.sqrt(slice.reduce((a, b) => a + (b - m) ** 2, 0) / period);
    mid[i] = m; upper[i] = m + mult * sd; lower[i] = m - mult * sd;
  }
  return { upper, mid, lower };
}
function macdSeries(vals, fast = 12, slow = 26, signal = 9) {
  const ef = emaSeries(vals, fast), es = emaSeries(vals, slow);
  const macd = vals.map((_, i) => (ef[i] == null || es[i] == null ? null : ef[i] - es[i]));
  const idx = [], line = [];
  macd.forEach((v, i) => { if (v != null) { idx.push(i); line.push(v); } });
  const sigVals = emaSeries(line, signal);
  const sig = new Array(vals.length).fill(null);
  idx.forEach((origI, j) => { if (sigVals[j] != null) sig[origI] = sigVals[j]; });
  const hist = vals.map((_, i) => (macd[i] == null || sig[i] == null ? null : macd[i] - sig[i]));
  return { macd, signal: sig, hist };
}
/* Professional candlestick + volume + SMA charts via TradingView
   lightweight-charts (same library b1dz uses). */
const LWC = window.LightweightCharts;
let liveCharts = [];
function destroyCharts() {
  for (const c of liveCharts) { try { c.remove(); } catch {} }
  liveCharts = [];
}
const chartColors = {
  text: "#8a97a8", grid: "rgba(63,63,70,0.28)", border: "rgba(82,82,91,0.55)",
};
function baseChart(el, height) {
  const chart = LWC.createChart(el, {
    height,
    width: el.clientWidth || 700,
    layout: { background: { type: LWC.ColorType.Solid, color: "transparent" }, textColor: chartColors.text, fontFamily: "ui-monospace, monospace" },
    grid: { vertLines: { color: chartColors.grid }, horzLines: { color: chartColors.grid } },
    rightPriceScale: { borderColor: chartColors.border },
    timeScale: { borderColor: chartColors.border, timeVisible: false, secondsVisible: false },
    crosshair: { mode: LWC.CrosshairMode ? LWC.CrosshairMode.Normal : 0 },
    handleScale: true, handleScroll: true,
  });
  liveCharts.push(chart);
  const ro = new ResizeObserver(() => { try { chart.applyOptions({ width: el.clientWidth }); } catch {} });
  ro.observe(el);
  return chart;
}

function mountPriceChart(bars) {
  const el = document.getElementById("lwc-price");
  if (!el || !LWC) return;
  if (bars.length < 2) { el.outerHTML = `<div class="chart-empty">No price history available.</div>`; return; }
  const candles = bars.map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c }));
  const closes = bars.map((b) => b.c);
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const chart = baseChart(el, 320);

  const candleSeries = chart.addSeries(LWC.CandlestickSeries, {
    upColor: "#22c55e", downColor: "#ef4444", borderVisible: false,
    wickUpColor: "#86efac", wickDownColor: "#fca5a5",
  });
  candleSeries.setData(candles);

  const volSeries = chart.addSeries(LWC.HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" } });
  volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
  volSeries.setData(bars.map((b) => ({ time: b.t, value: b.v || 0, color: b.c >= b.o ? "rgba(34,197,94,0.45)" : "rgba(248,113,113,0.45)" })));

  const overlay = (arr, opts) => {
    const series = chart.addSeries(LWC.LineSeries, { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false, ...opts });
    series.setData(bars.map((b, i) => (arr[i] == null ? null : { time: b.t, value: arr[i] })).filter(Boolean));
  };

  // Bollinger Bands (20, 2): translucent upper/lower rails (middle = SMA20).
  const bb = bollinger(closes, 20, 2);
  overlay(bb.upper, { color: "rgba(150,160,190,0.85)", lineWidth: 1 });
  overlay(bb.lower, { color: "rgba(150,160,190,0.85)", lineWidth: 1 });

  overlay(s20, { color: "#4c8dff" });
  overlay(s50, { color: "#ffb454" });

  chart.timeScale().fitContent();
}

function mountMacdChart(bars) {
  const el = document.getElementById("lwc-macd");
  if (!el || !LWC || bars.length < 35) { if (el) el.outerHTML = ""; return; }
  const closes = bars.map((b) => b.c);
  const { macd, signal, hist } = macdSeries(closes, 12, 26, 9);
  const chart = baseChart(el, 150);

  // Histogram first (drawn under the lines), green/red by sign.
  const histSeries = chart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false });
  histSeries.setData(bars.map((b, i) => (hist[i] == null ? null : { time: b.t, value: hist[i], color: hist[i] >= 0 ? "rgba(34,197,94,0.55)" : "rgba(248,113,113,0.55)" })).filter(Boolean));

  const macdLine = chart.addSeries(LWC.LineSeries, { color: "#4c8dff", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
  macdLine.setData(bars.map((b, i) => (macd[i] == null ? null : { time: b.t, value: macd[i] })).filter(Boolean));

  const sigLine = chart.addSeries(LWC.LineSeries, { color: "#ffb454", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  sigLine.setData(bars.map((b, i) => (signal[i] == null ? null : { time: b.t, value: signal[i] })).filter(Boolean));

  chart.timeScale().fitContent();
}

function mountRsiChart(bars) {
  const el = document.getElementById("lwc-rsi");
  if (!el || !LWC || bars.length < 15) { if (el) el.outerHTML = ""; return; }
  const closes = bars.map((b) => b.c);
  const r = rsiSeries(closes);
  const chart = baseChart(el, 130);
  chart.applyOptions({ rightPriceScale: { borderColor: chartColors.border, autoScale: false, scaleMargins: { top: 0.1, bottom: 0.1 } } });
  const line = chart.addSeries(LWC.LineSeries, { color: "#c48dff", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
  line.setData(bars.map((b, i) => (r[i] == null ? null : { time: b.t, value: r[i] })).filter(Boolean));
  line.createPriceLine({ price: 70, color: "rgba(248,113,113,.5)", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "70" });
  line.createPriceLine({ price: 30, color: "rgba(34,197,94,.5)", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "30" });
  chart.timeScale().fitContent();
}

function mountCharts(bars) {
  destroyCharts();
  // Defer to next frame so the modal has laid out and containers have width.
  requestAnimationFrame(() => { mountPriceChart(bars); mountRsiChart(bars); mountMacdChart(bars); });
}

const fmtNum = (n, d = 2) => (n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const fmtBig = (n) => (n == null ? "—" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${fmtNum(n)}`);
const kv = (k, v, cls = "") => `<div class="kv"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;

function renderDetail(d) {
  const t = d.technical || {};
  const f = d.facts || {};
  const a = d.analysis || {};
  const chg = d.bars && d.bars.length > 1 ? ((d.bars.at(-1).c - d.bars.at(-2).c) / d.bars.at(-2).c) * 100 : null;
  const clsBadge = d.classification
    ? `<span class="badge ${d.classification === "high-risk speculative" ? "high" : d.classification === "speculative" ? "speculative" : "conservative"}">${esc(d.classification)}</span>`
    : "";
  const sig = (d.signals || []).slice(0, 12).map((x) =>
    `<div class="res"><div class="meta"><span class="sig-dir ${esc(x.direction)}">${esc(x.signal_type)} · ${esc(x.direction)}</span><span>${esc(x.event_date || "")}</span><span>str ${Number(x.strength).toFixed(2)}</span></div><div class="txt">${esc((x.quote || "").slice(0, 240))}</div></div>`).join("");

  $("#detail-panel").innerHTML = `
    <button class="close-x" data-close aria-label="Close">×</button>
    <div class="dl-head">
      <div>
        <span class="tkr">${esc(d.ticker)}</span> ${clsBadge}
        <div class="cname">${esc(d.companyName || "")}${d.exchange ? " · " + esc(d.exchange) : ""}</div>
      </div>
      <div class="dl-price">
        <div class="p">${d.lastPrice != null ? "$" + Number(d.lastPrice).toFixed(2) : "—"}</div>
        <div class="sub">${chg != null ? `<span class="${chg >= 0 ? "sig-dir positive" : "sig-dir negative"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span> · ` : ""}${d.delayed ? "delayed" : "live"} · ${esc(d.marketSource)}</div>
      </div>
    </div>

    <div class="chartbox">
      <div id="lwc-price" class="lwchart"></div>
      <div class="legend"><span><i style="background:#22c55e"></i>Candles</span><span><i style="background:#4c8dff"></i>SMA20</span><span><i style="background:#ffb454"></i>SMA50</span><span><i style="background:rgba(150,160,190,.8)"></i>Bollinger 20/2</span><span><i style="background:rgba(120,120,140,.5)"></i>Volume</span></div>
    </div>
    <div class="chartbox">
      <div id="lwc-rsi" class="lwchart rsi"></div>
      <div class="legend"><span><i style="background:#c48dff"></i>RSI(14)</span><span>oversold 30 · overbought 70</span></div>
    </div>
    <div class="chartbox">
      <div id="lwc-macd" class="lwchart macd"></div>
      <div class="legend"><span><i style="background:#4c8dff"></i>MACD</span><span><i style="background:#ffb454"></i>Signal</span><span><i style="background:rgba(120,120,140,.6)"></i>Histogram</span><span>12 / 26 / 9</span></div>
    </div>

    <div class="dl-section"><h3>Technical</h3>
      <div class="grid2">
        ${kv("Trend", esc(t.trend || "—"), t.trend === "bullish" ? "pos" : t.trend === "bearish" ? "neg" : "")}
        ${kv("Tech score", (d.technicalScore && d.technicalScore.score != null ? d.technicalScore.score + "/100" : "—"))}
        ${kv("RSI(14)", fmtNum(t.rsi14, 1))}
        ${kv("SMA 20/50/200", `${fmtNum(t.sma?.[20])} / ${fmtNum(t.sma?.[50])} / ${fmtNum(t.sma?.[200])}`)}
        ${kv("MACD", fmtNum(t.macd?.macd, 3))}
        ${kv("ATR(14)", fmtNum(t.atr14, 3))}
        ${kv("Rel volume", fmtNum(t.relativeVolume))}
        ${kv("Avg $ vol", fmtBig(t.avgDollarVolume))}
        ${kv("Mom 20/60/120d", `${fmtNum(t.momentum?.[20], 1)}% / ${fmtNum(t.momentum?.[60], 1)}% / ${fmtNum(t.momentum?.[120], 1)}%`)}
        ${kv("From 52w high", t.distanceFrom52WeekHigh != null ? fmtNum(t.distanceFrom52WeekHigh, 1) + "%" : "—")}
        ${kv("Golden cross", t.goldenCross ? "yes" : "no", t.goldenCross ? "pos" : "")}
        ${kv("Volatility", esc(t.volatilityRegime || "—"))}
      </div>
    </div>

    <div class="dl-section"><h3>Fundamentals (SEC)</h3>
      <div class="grid2">
        ${kv("Market cap", fmtBig(f.marketCap))}
        ${kv("Shares out", fmtNum(f.sharesOutstanding, 0))}
        ${kv("Public float", fmtNum(f.publicFloat, 0))}
        ${kv("Revenue", fmtBig(f.revenue))}
        ${kv("Rev growth", f.revenueGrowth != null ? fmtNum(f.revenueGrowth, 1) + "%" : "—", f.revenueGrowth >= 0 ? "pos" : "neg")}
        ${kv("Cash", fmtBig(f.cashBalance))}
        ${kv("Debt", fmtBig(f.totalDebt))}
        ${kv("Runway", f.runwayMonths != null ? fmtNum(f.runwayMonths, 1) + " mo" : "—")}
      </div>
    </div>

    ${a.thesis ? `<div class="dl-section"><h3>Offline analysis</h3>
      <p class="thesis">${esc(a.thesis)}</p>
      <div class="grid2">${kv("Overall", (d.overallScore ?? "—") + "/100")}${kv("Confidence", (d.confidence ?? "—") + "/100")}</div>
      <div class="chips">${(a.catalystSummary || []).slice(0, 4).map((x) => `<span class="chip pos">▲ ${esc(x)}</span>`).join("")}${(a.riskSummary || []).slice(0, 4).map((x) => `<span class="chip neg">▼ ${esc(x)}</span>`).join("")}</div>
    </div>` : ""}

    ${sig ? `<div class="dl-section"><h3>Signals (${(d.signals || []).length})</h3><div class="results">${sig}</div></div>` : ""}

    <p class="src-note">Price data: ${esc(d.marketSource)} (${d.delayed ? "end-of-day, delayed" : "real-time"}). Fundamentals: SEC EDGAR. Indicators computed locally. ${d.marketError ? "Market data note: " + esc(d.marketError) : ""}</p>
    <div class="disclaimer">${esc(d.disclaimer || "")}</div>`;

  mountCharts(d.bars || []);
}

async function openTicker(sym) {
  if (!sym) return;
  const modal = $("#detail");
  modal.classList.remove("hidden");
  $("#detail-panel").innerHTML = `<button class="close-x" data-close>×</button><div class="spinner"></div><p class="empty">Loading ${esc(sym)}…</p>`;
  document.body.style.overflow = "hidden";
  try {
    const d = await api(`/api/ticker?symbol=${encodeURIComponent(sym)}`);
    renderDetail(d);
  } catch (e) {
    $("#detail-panel").innerHTML = `<button class="close-x" data-close>×</button><div class="empty">Failed to load ${esc(sym)} (${esc(e.message)}).</div>`;
  }
}
function closeDetail() {
  destroyCharts();
  $("#detail").classList.add("hidden");
  document.body.style.overflow = "";
}
document.addEventListener("click", (e) => {
  const link = e.target.closest(".tlink");
  if (link && link.dataset.ticker) { e.preventDefault(); openTicker(link.dataset.ticker); return; }
  if (e.target.closest("[data-close]")) closeDetail();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

/* ---- PWA service worker ---- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
