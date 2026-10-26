/* Authentication UI (PRD v3 §7).

   Accounts only — nothing in the app is gated. Signing in is optional and the
   watchlist, search and signals views work exactly as before without it. */

const authState = { user: null };

const aEsc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function authApi(path, body) {
  const res = await fetch(path, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    credentials: "same-origin",
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function refreshAuth() {
  try {
    const r = await authApi("/api/auth/me");
    authState.user = r.user;
  } catch {
    authState.user = null;
  }
  renderAuthBar();
  // Views that depend on the signed-in user (the saved watchlist) listen for
  // this rather than polling.
  window.dispatchEvent(new CustomEvent("advis0r:auth-changed"));
}

function renderAuthBar() {
  const el = document.getElementById("authbar");
  if (!el) return;
  const u = authState.user;
  el.innerHTML = u
    ? `<span class="auth-who" title="${aEsc(u.email)}">${aEsc(u.displayName || u.email)}</span>${
        u.emailVerified ? "" : ' <span class="auth-unverified" title="Check your inbox for the verification link">unverified</span>'
      } <button class="auth-link" id="auth-logout">Sign out</button>`
    : `<button class="auth-link" id="auth-signin">Sign in</button>`;
}

/* ---- modal ---- */

function closeAuth() {
  document.getElementById("auth-modal")?.remove();
}

function openAuth(mode = "login", prefill = {}) {
  closeAuth();
  const el = document.createElement("div");
  el.id = "auth-modal";
  el.className = "modal";
  el.innerHTML = `<div class="modal-backdrop" data-auth-close></div>
    <div class="modal-panel auth-panel"><div id="auth-body"></div></div>`;
  document.body.appendChild(el);
  renderAuthForm(mode, prefill);
}

function authNote(msg, kind = "info") {
  const n = document.getElementById("auth-note");
  if (n) n.innerHTML = `<p class="auth-note ${kind}">${aEsc(msg)}</p>`;
}

function renderAuthForm(mode, prefill = {}) {
  const body = document.getElementById("auth-body");
  if (!body) return;
  const email = aEsc(prefill.email || "");

  const forms = {
    login: `
      <h2 class="auth-h">Sign in</h2>
      <label class="auth-l">Email<input id="auth-email" type="email" autocomplete="email" value="${email}" required></label>
      <label class="auth-l">Password<input id="auth-password" type="password" autocomplete="current-password" required></label>
      <div id="auth-note"></div>
      <button class="primary auth-submit" id="auth-do-login">Sign in</button>
      <p class="auth-alt"><a href="#" data-auth-mode="signup">Create an account</a> · <a href="#" data-auth-mode="forgot">Forgot password?</a></p>`,
    signup: `
      <h2 class="auth-h">Create an account</h2>
      <label class="auth-l">Email<input id="auth-email" type="email" autocomplete="email" value="${email}" required></label>
      <div id="auth-profile"></div>
      <label class="auth-l">Password<input id="auth-password" type="password" autocomplete="new-password" required>
        <span class="auth-hint">At least 10 characters. A memorable passphrase beats a short complex one.</span></label>
      <div id="auth-note"></div>
      <button class="primary auth-submit" id="auth-do-signup">Create account</button>
      <p class="auth-alt"><a href="#" data-auth-mode="login">I already have an account</a></p>`,
    forgot: `
      <h2 class="auth-h">Reset your password</h2>
      <p class="auth-sub">We'll email you a link to choose a new password.</p>
      <label class="auth-l">Email<input id="auth-email" type="email" autocomplete="email" value="${email}" required></label>
      <div id="auth-note"></div>
      <button class="primary auth-submit" id="auth-do-forgot">Send reset link</button>
      <p class="auth-alt"><a href="#" data-auth-mode="login">Back to sign in</a></p>`,
    reset: `
      <h2 class="auth-h">Choose a new password</h2>
      <label class="auth-l">New password<input id="auth-password" type="password" autocomplete="new-password" required>
        <span class="auth-hint">At least 10 characters.</span></label>
      <div id="auth-note"></div>
      <button class="primary auth-submit" id="auth-do-reset">Set new password</button>`,
  };
  body.innerHTML = forms[mode] || forms.login;
  // Signup only: the shared profile fields (names, company, title, LinkedIn),
  // rendered by the server into <template id="pfs-signup-fields">.
  const tpl = document.getElementById("pfs-signup-fields");
  const slot = document.getElementById("auth-profile");
  if (slot && tpl) slot.replaceWith(tpl.content.cloneNode(true));
  body.querySelector("input")?.focus();
}

function busy(id, on, label) {
  const b = document.getElementById(id);
  if (!b) return;
  b.disabled = on;
  b.textContent = on ? "Working…" : label;
}

/* ---- actions ---- */

async function doSignup() {
  const email = document.getElementById("auth-email")?.value.trim();
  const password = document.getElementById("auth-password")?.value ?? "";
  const profile = {};
  document.querySelectorAll("#auth-body .pfs-profile input").forEach((i) => (profile[i.name] = i.value.trim()));
  busy("auth-do-signup", true, "Create account");
  try {
    const r = await authApi("/api/auth/signup", { ...profile, email, password });
    authNote(r.message || "Check your email for a verification link.", "ok");
    // Only present when no mail transport is configured (local development).
    if (r.devVerifyUrl) authNote(`Dev mode — verify here: ${r.devVerifyUrl}`, "ok");
  } catch (e) {
    authNote(e.message, "bad");
  } finally {
    busy("auth-do-signup", false, "Create account");
  }
}

async function doLogin() {
  const email = document.getElementById("auth-email")?.value.trim();
  const password = document.getElementById("auth-password")?.value ?? "";
  busy("auth-do-login", true, "Sign in");
  try {
    await authApi("/api/auth/login", { email, password });
    await refreshAuth();
    closeAuth();
  } catch (e) {
    authNote(e.message, "bad");
  } finally {
    busy("auth-do-login", false, "Sign in");
  }
}

async function doForgot() {
  const email = document.getElementById("auth-email")?.value.trim();
  busy("auth-do-forgot", true, "Send reset link");
  try {
    const r = await authApi("/api/auth/request-reset", { email });
    authNote(r.message || "If that address has an account, a reset link is on its way.", "ok");
    if (r.devResetUrl) authNote(`Dev mode — reset here: ${r.devResetUrl}`, "ok");
  } catch (e) {
    authNote(e.message, "bad");
  } finally {
    busy("auth-do-forgot", false, "Send reset link");
  }
}

async function doReset(token) {
  const password = document.getElementById("auth-password")?.value ?? "";
  busy("auth-do-reset", true, "Set new password");
  try {
    await authApi("/api/auth/reset", { token, password });
    authNote("Password updated. You can sign in now.", "ok");
    setTimeout(() => renderAuthForm("login"), 1200);
  } catch (e) {
    authNote(e.message, "bad");
  } finally {
    busy("auth-do-reset", false, "Set new password");
  }
}

/* ---- email link landing pages ---- */

async function handleAuthLanding() {
  const url = new URL(location.href);
  // /i/<code> and /invites send people here to sign up or sign in.
  if (url.searchParams.get("signup") === "1" || url.searchParams.get("signin") === "1") {
    const signup = url.searchParams.get("signup") === "1";
    const invited = url.searchParams.get("invited") === "1";
    url.searchParams.delete("signup");
    url.searchParams.delete("signin");
    url.searchParams.delete("invited");
    history.replaceState({}, "", url.pathname + url.search);
    openAuth(signup ? "signup" : "login");
    if (signup && invited) {
      authNote("You were invited: your bonus credits arrive when you confirm your email.", "ok");
    }
    return;
  }
  const token = url.searchParams.get("token");
  if (!token) return;

  if (url.pathname === "/verify") {
    openAuth("login");
    const body = document.getElementById("auth-body");
    if (body) body.innerHTML = `<h2 class="auth-h">Verifying your email…</h2><div id="auth-note"></div>`;
    try {
      const r = await authApi("/api/auth/verify", { token });
      await refreshAuth();
      if (body) body.innerHTML = `<h2 class="auth-h">Email verified</h2><div id="auth-note"></div>`;
      authNote(
        r.inviteBonus > 0
          ? `Your email address is confirmed, and your invite added ${r.inviteBonus} credits. You can sign in.`
          : "Your email address is confirmed. You can sign in.",
        "ok",
      );
      setTimeout(() => renderAuthForm("login"), 1500);
    } catch (e) {
      authNote(e.message, "bad");
    }
    history.replaceState({}, "", "/");
  }

  if (url.pathname === "/reset") {
    openAuth("reset");
    document.getElementById("auth-body")?.addEventListener("submit", (e) => e.preventDefault());
    window.__resetToken = token;
    history.replaceState({}, "", "/");
  }
}

/* ---- wiring ---- */

document.addEventListener("click", (e) => {
  if (e.target.closest("[data-auth-close]")) { closeAuth(); return; }
  if (e.target.id === "auth-signin") { e.preventDefault(); openAuth("login"); return; }
  if (e.target.id === "auth-logout") {
    e.preventDefault();
    authApi("/api/auth/logout", {}).finally(refreshAuth);
    return;
  }
  const mode = e.target.closest("[data-auth-mode]");
  if (mode) { e.preventDefault(); renderAuthForm(mode.dataset.authMode); return; }
  if (e.target.id === "auth-do-login") { e.preventDefault(); doLogin(); }
  if (e.target.id === "auth-do-signup") { e.preventDefault(); doSignup(); }
  if (e.target.id === "auth-do-forgot") { e.preventDefault(); doForgot(); }
  if (e.target.id === "auth-do-reset") { e.preventDefault(); doReset(window.__resetToken); }
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeAuth();
  if (e.key === "Enter" && document.getElementById("auth-modal")) {
    document.querySelector(".auth-submit")?.click();
  }
});

refreshAuth();
handleAuthLanding();

/* ---- Credits (PRD v3 §8) ----
   Free plan grants 100 credits/month; AI analysis spends them; more are bought
   with crypto via CoinPayPortal. */

let creditState = null;

async function refreshCredits() {
  if (!authState.user) { creditState = null; renderCredits(); return; }
  try {
    const r = await fetch("/api/credits", { credentials: "same-origin" });
    creditState = r.ok ? await r.json() : null;
  } catch { creditState = null; }
  renderCredits();
}

function renderCredits() {
  const el = document.getElementById("creditbar");
  if (!el) return;
  if (!creditState) { el.innerHTML = ""; return; }
  const low = creditState.balance <= 10;
  el.innerHTML = `<button class="credit-chip${low ? " low" : ""}" id="credits-open"
    title="${creditState.balance} credits · ${creditState.freeMonthlyCredits} free each month">
    ${creditState.balance} <span class="credit-lab">credits</span></button>`;
}

function openCredits() {
  if (!creditState) return;
  closeAuth();
  const el = document.createElement("div");
  el.id = "auth-modal";
  el.className = "modal";
  const pkgs = (creditState.packages || []).map((p) => `
    <button class="credit-pkg" data-buy="${aEsc(p.id)}">
      <span class="credit-pkg-c">${p.credits.toLocaleString()} credits</span>
      <span class="credit-pkg-p">$${p.usd}</span>
      <span class="credit-pkg-r">${(p.usd / p.credits * 100).toFixed(2)}¢ each</span>
    </button>`).join("");
  el.innerHTML = `<div class="modal-backdrop" data-auth-close></div>
    <div class="modal-panel auth-panel">
      <h2 class="auth-h">Credits</h2>
      <p class="auth-sub">You have <strong>${creditState.balance}</strong> credits.
        Every account gets ${creditState.freeMonthlyCredits} free each month
        (${creditState.spentThisPeriod} used in ${aEsc(creditState.period)}).
        One credit runs one AI analysis.</p>
      ${creditState.paymentsEnabled
        ? `<p class="auth-sub">Top up with crypto or PayPal, paid through CoinPay.</p>
           <div class="credit-pkgs">${pkgs}</div>`
        : `<p class="auth-note">Credit purchases are not available right now.</p>`}
      <h3 class="auth-h">Have a code?</h3>
      <label class="auth-l">Credit code<input id="credit-code" type="text" maxlength="48"
        placeholder="ADV-XXXX-XXXX-XXXX-XXXX" autocomplete="off"></label>
      <button class="primary" id="credit-redeem">Redeem</button>
      <p class="auth-sub"><a href="/invites">Invite friends</a>: you both get bonus credits.</p>
      <div id="auth-note"></div>
    </div>`;
  document.body.appendChild(el);
}

async function buyCredits(packageId) {
  authNote("Creating payment…");
  try {
    const res = await fetch("/api/credits/checkout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ packageId }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || "Could not start the payment.");
    // CoinPay's hosted checkout takes any coin or PayPal and sends the buyer
    // back here; credits land via the signed webhook once it confirms.
    authNote("Opening CoinPay checkout. Credits arrive once the payment confirms.", "ok");
    const url = d.checkoutUrl || d.paymentUrl;
    window.location.href = url;
  } catch (e) {
    authNote(e.message, "bad");
  }
}

async function redeemCreditCode() {
  const code = document.getElementById("credit-code")?.value.trim();
  if (!code) return;
  busy("credit-redeem", true, "Redeem");
  try {
    const d = await authApi("/api/credits/redeem", { code });
    authNote(
      d.monthly
        ? `Redeemed: ${d.credits} credits a month${d.months ? ` for ${d.months} months` : ""}. Balance: ${d.balance}.`
        : `Redeemed: ${d.credits} credits. Balance: ${d.balance}.`,
      "ok",
    );
    window.dispatchEvent(new CustomEvent("advis0r:credits-changed"));
  } catch (e) {
    authNote(e.message, "bad");
  } finally {
    busy("credit-redeem", false, "Redeem");
  }
}

document.addEventListener("click", (e) => {
  if (e.target.closest("#credits-open")) { e.preventDefault(); openCredits(); return; }
  if (e.target.id === "credit-redeem") { e.preventDefault(); redeemCreditCode(); return; }
  const buy = e.target.closest("[data-buy]");
  if (buy) { e.preventDefault(); buyCredits(buy.dataset.buy); }
});

window.addEventListener("advis0r:auth-changed", refreshCredits);
// Analysis spends a credit, so the displayed balance must follow it.
window.addEventListener("advis0r:credits-changed", refreshCredits);
refreshCredits();
