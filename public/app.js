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

/* ---- Tab routing ----
   Each tab is a path — /watchlist, /discover — not a fragment. A fragment is
   invisible to the server, so it cannot be linked to from an email, cannot be
   crawled, and is dropped by anything that rewrites URLs. The server already
   answers an unknown path with the app shell, so the only thing needed here is
   to keep the address bar and the history stack honest.

   Fragments still work: /#watchlist is upgraded to /watchlist on arrival, so
   older links keep landing in the right place. */
const VIEWS = ["discover", "watchlist", "search", "signals", "crypto", "about"];

/** The view a URL asks for, by path first and then by legacy fragment. */
function viewFromLocation() {
  const seg = location.pathname.replace(/^\/+|\/+$/g, "");
  if (VIEWS.includes(seg)) return seg;
  const hash = (location.hash || "").replace(/^#/, "");
  return VIEWS.includes(hash) ? hash : null;
}

function showView(name, opts = {}) {
  $$("#tabs button").forEach((b) => b.classList.toggle("active", b.dataset.view === name));
  $$(".view").forEach((v) => v.classList.toggle("active", v.dataset.view === name));
  if (opts.history !== false) {
    // The query string travels with the view: it carries the watchlist's sort,
    // filter and range, which is what makes a configured table shareable.
    const target = `/${name}${location.search}`;
    const current = location.pathname + location.search;
    try {
      if (current !== target) history[opts.replace ? "replaceState" : "pushState"]({ view: name }, "", target);
    } catch { /* a sandboxed frame cannot write history; the view still switches */ }
  }
  // Crypto prices are only fetched once the tab is actually opened — loading
  // them on boot would spend upstream calls for every visitor who never looks.
  if (name === "crypto") loadCryptoGrid();
  if (name === "watchlist") openWatchlistTab();
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (b) showView(b.dataset.view);
});
// Back and forward move between tabs instead of leaving the app.
window.addEventListener("popstate", () => {
  showView(viewFromLocation() ?? "discover", { history: false });
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
  // The signals box used to be backed by a <datalist> of indexed tickers, which
  // only ever offered symbols we already had signals for — no help at all to
  // someone typing a company name. It is a lookup box now (see attachLookup).
}

/* ---- Ticker lookup ----
   Typing a company name used to be a dead end: the watchlist rejected anything
   over five letters, the signals box wanted an exact symbol, and full-text
   search answered "rivian" with Amazon's 10-Q, because that filing mentions
   their stake. This turns any input into a name-or-symbol picker. */

const LOOKUP_DEBOUNCE_MS = 180;

/** Equity symbols resolve without a round trip; crypto pairs override this. */
const EQUITY_SYMBOL_RE = /^[A-Za-z]{1,5}(\.[A-Za-z]{1,2})?$/;

/**
 * `opts` lets a second search surface (crypto) reuse this widget rather than
 * grow a parallel copy: only the endpoint, the right-hand meta column and the
 * "already a symbol" shortcut differ between them.
 */
function attachLookup(input, onSelect, opts = {}) {
  const url = opts.url || ((q) => `/api/lookup?q=${encodeURIComponent(q)}&limit=8`);
  const meta = opts.meta || ((m) => `${esc(m.exchange || "")}${m.hasReport ? ' <span class="lookup-rep">report</span>' : ""}`);
  const isSymbol = opts.isSymbol || ((q) => EQUITY_SYMBOL_RE.test(q));

  const box = input.closest(".lookup");
  const results = box?.querySelector(".lookup-results");
  if (!box || !results) return;

  let items = [];
  let active = -1;
  let timer = null;
  // Monotonic token: a slow response for an earlier keystroke must never
  // overwrite a newer one's results.
  let seq = 0;

  const close = () => {
    results.hidden = true;
    results.innerHTML = "";
    items = [];
    active = -1;
    input.setAttribute("aria-expanded", "false");
  };

  const paint = () => {
    if (!items.length) { close(); return; }
    results.innerHTML = items
      .map((m, i) => `<button type="button" class="lookup-row${i === active ? " on" : ""}"
           role="option" aria-selected="${i === active}" data-i="${i}">
        <span class="lookup-sym">${esc(m.symbol)}</span>
        <span class="lookup-name">${esc(m.name)}</span>
        <span class="lookup-meta">${meta(m)}</span>
      </button>`)
      .join("");
    results.hidden = false;
    input.setAttribute("aria-expanded", "true");
  };

  const choose = (i) => {
    const m = items[i];
    if (!m) return;
    input.value = m.symbol;
    close();
    onSelect(m);
  };

  const search = async (q) => {
    const mine = ++seq;
    try {
      const r = await fetch(url(q), { credentials: "same-origin" });
      const data = await r.json();
      if (mine !== seq) return; // a newer keystroke already won
      items = data.matches || [];
      active = items.length ? 0 : -1;
      paint();
    } catch {
      if (mine === seq) close();
    }
  };

  input.addEventListener("input", () => {
    const q = input.value.trim();
    clearTimeout(timer);
    if (q.length < 1) { close(); return; }
    timer = setTimeout(() => search(q), LOOKUP_DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (e) => {
    if (results.hidden || !items.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); active = (active + 1) % items.length; paint(); }
    else if (e.key === "ArrowUp") { e.preventDefault(); active = (active - 1 + items.length) % items.length; paint(); }
    else if (e.key === "Enter" && active >= 0) { e.preventDefault(); e.stopPropagation(); choose(active); }
    else if (e.key === "Escape") { close(); }
  });

  results.addEventListener("mousedown", (e) => {
    // mousedown, not click: blur fires first and would close the list.
    const row = e.target.closest("[data-i]");
    if (row) { e.preventDefault(); choose(Number(row.dataset.i)); }
  });

  input.addEventListener("blur", () => setTimeout(close, 120));

  /** Resolve free text to one symbol for a submit that skipped the dropdown. */
  return async function resolve(raw) {
    const q = (raw ?? input.value).trim();
    if (!q) return null;
    if (isSymbol(q)) return { symbol: q.toUpperCase() };
    try {
      const r = await fetch(url(q), { credentials: "same-origin" });
      const { matches = [] } = await r.json();
      if (matches.length === 1) return matches[0];
      // Ambiguous: show the options rather than pick one. Putting the wrong
      // company on someone's watchlist is worse than one more click.
      items = matches; active = matches.length ? 0 : -1; paint();
      return null;
    } catch {
      return null;
    }
  };
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
  const isAI = c.provider && c.provider !== "offline";
  return `
    <article class="card ${cardRisk(c.classification)}" data-ticker="${esc(c.ticker)}">
      <div class="card-head">
        <span class="rank">#${c.rank}</span>
        <span class="tkr tlink" data-ticker="${esc(c.ticker)}">${esc(c.ticker)}</span>
        <span class="cname">${esc(c.companyName || "")}</span>
        <span class="spacer"></span>
        ${isAI ? `<span class="badge audio">✨ ${esc(c.model || "AI")}</span>` : ""}
        <span class="badge ${classClass(c.classification)}">${esc(c.classification)}</span>
        <button class="wl-toggle${myTickers.has(c.ticker) ? " on" : ""}" data-watch="${esc(c.ticker)}">${myTickers.has(c.ticker) ? "✓ Watching" : "+ Watchlist"}</button>
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

let lastWatchlist = [];
var myTickers = new Set();
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
    lastWatchlist = cs;
    const aiCount = cs.filter((c) => c.provider && c.provider !== "offline").length;
    $("#wl-summary").textContent = `topic: ${data.topic || "(whole index)"} · ${cs.length} candidates · ${aiCount}/${cs.length} AI-sharpened · ${data.horizonQuarters}Q horizon`;
    $("#wl-sharpen").style.display = cs.length ? "" : "none";
    $("#wl-export").style.display = cs.length ? "" : "none";
    list.innerHTML = cs.length ? cs.map(candidateCard).join("") : `<div class="empty">No candidates. Index some transcripts first (CLI: <code>transcripts sync "&lt;topic&gt;"</code>).</div>`;
  } catch (e) {
    list.innerHTML = `<div class="empty">Failed to load watchlist (${esc(e.message)}).</div>`;
  } finally {
    btn.disabled = false;
  }
}

async function sharpenAll() {
  if (!lastWatchlist.length) return;
  if (!authState.user) { openAuth("signup", {}); return; }
  if (!authState.user.emailVerified) {
    $("#wl-summary").textContent = "Verify your email to run AI analysis — check your inbox.";
    return;
  }
  const btn = $("#wl-sharpen");
  btn.disabled = true;
  const total = lastWatchlist.length;
  const tickers = lastWatchlist.map((c) => c.ticker);
  for (let i = 0; i < total; i++) {
    const t = tickers[i];
    $("#wl-summary").textContent = `Sharpening ${i + 1}/${total} with AI — ${t}…`;
    const card = document.querySelector(`.card[data-ticker="${t}"]`);
    if (card) card.style.opacity = "0.5";
    try {
      await api(`/api/analyze?symbol=${encodeURIComponent(t)}`);
    } catch (e) {
      // A 401/403/429 applies to every remaining ticker, so stop rather than
      // hammering the endpoint once per candidate.
      if (["401", "403", "429"].includes(e.message)) {
        $("#wl-summary").textContent = "AI analysis needs a verified account. Sign in to continue.";
        break;
      }
      /* otherwise skip this ticker and keep going */
    }
    if (card) card.style.opacity = "";
  }
  btn.disabled = false;
  await runWatchlist(); // re-render with cached AI scores + re-rank
}

/* ---- Export Discover results to a watchlist ----
   One click turns the current ranked results into watchlist entries. Signed-in
   visitors get them saved straight to their account through the same bulk CSV
   endpoint the Import button uses, so both paths agree on validation, dedupe
   and the per-user cap. Signed-out visitors get the CSV as a download instead —
   the same file the Import button accepts, so nothing they export is stranded. */

/** Escape one CSV field (mirror of csvField in src/auth/watchlist-csv.ts). */
const csvCell = (v) => (/["\n\r,]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

function discoverCsv() {
  const topic = $("#wl-topic").value.trim();
  const rows = ["Symbol,Note,Price"];
  for (const c of lastWatchlist) {
    // The note records where the pick came from — rank and risk class survive
    // the trip onto the watchlist, where only ticker + note are shown.
    const note = `Discover${topic ? ` “${topic}”` : ""} · #${c.rank} · ${c.classification}`;
    rows.push([c.ticker, csvCell(note), c.lastPrice != null ? Number(c.lastPrice).toFixed(2) : ""].join(","));
  }
  return rows.join("\n") + "\n";
}

async function exportDiscover() {
  if (!lastWatchlist.length) return;
  const btn = $("#wl-export");
  btn.disabled = true;
  try {
    if (!authState.user) {
      const blob = new Blob([discoverCsv()], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "discover-watchlist.csv";
      a.click();
      URL.revokeObjectURL(a.href);
      $("#wl-summary").textContent =
        "Downloaded discover-watchlist.csv — create a free account to keep a watchlist online, then Import this file.";
      return;
    }
    const res = await wlApi("POST", { csv: discoverCsv() });
    // Re-renders the Watchlist tab and flips these cards' buttons to ✓ Watching.
    renderMyWatchlist(res.items || []);
    loadWatchlistOverview();
    $("#wl-summary").textContent = `${importSummary(res)} See the Watchlist tab.`;
  } catch (e) {
    if (e.authRequired) { openAuth("login"); return; }
    $("#wl-summary").textContent = `Export failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

async function loadTopics() {
  try {
    const { topics } = await api("/api/topics");
    $("#topic-list").innerHTML = (topics || []).map((t) => `<option value="${esc(t)}"></option>`).join("");
  } catch { /* dropdown is a convenience; typing still works */ }
}

$("#wl-run").addEventListener("click", runWatchlist);
$("#wl-sharpen").addEventListener("click", sharpenAll);
$("#wl-export").addEventListener("click", exportDiscover);
$("#wl-topic").addEventListener("keydown", (e) => e.key === "Enter" && runWatchlist());
// Picking a suggestion from the datalist fires an 'input' change → run it.
$("#wl-topic").addEventListener("change", () => runWatchlist());

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
  const raw = $("#sig-ticker").value.trim();
  const out = $("#signals-out");
  if (!raw) return;
  // Accept a company name here too — the signals API only speaks symbols.
  let ticker = raw.toUpperCase();
  if (!/^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(ticker)) {
    const m = resolveSignals ? await resolveSignals(raw) : null;
    if (!m) return; // no confident match: the picker is showing the options
    ticker = m.symbol;
    $("#sig-ticker").value = ticker;
  }
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
  loadTopics();
  const disc = "This output is generated from public information and automated analysis. It is a research aid, not a guarantee, personalized recommendation, or substitute for professional financial advice. Small-cap and low-priced stocks may be highly volatile, illiquid, subject to dilution, manipulation, delisting, and total loss.";
  $("#disclaimer").textContent = disc;
  // Restore the tab from the URL. `replace` rather than push, so arriving at
  // /#watchlist rewrites the address bar to /watchlist without leaving a
  // fragment entry behind for Back to land on.
  restoreWatchlistPrefs();
  showView(viewFromLocation() ?? "discover", { replace: true });
  runWatchlist();
  // Deep link from a digest email: /?ticker=NVDA opens that stock's detail.
  const params = new URL(location.href).searchParams;
  const wanted = params.get("ticker");
  if (wanted && /^[A-Za-z]{1,5}(\.[A-Za-z]{1,2})?$/.test(wanted)) {
    openTicker(wanted.toUpperCase());
  }
  // Deep link from a "no report for that symbol" page: /?lookup=rivian lands on
  // the watchlist with the picker already showing what they meant.
  const lookup = params.get("lookup");
  if (lookup) {
    showView("watchlist");
    const input = document.getElementById("my-add");
    if (input) {
      input.value = lookup.slice(0, 64);
      input.focus();
      input.dispatchEvent(new Event("input"));
    }
  }
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

/* Volume profile: volume traded by price bucket, distributed across each bar's
   high-low range. Returns bins + POC (point of control) + value area (70%). */
function volumeProfile(bars, buckets = 24) {
  const lo = Math.min(...bars.map((b) => b.l));
  const hi = Math.max(...bars.map((b) => b.h));
  if (!(hi > lo)) return { bins: [], poc: null, vaHigh: null, vaLow: null, maxVol: 0 };
  const step = (hi - lo) / buckets;
  const bins = Array.from({ length: buckets }, (_, i) => ({ low: lo + i * step, high: lo + (i + 1) * step, mid: lo + (i + 0.5) * step, volume: 0 }));
  for (const b of bars) {
    const spanLo = Math.max(lo, b.l), spanHi = Math.min(hi, b.h);
    const first = Math.max(0, Math.min(buckets - 1, Math.floor((spanLo - lo) / step)));
    const last = Math.max(0, Math.min(buckets - 1, Math.floor((spanHi - lo) / step)));
    const n = last - first + 1;
    const per = (b.v || 0) / n;
    for (let i = first; i <= last; i++) bins[i].volume += per;
  }
  let pocIdx = 0;
  bins.forEach((bn, i) => { if (bn.volume > bins[pocIdx].volume) pocIdx = i; });
  const total = bins.reduce((a, b) => a + b.volume, 0);
  // Value area = 70% of volume expanding out from POC.
  const order = [pocIdx];
  let acc = bins[pocIdx].volume, loI = pocIdx, hiI = pocIdx;
  while (acc < total * 0.7 && (loI > 0 || hiI < buckets - 1)) {
    const below = loI > 0 ? bins[loI - 1].volume : -1;
    const above = hiI < buckets - 1 ? bins[hiI + 1].volume : -1;
    if (above >= below) { hiI++; acc += bins[hiI].volume; order.push(hiI); }
    else { loI--; acc += bins[loI].volume; order.push(loI); }
  }
  return { bins, poc: bins[pocIdx].mid, vaHigh: bins[hiI].high, vaLow: bins[loI].low, maxVol: bins[pocIdx].volume };
}

/* Support/resistance from swing pivots, clustered into price zones and ranked
   by touch count. Classified vs the last close. */
function supportResistance(bars, w = 5, maxLevels = 6) {
  const piv = [];
  for (let i = w; i < bars.length - w; i++) {
    const seg = bars.slice(i - w, i + w + 1);
    if (bars[i].h >= Math.max(...seg.map((b) => b.h))) piv.push(bars[i].h);
    if (bars[i].l <= Math.min(...seg.map((b) => b.l))) piv.push(bars[i].l);
  }
  if (!piv.length) return [];
  const last = bars[bars.length - 1].c;
  const tol = last * 0.02; // cluster within 2%
  piv.sort((a, b) => a - b);
  const clusters = [];
  for (const p of piv) {
    const c = clusters[clusters.length - 1];
    if (c && p - c.sum / c.count <= tol) { c.sum += p; c.count++; }
    else clusters.push({ sum: p, count: 1 });
  }
  return clusters
    .map((c) => ({ price: c.sum / c.count, touches: c.count }))
    .filter((l) => l.touches >= 2 && Math.abs(l.price - last) / last > 0.01)
    .sort((a, b) => b.touches - a.touches)
    .slice(0, maxLevels)
    .map((l) => ({ ...l, type: l.price >= last ? "R" : "S" }));
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
  if (!el || !LWC) return null;
  if (bars.length < 2) { el.outerHTML = `<div class="chart-empty">No price history available.</div>`; return null; }
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

  // Support / resistance levels as horizontal price lines.
  for (const lvl of supportResistance(bars)) {
    candleSeries.createPriceLine({
      price: lvl.price,
      color: lvl.type === "R" ? "rgba(248,113,113,0.55)" : "rgba(34,197,94,0.55)",
      lineWidth: 1,
      lineStyle: 0,
      axisLabelVisible: true,
      title: `${lvl.type}·${lvl.touches}`,
    });
  }

  chart.timeScale().fitContent();

  // Volume profile: horizontal volume-by-price bars on an overlay canvas,
  // aligned to the price axis via priceToCoordinate. POC line drawn too.
  const vp = volumeProfile(bars, 26);
  if (vp.bins.length) {
    if (vp.poc != null) {
      candleSeries.createPriceLine({ price: vp.poc, color: "rgba(255,180,84,0.8)", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "POC" });
    }
    const canvas = document.createElement("canvas");
    canvas.className = "vp-overlay";
    el.appendChild(canvas);
    const drawVP = () => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = w * dpr; canvas.height = h * dpr;
      canvas.style.width = w + "px"; canvas.style.height = h + "px";
      const ctx = canvas.getContext("2d");
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, w, h);
      const maxBar = w * 0.28; // profile occupies left ~28%
      for (const bin of vp.bins) {
        const yTop = candleSeries.priceToCoordinate(bin.high);
        const yBot = candleSeries.priceToCoordinate(bin.low);
        if (yTop == null || yBot == null) continue;
        const bh = Math.max(1, Math.abs(yBot - yTop) - 1);
        const bw = (bin.volume / vp.maxVol) * maxBar;
        const inVA = bin.mid <= vp.vaHigh && bin.mid >= vp.vaLow;
        const isPoc = Math.abs(bin.mid - vp.poc) < (bin.high - bin.low);
        ctx.fillStyle = isPoc ? "rgba(255,180,84,0.55)" : inVA ? "rgba(76,141,255,0.34)" : "rgba(120,130,160,0.22)";
        ctx.fillRect(0, Math.min(yTop, yBot), bw, bh);
      }
    };
    requestAnimationFrame(drawVP);
    chart.timeScale().subscribeVisibleLogicalRangeChange(drawVP);
    new ResizeObserver(drawVP).observe(el);
  }

  return { chart, series: candleSeries, valueByTime: new Map(bars.map((b) => [b.t, b.c])), fallback: bars[bars.length - 1].c };
}

function mountMacdChart(bars) {
  const el = document.getElementById("lwc-macd");
  if (!el || !LWC || bars.length < 35) { if (el) el.outerHTML = ""; return null; }
  const closes = bars.map((b) => b.c);
  const { macd, signal, hist } = macdSeries(closes, 12, 26, 9);
  const chart = baseChart(el, 150);

  // Whitespace for nulls keeps the axis aligned with the other panes.
  const histSeries = chart.addSeries(LWC.HistogramSeries, { priceLineVisible: false, lastValueVisible: false });
  histSeries.setData(bars.map((b, i) => (hist[i] == null ? { time: b.t } : { time: b.t, value: hist[i], color: hist[i] >= 0 ? "rgba(34,197,94,0.55)" : "rgba(248,113,113,0.55)" })));

  const macdLine = chart.addSeries(LWC.LineSeries, { color: "#4c8dff", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
  macdLine.setData(bars.map((b, i) => (macd[i] == null ? { time: b.t } : { time: b.t, value: macd[i] })));

  const sigLine = chart.addSeries(LWC.LineSeries, { color: "#ffb454", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
  sigLine.setData(bars.map((b, i) => (signal[i] == null ? { time: b.t } : { time: b.t, value: signal[i] })));

  chart.timeScale().fitContent();
  return { chart, series: macdLine, valueByTime: new Map(bars.map((b, i) => [b.t, macd[i]])), fallback: 0 };
}

function mountRsiChart(bars) {
  const el = document.getElementById("lwc-rsi");
  if (!el || !LWC || bars.length < 15) { if (el) el.outerHTML = ""; return null; }
  const closes = bars.map((b) => b.c);
  const r = rsiSeries(closes);
  const chart = baseChart(el, 130);
  chart.applyOptions({ rightPriceScale: { borderColor: chartColors.border, autoScale: false, scaleMargins: { top: 0.1, bottom: 0.1 } } });
  const line = chart.addSeries(LWC.LineSeries, { color: "#c48dff", lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
  // Whitespace ({time} with no value) for leading nulls keeps the time axis
  // identical to the price chart so synced zoom stays aligned.
  line.setData(bars.map((b, i) => (r[i] == null ? { time: b.t } : { time: b.t, value: r[i] })));
  line.createPriceLine({ price: 70, color: "rgba(248,113,113,.5)", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "70" });
  line.createPriceLine({ price: 30, color: "rgba(34,197,94,.5)", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "30" });
  chart.timeScale().fitContent();
  return { chart, series: line, valueByTime: new Map(bars.map((b, i) => [b.t, r[i]])), fallback: 50 };
}

/* Keep every pane's time axis locked together: zoom/pan one → all follow.
   Guarded by a range-diff check so the cross-updates don't loop. */
function syncTimeScales(charts) {
  const list = charts.filter(Boolean);
  for (const src of list) {
    src.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (!range) return;
      for (const tgt of list) {
        if (tgt === src) continue;
        const ts = tgt.timeScale();
        const cur = ts.getVisibleLogicalRange();
        if (!cur || Math.abs(cur.from - range.from) > 0.4 || Math.abs(cur.to - range.to) > 0.4) {
          try { ts.setVisibleLogicalRange(range); } catch {}
        }
      }
    });
  }
}

function timeKey(t) {
  return typeof t === "string" ? t : `${t.year}-${String(t.month).padStart(2, "0")}-${String(t.day).padStart(2, "0")}`;
}

/* Synced crosshair: hovering any pane places the crosshair at the same time on
   every other pane (vertical line aligned; horizontal at that pane's own value).
   Guarded so programmatic placement doesn't re-trigger the sync. */
let chSyncing = false;
function syncCrosshair(panes) {
  for (const src of panes) {
    src.chart.subscribeCrosshairMove((param) => {
      if (chSyncing) return;
      chSyncing = true;
      try {
        if (!param.point || param.time == null) {
          for (const o of panes) if (o !== src) o.chart.clearCrosshairPosition();
        } else {
          const key = timeKey(param.time);
          for (const o of panes) {
            if (o === src) continue;
            const v = o.valueByTime.get(key);
            o.chart.setCrosshairPosition(v == null ? o.fallback : v, param.time, o.series);
          }
        }
      } finally {
        chSyncing = false;
      }
    });
  }
}

function mountCharts(bars) {
  destroyCharts();
  // Defer to next frame so the modal has laid out and containers have width.
  requestAnimationFrame(() => {
    const panes = [mountPriceChart(bars), mountMacdChart(bars), mountRsiChart(bars)].filter(Boolean);
    syncTimeScales(panes.map((p) => p.chart));
    syncCrosshair(panes);
  });
}

const fmtNum = (n, d = 2) => (n == null ? "—" : Number(n).toLocaleString(undefined, { maximumFractionDigits: d }));
const fmtBig = (n) => (n == null ? "—" : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${fmtNum(n)}`);
const kv = (k, v, cls = "") => `<div class="kv"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`;
const pctOf = (s) => (s && s.probability != null ? Math.round(s.probability * 100) + "%" : "—");

/* Analysis section: shows the cached AI (LLM) analysis if present, else the
   deterministic offline one, with a "Sharpen with AI" button (on-demand LLM). */
function analysisBlock(d) {
  const ai = d.aiAnalysis;
  const src = ai ? ai.analysis : d.analysis;
  if (!src || !src.thesis) return "";
  const providers = d.aiProviders || [];
  const overall = ai ? ai.overallScore : d.overallScore;
  const conf = ai ? ai.confidence : d.confidence;
  const head = ai
    ? `<span class="badge audio">✨ AI · ${esc(ai.provider)}:${esc(ai.model)}</span>`
    : `<span class="badge conservative">offline · deterministic</span>`;
  // No fixed provider: the server tries OpenAI first, falls back to Anthropic.
  const btn = providers.length
    ? `<button class="sharpen-btn" data-sharpen="${esc(d.ticker)}">${
        !authState.user ? "✨ Sharpen with AI — free with an account" : ai ? "↻ Re-run AI" : "✨ Sharpen with AI"
      }</button>`
    : "";
  const chips = (arr, cls, mark) => (arr && arr.length ? `<div class="chips">${arr.slice(0, 6).map((x) => `<span class="chip ${cls}">${mark} ${esc(x)}</span>`).join("")}</div>` : "");
  const scen = (src.bullCase || src.bearCase)
    ? `<div class="an-sub">Scenarios</div><p class="thesis">Bull ${pctOf(src.bullCase)} · Base ${pctOf(src.baseCase)} · Bear ${pctOf(src.bearCase)}${src.bullCase?.assumptions?.[0] ? `<br><span class="sig-dir positive">Bull:</span> ${esc(src.bullCase.assumptions[0])}` : ""}${src.bearCase?.assumptions?.[0] ? `<br><span class="sig-dir negative">Bear:</span> ${esc(src.bearCase.assumptions[0])}` : ""}</p>`
    : "";
  const missing = src.missingData?.length ? `<div class="an-sub">Missing data</div><p class="src-note">${src.missingData.map(esc).join(" · ")}</p>` : "";
  return `<div class="dl-section" id="ai-analysis-section">
    <h3 class="an-head">Analysis ${head} <span class="an-spacer"></span> ${btn}</h3>
    <p class="thesis">${esc(src.thesis)}</p>
    <div class="grid2">${kv("Overall", (overall ?? "—") + "/100")}${kv("Confidence", (conf ?? "—") + "/100")}</div>
    ${src.catalystSummary?.length ? `<div class="an-sub">Catalysts</div>${chips(src.catalystSummary, "pos", "▲")}` : ""}
    ${src.riskSummary?.length ? `<div class="an-sub">Risks</div>${chips(src.riskSummary, "neg", "▼")}` : ""}
    ${scen}${missing}
  </div>`;
}

/* Streams the analysis over SSE and shows each pipeline stage as it happens.
   The previous version rendered an untimed spinner, so a slow model call, a
   schema-validation failure and an edge-proxy 502 were indistinguishable. */
function sharpen(ticker) {
  const sec = document.getElementById("ai-analysis-section");
  if (!sec) return;
  // Client-side courtesy check — the server enforces this regardless. Prompting
  // here avoids opening an EventSource that can only fail, since EventSource
  // cannot read a 401 body.
  if (!authState.user) { sec.innerHTML = aiPromo(ticker); return; }
  if (!authState.user.emailVerified) { sec.innerHTML = aiVerifyPrompt(); return; }
  const started = Date.now();
  const lines = [];

  const secs = () => ((Date.now() - started) / 1000).toFixed(0);
  const paint = (state) => {
    const log = lines
      .map((l) => `<li class="an-step${l.done ? " done" : ""}${l.bad ? " bad" : ""}"><span class="an-step-t">${l.t}s</span> ${esc(l.text)}</li>`)
      .join("");
    sec.innerHTML =
      `<h3 class="an-head">Analysis</h3>` +
      (state === "running" ? `<div class="spinner"></div>` : "") +
      `<p class="empty">${state === "running" ? `Analyzing ${esc(ticker)}… ${secs()}s elapsed` : esc(state)}</p>` +
      `<ul class="an-steps">${log}</ul>` +
      (state === "running" ? "" : `<button class="sharpen-btn" data-sharpen="${esc(ticker)}">Retry</button>`);
  };
  const step = (text, opts = {}) => {
    lines.push({ text, t: secs(), done: !!opts.done, bad: !!opts.bad });
    if (lines.length > 14) lines.shift();
    paint("running");
  };

  step(`Requesting analysis for ${ticker}`);
  // Keeps the elapsed counter honest during the long model call.
  const tick = setInterval(() => paint("running"), 1000);

  const es = new EventSource(`/api/analyze/stream?symbol=${encodeURIComponent(ticker)}`);
  const stop = () => { clearInterval(tick); es.close(); };

  es.addEventListener("status", (e) => {
    const d = JSON.parse(e.data);
    step(`Provider order: ${(d.providers || []).join(" → ")}`);
  });
  es.addEventListener("provider", (e) => step(JSON.parse(e.data).message));
  es.addEventListener("stage", (e) => {
    const d = JSON.parse(e.data);
    step(d.message, { done: d.done });
  });
  es.addEventListener("provider_failed", (e) => {
    const d = JSON.parse(e.data);
    step(`${d.provider} failed: ${String(d.error).slice(0, 160)}`, { bad: true });
  });
  es.addEventListener("result", (e) => {
    const r = JSON.parse(e.data);
    stop();
    window.dispatchEvent(new CustomEvent("advis0r:credits-changed"));
    const dd = { ticker, aiProviders: ["ai"], aiAnalysis: { provider: r.provider, model: r.model, overallScore: r.overallScore, confidence: r.confidence, analysis: r.analysis } };
    sec.outerHTML = analysisBlock(dd);
  });
  // Server-reported failure. Named "failed" rather than "error" so it cannot be
  // confused with EventSource's built-in error event, which carries no data.
  es.addEventListener("failed", (e) => {
    stop();
    window.dispatchEvent(new CustomEvent("advis0r:credits-changed"));
    const msg = JSON.parse(e.data).error || "analysis failed";
    step(msg, { bad: true });
    paint(`Sharpen failed: ${String(msg).slice(0, 200)}`);
  });
  // Transport failure (proxy timeout, dropped connection) — EventSource fires
  // onerror with no data, which is exactly the 502 case the user hit.
  es.onerror = () => {
    if (es.readyState === EventSource.CLOSED) {
      stop();
      paint(`Connection to the server dropped after ${secs()}s`);
    }
  };
}

/* ---- Stored report snapshots ----
   A report is generated once and served from storage thereafter, so the modal
   has to say *when* the snapshot was taken — a stale price is fine, a stale
   price presented as live is not. Regeneration is offered for tickers on the
   signed-in user's watchlist; the server enforces the same rule. */

let detailReport = null; // the payload currently shown in the modal

function timeAgo(iso) {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown";
  const s = Math.max(0, (Date.now() - then) / 1000);
  if (s < 45) return "just now";
  const units = [[60, "second"], [3600, "minute"], [86400, "hour"], [604800, "day"], [2629800, "week"], [31557600, "month"]];
  let div = 1;
  for (const [limit, name] of units) {
    if (s < limit) { const v = Math.round(s / div); return `${v} ${name}${v === 1 ? "" : "s"} ago`; }
    div = limit;
  }
  const y = Math.round(s / 31557600);
  return `${y} year${y === 1 ? "" : "s"} ago`;
}

function reportMetaHtml(d) {
  if (!d || !d.reportGeneratedAt) return "";
  const ticker = d.ticker;
  const watching = myTickers.has(ticker);
  const regen = watching
    ? `<button class="rp-regen" data-regen="${esc(ticker)}" title="Rebuild this report from live market data">↻ Regenerate</button>`
    : authState.user
      ? `<span class="rp-hint">Add to your watchlist to regenerate</span>`
      : "";
  return `<span class="rp-stamp-t">Snapshot ${esc(timeAgo(d.reportGeneratedAt))}</span>
    <a class="rp-permalink" href="/stocks/${encodeURIComponent(ticker)}" target="_blank" rel="noopener">Full report ↗</a>
    ${regen}`;
}

function renderReportMeta() {
  const el = document.getElementById("dl-report-meta");
  if (el && detailReport) el.innerHTML = reportMetaHtml(detailReport);
}

async function regenerateReport(ticker) {
  const el = document.getElementById("dl-report-meta");
  if (el) el.innerHTML = `<span class="rp-stamp-t">Rebuilding ${esc(ticker)} from live market data…</span>`;
  try {
    const res = await fetch("/api/report/regenerate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ ticker }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Regenerate failed (${res.status})`);
    // The response *is* the fresh report, so re-render from it directly.
    renderDetail(data);
  } catch (e) {
    if (el) el.innerHTML = `<span class="rp-hint bad">${esc(e.message)}</span>`;
  }
}

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-regen]");
  if (b) { e.preventDefault(); regenerateReport(b.dataset.regen); }
});

function renderDetail(d) {
  detailReport = d;
  const t = d.technical || {};
  const f = d.facts || {};
  const a = d.analysis || {};
  const chg = d.bars && d.bars.length > 1 ? ((d.bars.at(-1).c - d.bars.at(-2).c) / d.bars.at(-2).c) * 100 : null;
  const clsBadge = d.classification
    ? `<span class="badge ${d.classification === "high-risk speculative" ? "high" : d.classification === "speculative" ? "speculative" : "conservative"}">${esc(d.classification)}</span>`
    : "";
  const evLabel = (t) => ({ earnings_call: "Earnings call", investor_day: "Investor day", conference: "Conference", keynote: "Keynote", fireside_chat: "Fireside chat", interview: "Interview", shareholder_meeting: "Shareholder meeting", product_launch: "Product launch", press_conference: "Press conference", podcast: "Podcast", presentation: "Presentation", sec_exhibit: "SEC exhibit", blog_post: "Blog post", video: "Video", news_article: "News", press_release: "Press release" }[t] || (t || "Document"));

  const sourceCard = (s) => {
    const said = (s.said || []).map((q) =>
      `<div class="said-row"><span class="sig-dir ${esc(q.direction)}">${q.direction === "positive" ? "▲" : q.direction === "negative" ? "▼" : "•"} ${esc((q.signalType || "").replace(/_/g, " "))}</span><span class="said-q">"${esc((q.quote || "").slice(0, 220))}"</span></div>`).join("");
    let media = "";
    if (s.kind === "video" && s.embedUrl) {
      media = s.direct
        ? `<video class="src-video" controls preload="metadata" src="${esc(s.embedUrl)}"></video>`
        : `<div class="src-embed"><iframe src="${esc(s.embedUrl)}" title="${esc(s.title)}" loading="lazy" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen referrerpolicy="strict-origin-when-cross-origin"></iframe></div>`;
    } else if (s.kind === "audio" && s.embedUrl) {
      media = `<audio class="src-audio" controls preload="metadata" src="${esc(s.embedUrl)}"></audio>`;
    }
    const badge = s.kind === "video" ? { cls: "speculative", label: "▶ Video" } : s.kind === "audio" ? { cls: "audio", label: "♪ Audio" } : s.kind === "news" ? { cls: "news", label: "📰 News" } : { cls: "conservative", label: "≡ Transcript" };
    const linkLabel = s.kind === "video" ? "Watch ↗" : s.kind === "audio" ? "Listen ↗" : s.kind === "news" ? "Read ↗" : "Transcript ↗";
    return `<div class="source">
      <div class="source-head">
        <span class="badge ${badge.cls}">${badge.label}</span>
        <span class="source-type">${esc(evLabel(s.eventType))}${s.publisher ? " · " + esc(s.publisher) : ""}${s.publishedAt ? " · " + esc(String(s.publishedAt).slice(0, 10)) : ""}</span>
        <span class="source-counts">${s.positive ? `<span class="pos">▲${s.positive}</span>` : ""} ${s.negative ? `<span class="neg">▼${s.negative}</span>` : ""}</span>
        <a class="source-link" href="${esc(s.url)}" target="_blank" rel="noopener">${linkLabel}</a>
      </div>
      ${s.kind === "news" && s.title ? `<a class="src-title" href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : ""}
      ${media}
      ${said ? `<div class="said">${said}</div>` : ""}
    </div>`;
  };
  const sourcesHtml = (d.sources || []).map(sourceCard).join("");

  // Fallback: raw signals if no source grouping is available.
  const sig = (d.signals || []).slice(0, 12).map((x) =>
    `<div class="res"><div class="meta"><span class="sig-dir ${esc(x.direction)}">${esc(x.signal_type)} · ${esc(x.direction)}</span><span>${esc(x.event_date || "")}</span><span>str ${Number(x.strength).toFixed(2)}</span></div><div class="txt">${esc((x.quote || "").slice(0, 240))}</div></div>`).join("");

  $("#detail-panel").innerHTML = `
    <button class="close-x" data-close aria-label="Close">×</button>
    <div class="dl-head">
      <div>
        <span class="tkr">${esc(d.ticker)}</span> ${clsBadge}
        <div class="cname">${esc(d.companyName || "")}${d.exchange ? " · " + esc(d.exchange) : ""}</div>
        <div class="dl-actions" id="dl-watch-slot">${detailWatchButton(d.ticker)}</div>
      </div>
      <div class="dl-price">
        <div class="p">${d.lastPrice != null ? "$" + Number(d.lastPrice).toFixed(2) : "—"}</div>
        <div class="sub">${chg != null ? `<span class="${chg >= 0 ? "sig-dir positive" : "sig-dir negative"}">${chg >= 0 ? "+" : ""}${chg.toFixed(2)}%</span> · ` : ""}${d.delayed ? "delayed" : "live"} · ${esc(d.marketSource)}</div>
      </div>
    </div>
    <div class="rp-meta" id="dl-report-meta">${reportMetaHtml(d)}</div>
    <div id="dl-watch-promo"></div>

    <div class="chartbox">
      <div id="lwc-price" class="lwchart"></div>
      <div class="legend"><span><i style="background:#22c55e"></i>Candles</span><span><i style="background:#4c8dff"></i>SMA20</span><span><i style="background:#ffb454"></i>SMA50</span><span><i style="background:rgba(150,160,190,.8)"></i>Bollinger 20/2</span><span><i style="background:rgba(76,141,255,.34)"></i>Vol profile</span><span><i style="background:rgba(255,180,84,.8)"></i>POC</span><span><i style="background:rgba(34,197,94,.55)"></i>Support</span><span><i style="background:rgba(248,113,113,.55)"></i>Resistance</span></div>
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
      ${d.factsError ? `<p class="src-note">SEC EDGAR was unavailable for this snapshot (${esc(d.factsError)}). Regenerate to fill these in.</p>` : ""}
    </div>

    ${analysisBlock(d)}

    ${sourcesHtml
      ? `<div class="dl-section"><h3>Sources — transcripts, news &amp; media (${(d.sources || []).length})</h3><div class="sources">${sourcesHtml}</div></div>`
      : sig
        ? `<div class="dl-section"><h3>Signals (${(d.signals || []).length})</h3><div class="results">${sig}</div></div>`
        : ""}

    <p class="src-note">Price data: ${esc(d.marketSource)} (${d.delayed ? "end-of-day, delayed" : "real-time"}). Fundamentals: SEC EDGAR. Indicators computed locally. ${d.marketError ? "Market data note: " + esc(d.marketError) : ""}</p>
    <div class="disclaimer">${esc(d.disclaimer || "")}</div>`;

  mountCharts(d.bars || []);
}

async function openTicker(sym) {
  if (!sym) return;
  detailTicker = sym;
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
  detailTicker = null;
  detailReport = null;
  $("#detail").classList.add("hidden");
  document.body.style.overflow = "";
}
document.addEventListener("click", (e) => {
  const sh = e.target.closest(".sharpen-btn");
  if (sh && sh.dataset.sharpen) { e.preventDefault(); sharpen(sh.dataset.sharpen); return; }
  // `.tlink` used to open the modal. It navigates to the report page now, so
  // the address bar holds something worth sharing.
  const link = e.target.closest(".tlink");
  if (link && link.dataset.ticker) {
    e.preventDefault();
    location.href = `/stocks/${encodeURIComponent(link.dataset.ticker)}`;
    return;
  }
  if (e.target.closest("[data-close]")) closeDetail();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDetail(); });

/* ---- PWA service worker ---- */
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

/* ---- Per-user saved watchlist (requires sign-in) ----
   The only authenticated surface in the app: the server scopes every query by
   the session's user id, and an anonymous request gets 401 + authRequired,
   which is what this view renders a sign-in prompt from. */


/** Mirrors FREE_MONTHLY_CREDITS in src/credits/ledger.ts — used only in the
    signed-out pitch, where /api/credits has no balance to report yet. */
const FREE_CREDITS_PER_MONTH = 100;

/** Ticker the detail modal is currently showing, so the watch button in its
    header can be re-rendered when the user signs in without reloading. */
var detailTicker = null;
/** Ticker the visitor tried to save while signed out; added once they land. */
var pendingWatch = null;

async function wlApi(method, body) {
  const res = await fetch("/api/watchlist", {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401) { const e = new Error(data.error || "Sign in required"); e.authRequired = true; throw e; }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ---- Watchlist dashboard state ----
   Two payloads back this tab. `/api/watchlist` is the membership list — it is
   what add and remove return, so it is the source of truth for what is saved.
   `/api/watchlist/overview` is the same rows priced, scored and charted; it
   costs a market fetch, so it is loaded alongside rather than instead, and the
   table degrades to the plain list when it is missing.

   Sort, filter and range live in the URL as well as in localStorage: the
   address bar makes a configured table shareable, storage makes it the way you
   left it on the next visit. */

const WL_STORE_KEY = "wl-view";
const WL_RANGES = ["1M", "3M", "6M", "1Y"];
const WL_DEFAULTS = { range: "3M", sort: "range", dir: "desc", q: "", cls: "all" };

let wlView = { ...WL_DEFAULTS };
let wlItems = [];        // saved rows: {ticker, note, createdAt}
let wlOverview = null;   // the priced payload, or null before it lands
let wlLoadingOverview = false;
/** A one-off message (an import result, an error) shown ahead of the prices. */
let wlNotice = "";

function restoreWatchlistPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(WL_STORE_KEY) || "{}");
    for (const k of Object.keys(WL_DEFAULTS)) {
      if (typeof saved[k] === "string") wlView[k] = saved[k];
    }
  } catch { /* blocked storage: the defaults are fine */ }
  // A link wins over what this browser last did — that is the point of putting
  // it in the URL.
  const params = new URL(location.href).searchParams;
  for (const k of Object.keys(WL_DEFAULTS)) {
    const v = params.get(k === "q" ? "q" : k);
    if (v != null) wlView[k] = v;
  }
  if (!WL_RANGES.includes(wlView.range)) wlView.range = WL_DEFAULTS.range;
  if (wlView.dir !== "asc" && wlView.dir !== "desc") wlView.dir = WL_DEFAULTS.dir;
}

function persistWatchlistPrefs() {
  try { localStorage.setItem(WL_STORE_KEY, JSON.stringify(wlView)); } catch { /* ignore */ }
  // Only rewrite the URL while the watchlist is the visible tab, so switching
  // to Search does not leave the table's state stuck to a different path.
  if (!document.querySelector('.view[data-view="watchlist"]')?.classList.contains("active")) return;
  const url = new URL(location.href);
  for (const [k, def] of Object.entries(WL_DEFAULTS)) {
    if (wlView[k] && wlView[k] !== def) url.searchParams.set(k, wlView[k]);
    else url.searchParams.delete(k);
  }
  try { history.replaceState(history.state, "", `${url.pathname}${url.search}`); } catch { /* ignore */ }
}

/* ---- Formatting ---- */

const wlPct = (n, dp = 2) => (n == null || !isFinite(n) ? "—" : `${n >= 0 ? "+" : ""}${n.toFixed(dp)}%`);
const wlSign = (n) => (n == null || !isFinite(n) ? "" : n > 0 ? "pos" : n < 0 ? "neg" : "");
const wlMoney = (n) => (n == null || !isFinite(n) ? "—" : `$${Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const wlDate = (iso) => (iso ? String(iso).slice(0, 10) : "—");
const changeOf = (item, label) => item.changes?.find((c) => c.label === label)?.percent ?? null;

/* ---- Summary tiles ---- */

function wlStatTile(label, value, sub, cls = "") {
  return `<div class="wl-stat">
    <span class="wl-stat-lab">${esc(label)}</span>
    <b class="wl-stat-val ${cls}">${value}</b>
    <span class="wl-stat-sub">${sub}</span>
  </div>`;
}

function renderWlStats() {
  const el = document.getElementById("wl-stats");
  if (!el || !wlOverview) return;
  const s = wlOverview.stats;
  const range = wlOverview.range;
  const mover = (m) => (m ? `<span class="wl-stat-tick">${esc(m.ticker)}</span> ${wlPct(m.percent, 1)}` : "—");

  el.innerHTML = [
    wlStatTile(
      "Tickers",
      String(s.count),
      `${s.priced} priced${s.missing.length ? ` · ${s.missing.length} without data` : ""}`,
    ),
    wlStatTile(
      "Last session",
      wlPct(s.avgDayPercent, 2),
      `${s.gainers} up · ${s.losers} down`,
      wlSign(s.avgDayPercent),
    ),
    wlStatTile(
      `${range} equal-weight`,
      wlPct(s.rangePercent, 1),
      s.benchmarkPercent != null ? `SPY ${wlPct(s.benchmarkPercent, 1)}` : "no benchmark data",
      wlSign(s.rangePercent),
    ),
    wlStatTile("Best", mover(s.best), `over ${range}`, s.best ? wlSign(s.best.percent) : ""),
    wlStatTile("Worst", mover(s.worst), `over ${range}`, s.worst ? wlSign(s.worst.percent) : ""),
    wlStatTile(
      "Avg score",
      s.avgScore != null ? `${Math.round(s.avgScore)}<span class="wl-stat-of">/100</span>` : "—",
      `${s.scored} of ${s.count} scored`,
    ),
  ].join("");
}

/* ---- The index chart ----
   Both lines are rebased to 100 at the start of the window, so one axis carries
   both: an equal-weight watchlist and a broad-market ETF have nothing in common
   in dollars, and drawing them against two scales would let any pair of lines
   be made to tell any story. Percentages from a shared base is the honest form.

   Drawn as inline SVG at real pixel coordinates rather than through the chart
   vendor: two rebased lines need no candles, no panes and no time-scale sync,
   and this way the crosshair, the dashed benchmark and the end labels are
   exactly what they look like. */

const WL_CHART_H = 230;
/** Room on the right for the end labels; dropped when the chart is narrow. */
const WL_LABEL_W = 116;
const WL_CHART_PAD = { top: 16, right: WL_LABEL_W, bottom: 24, left: 46 };
/** Below this the end labels would take more room than the lines. */
const WL_LABEL_MIN_W = 520;

let wlChartGeom = null;

/**
 * Gridline values on a 1 / 2 / 2.5 / 5 ladder rather than the raw domain split
 * evenly — "15%, 10%, 4%, -1%" is a scale nobody reads twice.
 */
function niceTicks(lo, hi, count = 5) {
  const raw = (hi - lo) / Math.max(1, count - 1);
  if (!(raw > 0)) return [lo];
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Number(v.toFixed(6)));
  return out.length ? out : [lo, hi];
}

function wlChartPaths(index, width) {
  const dates = [...new Set([...index.points, ...index.benchmark].map((p) => p.t))].sort();
  if (dates.length < 2) return null;
  const xAt = new Map(dates.map((d, i) => [d, i]));
  // On a narrow chart the end labels are dropped, not shrunk: the legend below
  // already names both lines, and a squeezed plot reads worse than no label.
  const labelled = width >= WL_LABEL_MIN_W;
  const padRight = labelled ? WL_CHART_PAD.right : 16;
  const plotW = Math.max(60, width - WL_CHART_PAD.left - padRight);
  const plotH = WL_CHART_H - WL_CHART_PAD.top - WL_CHART_PAD.bottom;

  const values = [...index.points, ...index.benchmark].map((p) => p.value).concat(100);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const pad = (max - min) * 0.08 || 1;
  const lo = min - pad;
  const hi = max + pad;

  const x = (t) => WL_CHART_PAD.left + (xAt.get(t) / (dates.length - 1)) * plotW;
  const y = (v) => WL_CHART_PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const project = (pts) => pts.filter((p) => xAt.has(p.t)).map((p) => ({ ...p, x: x(p.t), y: y(p.value) }));

  return {
    dates, lo, hi, plotW, plotH, x, y, labelled,
    series: [
      { key: "watchlist", label: "Watchlist", color: "var(--chart-1)", dashed: false, points: project(index.points) },
      { key: "benchmark", label: index.benchmarkSymbol, color: "var(--chart-2)", dashed: true, points: project(index.benchmark) },
    ].filter((s) => s.points.length >= 2),
  };
}

const wlPathD = (points) => points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("");

function renderWlChart() {
  const box = document.getElementById("wl-chart");
  const legend = document.getElementById("wl-chart-legend");
  const note = document.getElementById("wl-chart-note");
  if (!box) return;
  const index = wlOverview?.index;
  if (!index || index.points.length < 2) {
    wlChartGeom = null;
    box.innerHTML = `<p class="empty wl-chart-empty">Not enough shared price history to chart this watchlist yet.</p>`;
    if (legend) legend.innerHTML = "";
    if (note) note.textContent = "";
    return;
  }

  const width = box.clientWidth || 720;
  const geom = wlChartPaths(index, width);
  if (!geom) return;
  wlChartGeom = geom;

  // Recessive gridlines with their own value labels. A rebased chart reads in
  // percent, so they are labelled that way rather than as index points.
  const ticks = niceTicks(geom.lo, geom.hi);
  const dp = Math.abs((ticks[1] ?? 100) - (ticks[0] ?? 0)) < 1 ? 1 : 0;
  const grid = ticks
    .map((v) => `<g><line class="wl-grid" x1="${WL_CHART_PAD.left}" x2="${WL_CHART_PAD.left + geom.plotW}" y1="${geom.y(v).toFixed(1)}" y2="${geom.y(v).toFixed(1)}"/>
      <text class="wl-axis" x="${WL_CHART_PAD.left - 8}" y="${(geom.y(v) + 3.5).toFixed(1)}" text-anchor="end">${(v - 100).toFixed(dp)}%</text></g>`)
    .join("");

  const lines = geom.series
    .map((s) => `<path class="wl-line" d="${wlPathD(s.points)}" fill="none" stroke="${s.color}"
        stroke-width="2" stroke-linejoin="round" stroke-linecap="round"
        ${s.dashed ? 'stroke-dasharray="5 4"' : ""}/>`)
    .join("");

  // Direct end labels: identity never rests on colour alone.
  const ends = geom.series
    .map((s) => {
      const last = s.points.at(-1);
      const pct = last.value - 100;
      const label = geom.labelled
        ? `<text class="wl-endlab" x="${(last.x + 8).toFixed(1)}" y="${(last.y + 4).toFixed(1)}" fill="${s.color}">${esc(s.label)} ${wlPct(pct, 1)}</text>`
        : "";
      return `<g><circle cx="${last.x.toFixed(1)}" cy="${last.y.toFixed(1)}" r="3.5" fill="${s.color}" stroke="var(--panel-2)" stroke-width="2"/>${label}</g>`;
    })
    .join("");

  const first = geom.dates[0];
  const last = geom.dates.at(-1);
  const axis = `<text class="wl-axis" x="${WL_CHART_PAD.left}" y="${WL_CHART_H - 6}">${esc(first)}</text>
    <text class="wl-axis" x="${WL_CHART_PAD.left + geom.plotW}" y="${WL_CHART_H - 6}" text-anchor="end">${esc(last)}</text>`;

  box.innerHTML = `<svg class="wl-svg" width="${width}" height="${WL_CHART_H}" viewBox="0 0 ${width} ${WL_CHART_H}" role="img"
      aria-label="Watchlist versus ${esc(index.benchmarkSymbol)}, rebased to 100">
    ${grid}
    <line class="wl-base" x1="${WL_CHART_PAD.left}" x2="${WL_CHART_PAD.left + geom.plotW}" y1="${geom.y(100).toFixed(1)}" y2="${geom.y(100).toFixed(1)}"/>
    ${lines}${ends}${axis}
    <g class="wl-cross" hidden>
      <line class="wl-cross-line" x1="${WL_CHART_PAD.left}" x2="${WL_CHART_PAD.left}" y1="${WL_CHART_PAD.top}" y2="${WL_CHART_PAD.top + geom.plotH}"/>
      ${geom.series.map((s) => `<circle class="wl-cross-dot" data-series="${s.key}" r="4" fill="${s.color}" stroke="var(--panel-2)" stroke-width="2"/>`).join("")}
    </g>
  </svg>`;

  if (legend) {
    legend.innerHTML = geom.series
      .map((s) => `<span class="wl-legend-item" data-series="${s.key}">
        <i class="wl-swatch${s.dashed ? " dashed" : ""}" style="--sw:${s.color}"></i>
        ${esc(s.label)} <b class="wl-legend-val">${wlPct(s.points.at(-1).value - 100, 1)}</b>
      </span>`)
      .join("");
  }
  if (note) {
    const excluded = index.excluded.length
      ? ` ${index.excluded.length} ticker${index.excluded.length === 1 ? "" : "s"} left out for want of history over the window (${index.excluded.slice(0, 6).map(esc).join(", ")}${index.excluded.length > 6 ? "…" : ""}).`
      : "";
    note.textContent = `Equal-weight across ${index.members.length} ticker${index.members.length === 1 ? "" : "s"}, rebased to 100 at ${first}.${excluded}`;
  }

  attachWlCrosshair(box.querySelector("svg"), legend);
}

/** Hover anywhere on the plot: both lines report their value at that session. */
function attachWlCrosshair(svg, legend) {
  if (!svg || !wlChartGeom) return;
  const cross = svg.querySelector(".wl-cross");
  const geom = wlChartGeom;

  const move = (clientX) => {
    const rect = svg.getBoundingClientRect();
    // A zero-width rect means the element is not laid out (or is off-screen);
    // there is nothing meaningful to point at.
    if (!rect.width) return;
    const px = ((clientX - rect.left) / rect.width) * (svg.viewBox?.baseVal?.width || rect.width);
    let best = null;
    for (const s of geom.series) {
      for (const p of s.points) {
        const d = Math.abs(p.x - px);
        if (!best || d < best.d) best = { d, t: p.t };
      }
    }
    if (!best) return;
    cross?.removeAttribute("hidden");
    const lineEl = cross?.querySelector(".wl-cross-line");
    let lineX = null;
    for (const s of geom.series) {
      const point = s.points.find((p) => p.t === best.t) ?? null;
      const dot = cross?.querySelector(`[data-series="${s.key}"]`);
      if (dot) {
        if (point) { dot.setAttribute("cx", point.x); dot.setAttribute("cy", point.y); dot.removeAttribute("hidden"); }
        else dot.setAttribute("hidden", "");
      }
      if (point) lineX = point.x;
      const val = legend?.querySelector(`[data-series="${s.key}"] .wl-legend-val`);
      if (val) val.textContent = point ? wlPct(point.value - 100, 1) : "—";
    }
    if (lineEl && lineX != null) { lineEl.setAttribute("x1", lineX); lineEl.setAttribute("x2", lineX); }
    const cap = document.getElementById("wl-chart-cap");
    if (cap) cap.dataset.hover = best.t;
    const dateEl = legend?.querySelector(".wl-legend-date");
    if (dateEl) dateEl.textContent = best.t;
  };

  const leave = () => {
    cross?.setAttribute("hidden", "");
    for (const s of geom.series) {
      const val = legend?.querySelector(`[data-series="${s.key}"] .wl-legend-val`);
      if (val) val.textContent = wlPct(s.points.at(-1).value - 100, 1);
    }
    const dateEl = legend?.querySelector(".wl-legend-date");
    if (dateEl) dateEl.textContent = geom.dates.at(-1);
  };

  if (legend && !legend.querySelector(".wl-legend-date")) {
    legend.insertAdjacentHTML("beforeend", `<span class="wl-legend-date">${esc(geom.dates.at(-1))}</span>`);
  }
  svg.addEventListener("mousemove", (e) => move(e.clientX));
  svg.addEventListener("mouseleave", leave);
  svg.addEventListener("touchmove", (e) => { const t = e.touches[0]; if (t) move(t.clientX); }, { passive: true });
  svg.addEventListener("touchend", leave);
}

/* ---- Filtering + sorting ---- */

const WL_COLUMNS = [
  { key: "ticker", label: "Ticker", type: "text" },
  { key: "company", label: "Company", type: "text" },
  { key: "price", label: "Price", type: "num" },
  { key: "d1", label: "1D", type: "num" },
  { key: "w1", label: "1W", type: "num", optional: true },
  { key: "m1", label: "1M", type: "num", optional: true },
  { key: "range", label: "", type: "num" },          // label follows the range
  { key: "spark", label: "Trend", type: "none" },
  { key: "score", label: "Score", type: "num" },
  { key: "fromHigh", label: "From high", type: "num", optional: true },
  { key: "added", label: "Added", type: "text", optional: true },
  { key: "act", label: "", type: "none" },
];

const WL_VALUE = {
  ticker: (i) => i.ticker,
  company: (i) => (i.companyName || "").toLowerCase(),
  price: (i) => i.price,
  d1: (i) => changeOf(i, "1D"),
  w1: (i) => changeOf(i, "1W"),
  m1: (i) => changeOf(i, "1M"),
  range: (i) => i.rangePercent,
  score: (i) => (i.overallScore == null ? null : i.overallScore),
  fromHigh: (i) => i.fromHigh52,
  added: (i) => i.createdAt || "",
};

function wlVisibleRows() {
  const items = wlOverview?.items ?? [];
  const q = wlView.q.trim().toLowerCase();
  const cls = wlView.cls;
  const filtered = items.filter((i) => {
    if (cls !== "all" && (i.classification || "unclassified") !== cls) return false;
    if (!q) return true;
    return `${i.ticker} ${i.companyName || ""} ${i.note || ""}`.toLowerCase().includes(q);
  });

  const pick = WL_VALUE[wlView.sort] ?? WL_VALUE.range;
  const dir = wlView.dir === "asc" ? 1 : -1;
  return filtered.sort((a, b) => {
    const va = pick(a);
    const vb = pick(b);
    // Missing data sorts last in both directions: a ticker with no price is not
    // "the smallest mover", it is unknown, and floating it to the top of an
    // ascending sort would read as a fact.
    if (va == null && vb == null) return a.ticker.localeCompare(b.ticker);
    if (va == null) return 1;
    if (vb == null) return -1;
    if (typeof va === "string" || typeof vb === "string") return String(va).localeCompare(String(vb)) * dir;
    return (va - vb) * dir;
  });
}

function wlSortHeader(col) {
  const label = col.key === "range" ? wlView.range : col.label;
  if (col.type === "none") return `<th class="wl-th-${col.key}${col.optional ? " wl-opt" : ""}">${esc(label)}</th>`;
  const on = wlView.sort === col.key;
  const arrow = on ? (wlView.dir === "asc" ? "▲" : "▼") : "";
  return `<th class="wl-th-${col.key} ${col.type === "num" ? "num" : ""}${col.optional ? " wl-opt" : ""}"
      aria-sort="${on ? (wlView.dir === "asc" ? "ascending" : "descending") : "none"}">
      <button type="button" class="wl-sort${on ? " on" : ""}" data-sort="${col.key}">${esc(label)}<span class="wl-arrow">${arrow}</span></button>
    </th>`;
}

function wlRow(i) {
  const rangeCls = wlSign(i.rangePercent);
  const stale = wlOverview?.asOf && i.priceAsOf && i.priceAsOf < wlOverview.asOf;
  return `<tr class="wl-row" data-ticker="${esc(i.ticker)}">
    <td class="wl-c-ticker"><a class="wl-tick" href="/stocks/${encodeURIComponent(i.ticker)}">${esc(i.ticker)}</a>
      ${i.hasReport ? "" : '<span class="wl-noreport" title="No stored report yet — open it to generate one">·</span>'}</td>
    <td class="wl-c-company"><span class="wl-name">${esc(i.companyName || "—")}</span>
      ${i.note ? `<span class="wl-note">${esc(i.note)}</span>` : ""}</td>
    <td class="num wl-c-price">${wlMoney(i.price)}${
      stale ? `<span class="wl-stale" title="Last bar ${esc(i.priceAsOf)}">·</span>` : ""
    }</td>
    <td class="num ${wlSign(changeOf(i, "1D"))}">${wlPct(changeOf(i, "1D"))}</td>
    <td class="num wl-opt ${wlSign(changeOf(i, "1W"))}">${wlPct(changeOf(i, "1W"))}</td>
    <td class="num wl-opt ${wlSign(changeOf(i, "1M"))}">${wlPct(changeOf(i, "1M"))}</td>
    <td class="num ${rangeCls}">${wlPct(i.rangePercent, 1)}</td>
    <!-- Line only, no area fill: a filled sparkline in a dense table row is a
         block of colour, and eight of them stop being marks and become a
         background. -->
    <td class="wl-c-spark">${sparkSvg(i.spark, (i.rangePercent ?? 0) >= 0, "wl-spark", false)}</td>
    <td class="num wl-c-score">${
      i.overallScore == null ? "—" : `<span class="wl-score ${classClass(i.classification)}">${Math.round(i.overallScore)}</span>`
    }</td>
    <td class="num wl-opt">${i.fromHigh52 == null ? "—" : wlPct(i.fromHigh52, 1)}</td>
    <td class="wl-opt wl-c-added">${wlDate(i.createdAt)}</td>
    <td class="wl-c-act"><button class="wl-remove" data-remove="${esc(i.ticker)}" title="Remove ${esc(i.ticker)} from your watchlist" aria-label="Remove ${esc(i.ticker)}">✕</button></td>
  </tr>`;
}

function renderWlTable() {
  const list = document.getElementById("my-list");
  if (!list) return;
  const rows = wlVisibleRows();
  const count = document.getElementById("wl-count");
  if (count) {
    const total = wlOverview?.items.length ?? 0;
    count.textContent = rows.length === total ? `${total} ticker${total === 1 ? "" : "s"}` : `${rows.length} of ${total}`;
  }
  if (!rows.length) {
    list.innerHTML = `<div class="empty">No rows match that filter.</div>`;
    return;
  }
  list.innerHTML = `<div class="wl-tablewrap"><table class="wl-table">
    <thead><tr>${WL_COLUMNS.map(wlSortHeader).join("")}</tr></thead>
    <tbody>${rows.map(wlRow).join("")}</tbody>
  </table></div>`;
}

/** The risk-class filter, built from the classes actually present. */
function renderWlClassFilter() {
  const el = document.getElementById("wl-classes");
  if (!el || !wlOverview) return;
  const present = [...new Set(wlOverview.items.map((i) => i.classification).filter(Boolean))];
  if (!present.includes(wlView.cls) && wlView.cls !== "all") wlView.cls = "all";
  el.innerHTML = ["all", ...present]
    .map((c) => `<button type="button" data-class="${esc(c)}" class="${wlView.cls === c ? "on" : ""}">${
      esc(c === "all" ? "All" : c === "high-risk speculative" ? "high risk" : c)
    }</button>`)
    .join("");
}

function renderWlRanges() {
  for (const b of $$("#wl-ranges button")) b.classList.toggle("on", b.dataset.range === wlView.range);
  const filter = document.getElementById("wl-filter");
  if (filter && filter.value !== wlView.q) filter.value = wlView.q;
}

/* ---- Rendering the tab ---- */

function renderWatchlist() {
  const list = document.getElementById("my-list");
  const dash = document.getElementById("wl-dash");
  const summary = document.getElementById("my-summary");
  if (!list) return;

  if (!wlItems.length) {
    if (dash) dash.hidden = true;
    if (summary) summary.textContent = "";
    list.innerHTML = `<div class="empty">Nothing saved yet. Add a ticker above, or use “+ Watchlist” on any Discover result.</div>`;
    return;
  }

  if (summary) {
    const s = wlOverview?.stats;
    const line = wlOverview
      ? `${wlItems.length} saved · prices from ${wlOverview.source}${wlOverview.asOf ? ` through ${wlOverview.asOf}` : ""}${
          s?.missing.length ? ` · no data for ${s.missing.join(", ")}` : ""
        }${wlOverview.marketError ? ` · market data unavailable (${wlOverview.marketError})` : ""}`
      : `${wlItems.length} ticker${wlItems.length === 1 ? "" : "s"} saved · pricing…`;
    summary.textContent = wlNotice ? `${wlNotice} · ${line}` : line;
  }

  // Before the overview lands (or when market data is down) the plain list is
  // still useful, and is what every add/remove renders instantly.
  if (!wlOverview) {
    if (dash) dash.hidden = true;
    list.innerHTML = wlItems
      .map((i) => `<div class="card wl-plain" data-ticker="${esc(i.ticker)}">
        <a href="/stocks/${encodeURIComponent(i.ticker)}" class="wl-tick">${esc(i.ticker)}</a>
        ${i.note ? `<span class="wl-note">${esc(i.note)}</span>` : ""}
        <button class="wl-remove" data-remove="${esc(i.ticker)}" title="Remove from watchlist">Remove</button>
      </div>`)
      .join("");
    return;
  }

  if (dash) dash.hidden = false;
  renderWlStats();
  renderWlChart();
  renderWlRanges();
  renderWlClassFilter();
  renderWlTable();
}

function renderMyWatchlist(items) {
  wlItems = items;
  myTickers = new Set(items.map((i) => i.ticker));
  // Keep the priced view consistent with membership straight away: a removed
  // row should leave the table on click, not on the next fetch.
  if (wlOverview) {
    wlOverview.items = wlOverview.items.filter((i) => myTickers.has(i.ticker));
    if (!wlOverview.items.length && items.length) wlOverview = null;
  }
  renderWatchlist();
  // Keep Discover buttons in sync with what is now saved.
  document.querySelectorAll("[data-watch]").forEach(syncWatchButton);
  // Adding the open ticker to the watchlist is what unlocks its Regenerate
  // button, so the modal's meta bar has to re-render with it.
  renderReportMeta();
}

function syncWatchButton(btn) {
  const t = btn.dataset.watch;
  const on = myTickers.has(t);
  // The detail modal has room for a fuller label than a Discover card header.
  const long = btn.classList.contains("dl-watch");
  btn.textContent = on
    ? (long ? "✓ On your watchlist" : "✓ Watching")
    : (long ? "+ Add to watchlist" : "+ Watchlist");
  btn.classList.toggle("on", on);
}

async function loadMyWatchlist() {
  const list = document.getElementById("my-list");
  const summary = document.getElementById("my-summary");
  const dash = document.getElementById("wl-dash");
  if (!list) return;
  try {
    const { items } = await wlApi("GET");
    renderMyWatchlist(items || []);
  } catch (e) {
    myTickers = new Set();
    wlItems = [];
    wlOverview = null;
    if (summary) summary.textContent = "";
    if (dash) dash.hidden = true;
    list.innerHTML = e.authRequired
      ? `<div class="empty">Your watchlist is private to your account.<br><button class="primary wl-signin" style="margin-top:.7rem">Sign in to continue</button></div>`
      : `<div class="empty">Could not load your watchlist (${esc(e.message)}).</div>`;
  }
}

/**
 * The priced view. Deliberately separate from the membership fetch: it costs a
 * market request, it can fail on its own, and losing it must never cost the
 * list of what is saved.
 */
async function loadWatchlistOverview() {
  if (wlLoadingOverview) return;
  wlLoadingOverview = true;
  try {
    const res = await fetch(`/api/watchlist/overview?range=${encodeURIComponent(wlView.range)}`, {
      credentials: "same-origin",
    });
    if (!res.ok) throw new Error(String(res.status));
    const data = await res.json();
    if (!data || !Array.isArray(data.items)) return;
    wlOverview = data;
    renderWatchlist();
  } catch {
    // Keep whatever is already on screen; the summary line says what is known.
  } finally {
    wlLoadingOverview = false;
  }
}

/** Everything the tab needs, in the order that puts something on screen first. */
function openWatchlistTab() {
  wlNotice = "";
  loadMyWatchlist();
  loadDigestPrefs();
  loadWatchlistOverview();
}

/* ---- Watchlist controls ---- */

document.addEventListener("click", (e) => {
  const sort = e.target.closest("[data-sort]");
  if (sort) {
    e.preventDefault();
    const key = sort.dataset.sort;
    // Clicking the active column flips it; a new column starts on the reading
    // most people want — biggest first for numbers, A-Z for text.
    if (wlView.sort === key) wlView.dir = wlView.dir === "asc" ? "desc" : "asc";
    else {
      wlView.sort = key;
      wlView.dir = WL_COLUMNS.find((c) => c.key === key)?.type === "text" ? "asc" : "desc";
    }
    persistWatchlistPrefs();
    renderWlTable();
    return;
  }
  const range = e.target.closest("#wl-ranges [data-range]");
  if (range) {
    e.preventDefault();
    if (range.dataset.range === wlView.range) return;
    wlView.range = range.dataset.range;
    persistWatchlistPrefs();
    renderWlRanges();
    loadWatchlistOverview();
    return;
  }
  const cls = e.target.closest("#wl-classes [data-class]");
  if (cls) {
    e.preventDefault();
    wlView.cls = cls.dataset.class;
    persistWatchlistPrefs();
    renderWlClassFilter();
    renderWlTable();
  }
});

document.getElementById("wl-filter")?.addEventListener("input", (e) => {
  wlView.q = e.target.value;
  persistWatchlistPrefs();
  renderWlTable();
});

// The chart is drawn at pixel coordinates, so a resized window needs a redraw.
let wlResizeTimer = null;
window.addEventListener("resize", () => {
  if (!wlOverview) return;
  clearTimeout(wlResizeTimer);
  wlResizeTimer = setTimeout(renderWlChart, 150);
});

async function toggleWatch(ticker) {
  const on = myTickers.has(ticker);
  try {
    const { items } = await wlApi(on ? "DELETE" : "POST", { ticker });
    renderMyWatchlist(items || []);
    // A newly saved ticker has no price yet. The bars for everything else are
    // already cached server-side, so this re-fetch is one symbol's worth.
    if (!on) loadWatchlistOverview();
  } catch (e) {
    if (e.authRequired) { openAuth("login"); return; }
    alert(e.message);
  }
}

/* ---- "Add to watchlist" from the stock detail modal ----
   Signed-in visitors get the same toggle the Discover cards use. Signed-out
   ones get the button too — clicking it explains what an account buys them
   instead of failing with a 401 — and the ticker they wanted is saved for them
   as soon as they sign in. */

function detailWatchButton(ticker) {
  if (!authState.user) {
    return `<button class="wl-toggle dl-watch" data-watch-promo="${esc(ticker)}">+ Add to watchlist</button>`;
  }
  const on = myTickers.has(ticker);
  return `<button class="wl-toggle dl-watch${on ? " on" : ""}" data-watch="${esc(ticker)}">${
    on ? "✓ On your watchlist" : "+ Add to watchlist"
  }</button>`;
}

function watchlistPromo(ticker) {
  return `<div class="ai-promo dl-watch-promo">
    <div class="ai-promo-badge">✨ Free account</div>
    <p class="ai-promo-h">Create a free account to save ${esc(ticker)}</p>
    <ul class="ai-promo-list">
      <li>Your watchlist is private to your account and follows you to any device</li>
      <li><strong>${FREE_CREDITS_PER_MONTH} credits every month, free</strong> — spend them on AI analysis of any ticker</li>
      <li>No card needed; buy more credits with crypto only if you run out</li>
    </ul>
    <button class="primary ai-promo-cta" data-promo-signup>Create a free account</button>
    <p class="ai-promo-alt">Already have one? <a href="#" data-auth-mode-open="login">Sign in</a></p>
  </div>`;
}

function renderDetailWatch() {
  const slot = document.getElementById("dl-watch-slot");
  if (slot && detailTicker) slot.innerHTML = detailWatchButton(detailTicker);
  const promo = document.getElementById("dl-watch-promo");
  if (promo && authState.user) promo.innerHTML = "";
  // Watchlist membership is what unlocks regeneration, so the meta bar has to
  // follow every change to it.
  renderReportMeta();
}

document.addEventListener("click", (e) => {
  const promoBtn = e.target.closest("[data-watch-promo]");
  if (promoBtn) {
    e.preventDefault();
    const ticker = promoBtn.dataset.watchPromo;
    pendingWatch = ticker;
    const slot = document.getElementById("dl-watch-promo");
    if (slot) {
      slot.innerHTML = watchlistPromo(ticker);
      slot.scrollIntoView({ behavior: "smooth", block: "nearest" });
    } else {
      openAuth("signup");
    }
  }
});

// Signing in from the promo finishes the job the visitor started.
window.addEventListener("advis0r:auth-changed", async () => {
  renderDetailWatch();
  if (authState.user && pendingWatch) {
    const ticker = pendingWatch;
    pendingWatch = null;
    await toggleWatchAdd(ticker);
    renderDetailWatch();
  }
});

document.addEventListener("click", (e) => {
  if (e.target.closest(".wl-signin")) { e.preventDefault(); openAuth("login"); return; }
  const add = e.target.closest("#my-add-btn");
  if (add) {
    e.preventDefault();
    const input = document.getElementById("my-add");
    const t = (input?.value || "").trim();
    if (!t) return;
    // "rivian" has to become RIVN before it reaches the watchlist API, which
    // only accepts symbols. An ambiguous name opens the picker instead.
    Promise.resolve(resolveWatchAdd ? resolveWatchAdd(t) : { symbol: t }).then((m) => {
      if (!m) return;
      toggleWatchAdd(m.symbol);
      if (input) input.value = "";
    });
    return;
  }
  const rm = e.target.closest("[data-remove]");
  if (rm) { e.preventDefault(); toggleWatch(rm.dataset.remove); return; }
  const w = e.target.closest("[data-watch]");
  if (w) { e.preventDefault(); toggleWatch(w.dataset.watch); return; }
});

async function toggleWatchAdd(ticker) {
  try {
    const { items } = await wlApi("POST", { ticker });
    renderMyWatchlist(items || []);
    loadWatchlistOverview();
  } catch (e) {
    if (e.authRequired) { openAuth("login"); return; }
    alert(e.message);
  }
}

/* Both boxes accept a company name. Picking from the dropdown acts straight
   away; typing a name and hitting Enter/Add resolves it first. */
const resolveWatchAdd = attachLookup(document.getElementById("my-add"), (m) => toggleWatchAdd(m.symbol));
const resolveSignals = attachLookup(document.getElementById("sig-ticker"), () => runSignals());

document.getElementById("my-add")?.addEventListener("keydown", (e) => {
  // The lookup handler stops propagation when it consumes Enter to pick a row,
  // so reaching here means the user submitted raw text.
  if (e.key === "Enter") document.getElementById("my-add-btn")?.click();
});

/* ---- Watchlist import / export ----
   Export is a plain link to the API with ?format=csv, so the browser handles
   the download and the file is whatever the server says it is. Import posts
   the file's text and lets the server parse it. */

function setMySummary(text) {
  // Held rather than written straight to the element: the tab re-renders its
  // summary line whenever prices land, which would otherwise wipe an import
  // result a second after showing it.
  wlNotice = text;
  const summary = document.getElementById("my-summary");
  if (summary) summary.textContent = text;
}

/** Summarize an import for the user — including what it refused. */
function importSummary(r) {
  const parts = [`Imported ${r.added.length} ticker${r.added.length === 1 ? "" : "s"}`];
  if (r.skipped?.length) parts.push(`${r.skipped.length} already saved`);
  if (r.invalid?.length) parts.push(`${r.invalid.length} not recognized`);
  if (r.capped) parts.push("watchlist full — some were not added");
  return `${parts.join(" · ")}.`;
}

async function importWatchlistFile(file) {
  if (!file) return;
  const text = await file.text().catch(() => "");
  if (!text.trim()) { setMySummary("That file was empty."); return; }
  try {
    const res = await wlApi("POST", { csv: text });
    renderMyWatchlist(res.items || []);
    loadWatchlistOverview();
    setMySummary(importSummary(res));
  } catch (e) {
    if (e.authRequired) { openAuth("login"); return; }
    setMySummary(e.message);
  }
}

document.getElementById("my-import-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  document.getElementById("my-import-file")?.click();
});

document.getElementById("my-import-file")?.addEventListener("change", (e) => {
  const file = e.target.files?.[0];
  e.target.value = ""; // allow re-importing the same file
  importWatchlistFile(file);
});

document.getElementById("my-export-btn")?.addEventListener("click", (e) => {
  e.preventDefault();
  if (!myTickers.size) { setMySummary("Nothing to export yet."); return; }
  window.location.href = "/api/watchlist?format=csv";
});

/* ---- Watchlist email digests ----
   A daily (default) or weekly market summary of the saved tickers, sent when
   pre-market trading opens. Signed-out visitors see the pitch instead of the
   control — there is no per-device setting to offer them. */

const DIGEST_CHOICES = [
  { value: "daily", label: "Daily", hint: "Every trading day" },
  { value: "weekly", label: "Weekly", hint: "Monday mornings" },
  { value: "off", label: "Off", hint: "No emails" },
];

let digestPref = null;

function digestWhen(iso) {
  if (!iso) return "";
  // The send time is defined in market terms, so show it that way rather than
  // in the reader's local zone — "4:00 AM ET" is the promise being made.
  return new Date(iso).toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }) + " ET";
}

function renderDigestPrefs() {
  const el = document.getElementById("email-updates");
  if (!el) return;
  if (!authState.user) { el.innerHTML = ""; return; }
  if (!digestPref) {
    el.innerHTML = `<div class="digest-row"><span class="digest-lab">Email updates</span>
      <span class="digest-next">loading…</span></div>`;
    return;
  }
  const options = DIGEST_CHOICES.map((c) => `<button class="digest-opt${
    digestPref.frequency === c.value ? " on" : ""
  }" data-digest="${c.value}" title="${esc(c.hint)}">${esc(c.label)}</button>`).join("");

  const verified = authState.user.emailVerified;
  const status = !verified
    ? "Verify your email to start receiving updates."
    : digestPref.frequency === "off"
      ? "You are not receiving watchlist emails."
      : `Next: ${digestWhen(digestPref.nextSendAt)} — a market summary of the previous ${
          digestPref.frequency === "weekly" ? "week" : "session"
        }, sent as pre-market opens.`;

  el.innerHTML = `<div class="digest-row">
      <span class="digest-lab">Email updates</span>
      <span class="digest-opts">${options}</span>
    </div>
    <p class="digest-next" id="digest-note">${esc(status)}</p>`;
}

async function loadDigestPrefs() {
  if (!authState.user) { digestPref = null; renderDigestPrefs(); return; }
  try {
    const res = await fetch("/api/digest", { credentials: "same-origin" });
    digestPref = res.ok ? await res.json() : null;
  } catch { digestPref = null; }
  renderDigestPrefs();
}

async function setDigestFrequency(frequency) {
  const previous = digestPref;
  // Optimistic: the control should feel instant, and any failure restores it.
  digestPref = { ...(digestPref || {}), frequency };
  renderDigestPrefs();
  try {
    const res = await fetch("/api/digest", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ frequency }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Could not save that.");
    digestPref = data;
    renderDigestPrefs();
  } catch (e) {
    digestPref = previous;
    renderDigestPrefs();
    const note = document.getElementById("digest-note");
    if (note) note.textContent = e.message;
  }
}

document.addEventListener("click", (e) => {
  const opt = e.target.closest("[data-digest]");
  if (opt) { e.preventDefault(); setDigestFrequency(opt.dataset.digest); }
});

// Opening the tab loads it (see showView); an auth change reloads it, because
// signing in is what turns the prompt into somebody's actual watchlist.
window.addEventListener("advis0r:auth-changed", () => { openWatchlistTab(); });


/* ---- Sign-in promo for the AI analysis paths ----
   AI analysis is a metered LLM call, so it requires a verified account. Rather
   than a bare error, anonymous visitors get the pitch. */

function aiPromo(ticker) {
  return `<h3 class="an-head">Analysis</h3>
    <div class="ai-promo">
      <div class="ai-promo-badge">✨ Free with an account</div>
      <p class="ai-promo-h">Get an AI-sharpened read on ${esc(ticker)}</p>
      <ul class="ai-promo-list">
        <li>A grounded thesis, catalysts and risks — every claim cites stored evidence</li>
        <li>Scores that weigh corroboration across filings, news and media</li>
        <li>Your own saved watchlist, on any device</li>
      </ul>
      <button class="primary ai-promo-cta" data-promo-signup>Create a free account</button>
      <p class="ai-promo-alt">Already have one? <a href="#" data-auth-mode-open="login">Sign in</a></p>
    </div>`;
}

function aiVerifyPrompt() {
  return `<h3 class="an-head">Analysis</h3>
    <div class="ai-promo">
      <p class="ai-promo-h">Verify your email to run AI analysis</p>
      <p class="ai-promo-sub">We sent a link when you signed up. It confirms you're a real person before we spend on model calls.</p>
    </div>`;
}

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-promo-signup]")) { e.preventDefault(); openAuth("signup"); return; }
  const open = e.target.closest("[data-auth-mode-open]");
  if (open) { e.preventDefault(); openAuth(open.dataset.authModeOpen); }
});

/* ---- Crypto ---------------------------------------------------------------
   Backed entirely by /crypto/** (see src/crypto/routes.ts), which rides the
   same Alpaca account as the stock side. Deliberately reuses the existing
   chart, modal and lookup machinery rather than growing a parallel copy — the
   only genuinely different things here are the symbol grammar (BASE/QUOTE),
   the fact that there are no issuer fundamentals to show, and the venue-volume
   caveat that has to travel with the technical score. */

/** The grid's default set: the majors, all USD-quoted. Inside MAX_BASKET (20). */
const CRYPTO_GRID_PAIRS = [
  "BTC/USD", "ETH/USD", "SOL/USD", "XRP/USD", "DOGE/USD", "ADA/USD",
  "LINK/USD", "AVAX/USD", "LTC/USD", "DOT/USD", "BCH/USD", "MATIC/USD",
];

const CRYPTO_REFRESH_MS = 30_000;

/** Sparkline window shown on the cards. Persisted so it survives a reload. */
let cryptoSparkPeriod = (() => {
  try {
    const saved = localStorage.getItem("cx-spark-period");
    return saved === "7d" || saved === "24h" ? saved : "24h";
  } catch {
    // Private mode and blocked storage both throw; the default is fine.
    return "24h";
  }
})();
let cryptoTimer = null;
let cryptoLoading = false;

/** URL-safe pair form: BTC/USD -> BTC-USD. */
const pairSlug = (p) => String(p).replace("/", "-");

/**
 * Crypto spans $0.00001 (SHIB) to $60k (BTC), so a fixed 2dp is useless at one
 * end and noise at the other. Scale the precision to the magnitude.
 */
function fmtPrice(n) {
  if (n == null || !isFinite(n)) return "—";
  const a = Math.abs(n);
  const dp = a >= 1000 ? 2 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
  return "$" + Number(n).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/**
 * Inline SVG sparkline for a card. Returns "" for fewer than two points rather
 * than drawing a flat line, which would imply a price we never observed.
 *
 * viewBox coordinates with preserveAspectRatio="none" so one path stretches to
 * whatever width the card ends up — no measuring, no redraw on resize.
 */
function sparkSvg(points, rising, className = "cx-spark", filled = true) {
  if (!Array.isArray(points) || points.length < 2) return "";
  const w = 100;
  const h = 28;
  const min = Math.min(...points);
  const max = Math.max(...points);
  // A perfectly flat series has no range to scale against; draw it mid-height.
  const span = max - min || 1;
  const x = (i) => (i / (points.length - 1)) * w;
  const y = (v) => h - 1 - ((v - min) / span) * (h - 2);
  const line = points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("");
  const stroke = rising ? "var(--pos)" : "var(--neg)";
  return `<svg class="${className}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
    ${filled ? `<path d="${line}L${w},${h}L0,${h}Z" fill="${stroke}" fill-opacity=".12"/>` : ""}
    <path d="${line}" fill="none" stroke="${stroke}" stroke-width="1.5"
          vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
  </svg>`;
}

function cryptoCard(s, spark) {
  const chg = s.change;
  const dir = chg == null ? "" : chg.percent >= 0 ? "positive" : "negative";
  const price = s.latestTrade?.price ?? s.dailyBar?.close;
  const q = s.latestQuote;
  const spreadBps = q && q.askPrice && q.bidPrice
    ? ((q.askPrice - q.bidPrice) / ((q.askPrice + q.bidPrice) / 2)) * 10000
    : null;
  // The sparkline is coloured by its OWN period's direction, which is not
  // always the session's: a pair can be down today inside a rising week, and
  // painting the 7d line red because the day was red would misreport it.
  const sparkRising = spark?.changePercent == null ? chg == null || chg.percent >= 0 : spark.changePercent >= 0;
  // An anchor, not a button: this has to be shareable, middle-clickable and
  // crawlable. The destination renders server-side, so it works before this
  // script has run at all.
  return `<a class="cxcard ${dir}" href="/crypto/${esc(pairSlug(s.symbol))}">
    <div class="cx-top">
      <span class="cx-sym">${esc(s.base)}</span>
      <span class="cx-quote">/${esc(s.quote)}</span>
      <span class="cx-name">${esc(s.name || "")}</span>
    </div>
    <div class="cx-price">${fmtPrice(price)}</div>
    ${sparkSvg(spark?.points, sparkRising)}
    <div class="cx-sub">
      ${chg == null ? '<span class="cx-dim">—</span>'
        : `<span class="sig-dir ${dir}">${chg.percent >= 0 ? "+" : ""}${chg.percent.toFixed(2)}%</span>`}
      ${spark?.changePercent != null
        ? `<span class="cx-sparkchg ${spark.changePercent >= 0 ? "pos" : "neg"}" title="Change over the selected period">${spark.changePercent >= 0 ? "+" : ""}${spark.changePercent.toFixed(1)}%</span>`
        : ""}
      ${spreadBps != null ? `<span class="cx-spread" title="Bid/ask spread">${spreadBps.toFixed(1)} bps</span>` : ""}
    </div>
  </a>`;
}

async function loadCryptoGrid() {
  // Guard against a slow response overlapping the 30s auto-refresh tick.
  if (cryptoLoading) return;
  cryptoLoading = true;
  const grid = $("#cx-grid");
  const summary = $("#cx-summary");
  if (!grid) { cryptoLoading = false; return; }
  if (!grid.dataset.loaded) grid.innerHTML = `<div class="spinner"></div>`;
  const symbols = encodeURIComponent(CRYPTO_GRID_PAIRS.join(","));
  try {
    // Prices are the point of the grid; the sparklines are decoration on top.
    // Fetched together, but the chart request is allowed to fail on its own —
    // losing the lines is not a reason to lose the prices.
    const [d, sparkRes] = await Promise.all([
      api(`/crypto/snapshot?symbols=${symbols}`),
      api(`/crypto/sparklines?symbols=${symbols}&period=${cryptoSparkPeriod}`).catch(() => null),
    ]);
    const series = sparkRes?.series ?? {};
    const rows = (d.snapshots || []).filter((s) => s.latestTrade || s.dailyBar);
    grid.innerHTML = rows.length
      ? rows.map((s) => cryptoCard(s, series[s.symbol])).join("")
      : `<p class="empty">No crypto prices available right now.</p>`;
    grid.dataset.loaded = "1";
    if (summary) {
      const charted = rows.filter((s) => series[s.symbol]).length;
      summary.textContent =
        `${rows.length} pairs · Alpaca US crypto venue · updated ${new Date().toLocaleTimeString()}` +
        // Say when the lines are missing rather than leaving bare cards that
        // read as a rendering bug.
        (charted === rows.length ? "" : ` · ${rows.length - charted} without ${cryptoSparkPeriod} history`);
    }
  } catch (e) {
    // Never blank an already-painted grid on a refresh failure — a transient
    // blip should not look like the market vanished.
    if (!grid.dataset.loaded) grid.innerHTML = `<p class="empty">Could not load crypto prices (${esc(e.message)}).</p>`;
    if (summary) summary.textContent = `Refresh failed (${e.message}) — showing the last good prices.`;
  } finally {
    cryptoLoading = false;
  }
}

/** Auto-refresh only while the tab is actually being looked at. */
function setCryptoAuto(on) {
  clearInterval(cryptoTimer);
  cryptoTimer = null;
  if (!on) return;
  cryptoTimer = setInterval(() => {
    const visible = document.visibilityState === "visible" &&
      document.querySelector('.view[data-view="crypto"]')?.classList.contains("active");
    if (visible) loadCryptoGrid();
  }, CRYPTO_REFRESH_MS);
}

/* Same widget as the ticker boxes, pointed at the crypto directory. A bare
   "BTC" is NOT treated as already-a-symbol: it goes through lookup so the
   dropdown can offer BTC/USD, BTC/USDT and BTC/USDC rather than guessing. */
attachLookup(
  document.getElementById("cx-find"),
  (m) => { location.href = `/crypto/${pairSlug(m.symbol)}`; },
  {
    url: (q) => `/crypto/lookup?q=${encodeURIComponent(q)}&limit=8`,
    meta: (m) => esc(m.quote || ""),
    isSymbol: (q) => /^[A-Za-z0-9]{2,6}[/-][A-Za-z]{3,4}$/.test(q),
  },
);

$("#cx-refresh")?.addEventListener("click", loadCryptoGrid);
$("#cx-auto")?.addEventListener("change", (e) => setCryptoAuto(e.target.checked));

/** Reflect the active sparkline window in the toggle. */
function paintCryptoPeriod() {
  $$("#cx-period-group button, .cx-period button").forEach((b) =>
    b.classList.toggle("on", b.dataset.period === cryptoSparkPeriod),
  );
}

$(".cx-period")?.addEventListener("click", (e) => {
  const b = e.target.closest("[data-period]");
  if (!b || b.dataset.period === cryptoSparkPeriod) return;
  cryptoSparkPeriod = b.dataset.period;
  try {
    localStorage.setItem("cx-spark-period", cryptoSparkPeriod);
  } catch {
    /* not worth failing the interaction over */
  }
  paintCryptoPeriod();
  // Force a repaint even though prices have not changed: the cached grid was
  // drawn for the other window.
  const grid = $("#cx-grid");
  if (grid) delete grid.dataset.loaded;
  loadCryptoGrid();
});
paintCryptoPeriod();
