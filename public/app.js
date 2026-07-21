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
const NS = "http://www.w3.org/2000/svg";

function priceChart(bars) {
  const N = Math.min(bars.length, 180);
  const b = bars.slice(-N);
  if (b.length < 2) return `<div class="empty">No price history available.</div>`;
  const closes = b.map((x) => x.c);
  const vols = b.map((x) => x.v || 0);
  const s20 = sma(closes, 20), s50 = sma(closes, 50);
  const W = 720, H = 250, PH = 190, VH = 44, VY = H - VH;
  const lo = Math.min(...closes), hi = Math.max(...closes);
  const pad = (hi - lo) * 0.08 || 1;
  const yMin = lo - pad, yMax = hi + pad;
  const x = (i) => (i / (b.length - 1)) * (W - 12) + 6;
  const y = (v) => 8 + (1 - (v - yMin) / (yMax - yMin)) * (PH - 8);
  const line = (arr) => arr.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(" ");
  const areaPts = closes.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const vMax = Math.max(...vols, 1);
  const vbars = vols.map((v, i) => {
    const bw = Math.max(1, (W - 12) / b.length - 1);
    const h = (v / vMax) * VH;
    const up = i === 0 || closes[i] >= closes[i - 1];
    return `<rect x="${(x(i) - bw / 2).toFixed(1)}" y="${(VY + (VH - h)).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? "rgba(53,208,127,.5)" : "rgba(255,107,107,.5)"}"/>`;
  }).join("");
  const gy = [yMax, (yMax + yMin) / 2, yMin].map(
    (v) => `<line x1="0" x2="${W}" y1="${y(v).toFixed(1)}" y2="${y(v).toFixed(1)}" stroke="#1e2838" stroke-width="1"/><text x="4" y="${(y(v) - 3).toFixed(1)}" fill="#8a97a8" font-size="10" font-family="monospace">$${v.toFixed(2)}</text>`,
  ).join("");
  const dates = [0, Math.floor(b.length / 2), b.length - 1].map(
    (i) => `<text x="${x(i).toFixed(1)}" y="${H - 4}" fill="#8a97a8" font-size="10" font-family="monospace" text-anchor="${i === 0 ? "start" : i === b.length - 1 ? "end" : "middle"}">${b[i].t}</text>`,
  ).join("");
  return `
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="price chart">
      <defs><linearGradient id="pa" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#38e0b0" stop-opacity=".35"/><stop offset="1" stop-color="#38e0b0" stop-opacity="0"/>
      </linearGradient></defs>
      ${gy}
      <polygon points="${areaPts} ${x(b.length - 1).toFixed(1)},${PH} ${x(0).toFixed(1)},${PH}" fill="url(#pa)"/>
      <polyline points="${line(closes)}" fill="none" stroke="#38e0b0" stroke-width="2"/>
      <polyline points="${line(s20)}" fill="none" stroke="#4c8dff" stroke-width="1.4" stroke-opacity=".9"/>
      <polyline points="${line(s50)}" fill="none" stroke="#ffb454" stroke-width="1.4" stroke-opacity=".9"/>
      ${vbars}${dates}
    </svg>
    <div class="legend"><span><i style="background:#38e0b0"></i>Close</span><span><i style="background:#4c8dff"></i>SMA20</span><span><i style="background:#ffb454"></i>SMA50</span><span><i style="background:rgba(53,208,127,.5)"></i>Volume</span></div>`;
}

function rsiChart(bars) {
  const N = Math.min(bars.length, 180);
  const closes = bars.slice(-N).map((x) => x.c);
  const r = rsiSeries(closes);
  const W = 720, H = 70;
  const x = (i) => (i / (closes.length - 1)) * (W - 12) + 6;
  const y = (v) => 6 + (1 - v / 100) * (H - 12);
  const pts = r.map((v, i) => (v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`)).filter(Boolean).join(" ");
  const g = (lvl) => `<line x1="0" x2="${W}" y1="${y(lvl)}" y2="${y(lvl)}" stroke="#1e2838" stroke-dasharray="4 4"/><text x="4" y="${(y(lvl) - 2).toFixed(1)}" fill="#8a97a8" font-size="9" font-family="monospace">${lvl}</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="RSI">${g(70)}${g(30)}<polyline points="${pts}" fill="none" stroke="#c48dff" stroke-width="1.6"/></svg><div class="legend"><span><i style="background:#c48dff"></i>RSI(14)</span></div>`;
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

    <div class="chartbox">${priceChart(d.bars || [])}</div>
    <div class="chartbox">${rsiChart(d.bars || [])}</div>

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
