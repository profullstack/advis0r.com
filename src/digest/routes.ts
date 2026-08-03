/**
 * HTTP surface for email digests.
 *
 *   GET  /api/digest              -> the signed-in user's frequency + next send
 *   POST /api/digest              -> { frequency: daily | weekly | off }
 *   GET  /unsubscribe?token=...   -> standalone confirmation page (no JS, no login)
 *   POST /unsubscribe?token=...   -> RFC 8058 one-click target
 *
 * The unsubscribe endpoints deliberately require no session: someone who has
 * lost access to their account must still be able to stop the mail, and a mail
 * client performing a one-click unsubscribe has no cookies to send.
 */
import type { Client } from "@libsql/client";
import { SESSION_COOKIE, readCookie } from "../auth/routes.ts";
import { userForSession } from "../auth/service.ts";
import { getPreference, setPreference, unsubscribeByToken } from "./preferences.ts";
import { escapeHtml } from "./render.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export interface DigestRouteDeps {
  db: Client;
  appUrl: string;
}

export async function handleDigestRoute(
  req: Request,
  path: string,
  deps: DigestRouteDeps,
): Promise<Response | null> {
  if (path === "/unsubscribe") return unsubscribeResponse(req, deps);
  if (path !== "/api/digest") return null;

  const user = await userForSession(deps.db, readCookie(req, SESSION_COOKIE));
  if (!user) {
    return json({ error: "Sign in to manage email updates.", authRequired: true }, 401);
  }

  if (req.method === "GET") {
    return json(await getPreference(deps.db, user.id));
  }

  if (req.method === "POST") {
    let body: Record<string, unknown> = {};
    try {
      body = ((await req.json()) ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const result = await setPreference(deps.db, user.id, body.frequency);
    if (!result.ok) return json({ error: result.error }, 400);
    return json({ ok: true, ...result.preference });
  }

  return json({ error: "method not allowed" }, 405);
}

/**
 * Unsubscribe by token.
 *
 * **GET never changes anything.** It renders a confirmation page whose button
 * POSTs. This is not ceremony: corporate link scanners, antivirus proxies and
 * client-side prefetchers routinely fetch every URL in an email, and a
 * destructive GET means those fetches silently unsubscribe people who never
 * clicked. The POST path is the real action, and it is also exactly what an RFC
 * 8058 one-click client sends — so a mail client's built-in unsubscribe button
 * still works in a single step, with no page to visit.
 *
 * An unknown token is reported as "nothing to do" rather than an error. An
 * unsubscribe URL is a public string; confirming which ones are real would make
 * this an account-existence oracle.
 */
async function unsubscribeResponse(req: Request, deps: DigestRouteDeps): Promise<Response> {
  if (req.method !== "GET" && req.method !== "POST") {
    return json({ error: "method not allowed" }, 405);
  }
  const url = new URL(req.url);
  let token = url.searchParams.get("token") ?? "";

  if (req.method === "GET") {
    return page(deps.appUrl, confirmBody(token));
  }

  if (!token) {
    // One-click clients put the token in the query string; a browser form posts
    // it in the body.
    const form = await req.formData().catch(() => null);
    token = String(form?.get("token") ?? "");
  }
  const result = await unsubscribeByToken(deps.db, token);

  const accept = req.headers.get("accept") ?? "";
  if (accept.includes("application/json")) {
    return json({ ok: true, unsubscribed: result.ok });
  }
  if (!accept.includes("text/html")) {
    // RFC 8058 expects a bare 200; no human ever sees this body.
    return new Response("OK", { status: 200, headers: { "content-type": "text/plain" } });
  }
  return page(deps.appUrl, resultBody(result));
}

function confirmBody(token: string): string {
  return `<h1>Turn off watchlist emails?</h1>
    <p>You will stop receiving the daily or weekly market summary of your saved tickers.</p>
    <p class="sub">Your account and watchlist stay exactly as they are, and you can turn updates back on any time.</p>
    <form method="POST" action="/unsubscribe">
      <input type="hidden" name="token" value="${escapeHtml(token)}">
      <button class="cta" type="submit">Yes, unsubscribe</button>
    </form>`;
}

function resultBody(result: { ok: boolean; email?: string }): string {
  return result.ok
    ? `<h1>Email updates are off</h1>
       <p>We've stopped sending watchlist digests${result.email ? ` to <strong>${escapeHtml(result.email)}</strong>` : ""}.</p>
       <p class="sub">Your account and saved watchlist are untouched. You can turn daily or weekly updates back on any time from the Watchlist tab.</p>`
    : `<h1>Nothing to do</h1>
       <p>That unsubscribe link has already been used, or it belongs to an address we no longer mail.</p>
       <p class="sub">If you are still receiving updates, sign in and set email updates to &ldquo;off&rdquo; on the Watchlist tab.</p>`;
}

function page(appUrl: string, body: string): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="robots" content="noindex">
      <title>Email updates — advis0r.com</title>
      <style>
        body{margin:0;background:#0a0e14;color:#d7dee8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:24px}
        .card{max-width:460px;background:#111823;border:1px solid #1c2430;border-radius:12px;padding:28px}
        .brand{font-size:18px;font-weight:600;margin-bottom:18px}
        .brand span{opacity:.5}
        h1{font-size:18px;margin:0 0 10px}
        p{line-height:1.6;color:#a8b3c1;margin:0 0 12px;font-size:14px}
        .sub{color:#8b95a5;font-size:13px}
        .cta{display:inline-block;margin-top:8px;background:#2f81f7;color:#fff;text-decoration:none;padding:10px 16px;border-radius:7px;font-weight:500;font-size:14px;border:0;font-family:inherit;cursor:pointer}
        .back{display:inline-block;margin-top:14px;color:#8b95a5;font-size:13px}
      </style></head>
      <body><div class="card">
        <div class="brand">advis0r<span>.com</span></div>
        ${body}
        <a class="back" href="${escapeHtml(appUrl.replace(/\/$/, ""))}/">Back to advis0r.com</a>
      </div></body></html>`,
    { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } },
  );
}
