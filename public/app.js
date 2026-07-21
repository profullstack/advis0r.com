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
        <span class="tkr">${esc(c.ticker)}</span>
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
      ? r.map((x) => `<div class="res"><div class="meta"><span class="t">${esc(x.ticker || "?")}</span><span>${esc(x.event_date || "")}</span><span>${esc(x.speaker || "")}</span></div><div class="txt">${esc((x.text || "").slice(0, 320))}…</div></div>`).join("")
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
      ? s.map((x) => `<div class="res"><div class="meta"><span class="t">${esc(x.ticker)}</span><span>${esc(x.event_date || "")}</span><span class="sig-dir ${esc(x.direction)}">${esc(x.signal_type)} · ${esc(x.direction)}</span><span>str ${Number(x.strength).toFixed(2)}</span></div><div class="txt">${esc((x.quote || "").slice(0, 300))}</div>${x.source_url ? `<div class="meta"><a href="${esc(x.source_url)}" target="_blank" rel="noopener">source ↗</a></div>` : ""}</div>`).join("")
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

/* ---- PWA service worker ---- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
