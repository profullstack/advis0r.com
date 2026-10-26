/**
 * Server-rendered invite pages.
 *
 *   GET /invites     -> your invites, your ?ref= link, and "Have a code?"
 *   GET /i/<code>    -> invite landing: remembers the code, then sign up
 *
 * /i/<code> is public and unmetered (nothing here spends anything), and it
 * never says whether a code is valid: that is decided once, when the invited
 * account confirms its email.
 */
import type { Client } from "@libsql/client";
import { readCookie, SESSION_COOKIE } from "../auth/routes.ts";
import { userForSession } from "../auth/service.ts";
import { shell } from "../reports/page.ts";
import { escapeHtml as e } from "../util/html.ts";
import { canonicalInvite, cleanRef, INVITE_COOKIE, inviteBonusCredits, inviteSummary, originFor, REF_COOKIE } from "./codes.ts";

export interface InvitePageDeps {
  db: Client;
  appUrl: string;
  secureCookies: boolean;
}

const html = (body: string, status = 200, headers: Record<string, string> = {}) =>
  new Response(body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...headers },
  });

function cookie(name: string, value: string, maxAgeDays: number, secure: boolean): string {
  return [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeDays * 86_400}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/**
 * First-touch ?ref= on any page: remembered for 30 days in the shared
 * `referral_code` cookie, never overwriting one already set.
 */
export function refCookieFor(req: Request, secure: boolean): string | null {
  const url = new URL(req.url);
  const ref = cleanRef(url.searchParams.get("ref"));
  if (!ref || readCookie(req, REF_COOKIE)) return null;
  return cookie(REF_COOKIE, ref, 30, secure);
}

export async function handleInvitePages(req: Request, path: string, deps: InvitePageDeps): Promise<Response | null> {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const origin = originFor(deps.appUrl, req.url);

  if (path.startsWith("/i/")) {
    const code = canonicalInvite(decodeURIComponent(path.slice(3)));
    const bonus = inviteBonusCredits();
    const body = code
      ? `<section class="rp-head"><h1>You're invited to advis0r</h1>
          <p class="hint">Someone with an account sent you this invite. advis0r reads what executives
          actually said on earnings calls and in the news, and turns it into an evidence-backed research
          watchlist. Every free account gets 100 credits a month for AI analysis${
            bonus > 0 ? `, and an invited account starts with <strong>${bonus} extra credits</strong> once its email is confirmed` : ""
          }.</p>
          <form action="/" method="get"><input type="hidden" name="signup" value="1"><input type="hidden" name="invited" value="1">
          <button class="primary">Create your free account</button></form>
          <p class="hint">Already have an account? Invites are for new accounts, so there is nothing to do here.
          <a href="/">Go to advis0r</a>.</p></section>`
      : `<section class="rp-head"><h1>That invite link looks wrong</h1>
          <p class="hint">Check that the whole link was copied. Invite codes look like INV-XXXX-XXXX-XXXX.</p>
          <p><a href="/">Go to advis0r</a></p></section>`;
    const page = shell(
      {
        title: "You're invited to advis0r",
        description: "An invite to advis0r.com: evidence-backed stock research from what executives said.",
        canonical: `${origin}/`,
        robots: "noindex",
      },
      body,
    );
    return html(page, code ? 200 : 404, code ? { "set-cookie": cookie(INVITE_COOKIE, code, 30, deps.secureCookies) } : {});
  }

  if (path !== "/invites") return null;
  const user = await userForSession(deps.db, readCookie(req, SESSION_COOKIE));
  const meta = { title: "Invites and credit codes · advis0r", description: "Invite people to advis0r and redeem credit codes.", canonical: `${origin}/invites`, robots: "noindex" };
  if (!user) {
    return html(shell(meta, `<section class="rp-head"><h1>Invites</h1>
      <p class="hint">Sign in to see your invites and redeem a credit code.</p>
      <form action="/" method="get"><input type="hidden" name="signin" value="1"><button class="primary">Sign in</button></form></section>`));
  }
  const s = await inviteSummary(deps.db, user.id, origin);
  const rows = s.invites.length
    ? s.invites
        .map(
          (i) => `<li>${e(i.note || "Invite")} · ${i.used ? "joined" : i.revoked ? "withdrawn" : "unused"} ·
            created ${e(String(i.createdAt).slice(0, 10))}${i.expiresAt && !i.used ? `, expires ${e(String(i.expiresAt).slice(0, 10))}` : ""}</li>`,
        )
        .join("")
    : "<li>No invites yet.</li>";
  const body = `<section class="rp-head"><h1>Invites</h1>
    <p class="hint">Invites are scarce: you have <strong id="inv-left">${s.quota.left}</strong> of ${s.quota.total} left.
    Each link works once, for a new account.${
      s.bonusCredits > 0
        ? ` When the person you invite confirms their email, you both get <strong>${s.bonusCredits} credits</strong>.`
        : ""
    }</p>
    ${
      user.emailVerified
        ? `<p><input id="inv-note" type="text" maxlength="120" placeholder="Who is it for? (only you see this)">
           <button class="primary" id="inv-create"${s.quota.left > 0 ? "" : " disabled"}>Create invite link</button></p>`
        : `<p class="auth-note bad">Verify your email address to create invites.</p>`
    }
    <p id="inv-out" class="auth-note"></p>
    <ul class="hint" id="inv-list">${rows}</ul>
    <p class="hint">${s.joined} ${s.joined === 1 ? "person has" : "people have"} joined from your invites.</p>
    <h2>Your link</h2>
    <p class="hint">Open, unlimited, no bonus: <code>${e(s.affiliateUrl)}</code></p>
    <h2 id="code">Have a code?</h2>
    <p class="hint">A credit code adds credits to this account.</p>
    <p><input id="code-in" type="text" maxlength="48" placeholder="ADV-XXXX-XXXX-XXXX-XXXX" autocomplete="off">
       <button class="primary" id="code-go">Redeem</button></p>
    <p id="code-out" class="auth-note"></p>
  </section>
  <script>
  (function () {
    const $ = (id) => document.getElementById(id);
    const say = (el, msg, ok) => { el.textContent = msg; el.className = "auth-note " + (ok ? "ok" : "bad"); };
    async function post(path, body) {
      const r = await fetch(path, { method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || "Something went wrong.");
      return d;
    }
    $("inv-create") && $("inv-create").addEventListener("click", async () => {
      try {
        const d = await post("/api/invites", { note: $("inv-note").value });
        say($("inv-out"), "Send this link: " + d.url, true);
        $("inv-left").textContent = d.quota.left;
        if (d.quota.left <= 0) $("inv-create").disabled = true;
      } catch (err) { say($("inv-out"), err.message, false); }
    });
    $("code-go").addEventListener("click", async () => {
      try {
        const d = await post("/api/credits/redeem", { code: $("code-in").value });
        say($("code-out"), d.monthly
          ? "Redeemed: " + d.credits + " credits a month" + (d.months ? " for " + d.months + " months" : "") + ". Balance: " + d.balance + "."
          : "Redeemed: " + d.credits + " credits. Balance: " + d.balance + ".", true);
      } catch (err) { say($("code-out"), err.message, false); }
    });
  })();
  </script>`;
  return html(shell(meta, body));
}
