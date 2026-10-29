/**
 * Sign in with CoinPay (2026-10-29). CoinPay is the fleet's master account: a
 * CoinPay user can sign in here, and a signed-in user can connect their CoinPay
 * account to this one.
 *
 *   GET  /api/v1/coinpay/oauth/start?mode=login|link   302 to CoinPay
 *   GET  /api/v1/coinpay/oauth/callback                CoinPay redirects back here
 *   POST /api/v1/coinpay/disconnect                    signed in; refused when it is the only way in
 *
 * Authorization code + PKCE (S256) + state + nonce as a confidential client;
 * the code exchange, id_token claim checks and userinfo come from
 * @profullstack/coinpay-onboard/oauth.
 *
 * STANDING rule: the account binds to the CoinPay `sub` only. The CoinPay email
 * is unverified (CoinPay never verifies it), so it is never matched against an
 * existing account, never stored as users.email and never grants anything. A
 * first CoinPay sign-in with no linked account creates a new account with an
 * unroutable placeholder address; linking to an existing account happens only
 * from inside that account (mode=link, which needs a session).
 */
import type { Client } from "@libsql/client";
import {
  authorizeUrl,
  finishSignIn,
  pkce,
  randomToken,
  sameState,
  SIGN_IN_SCOPES,
} from "@profullstack/coinpay-onboard/oauth";
import { hashToken, newId } from "./crypto.ts";
import { clientIp, readCookie, SESSION_COOKIE, sessionCookie } from "./routes.ts";
import { createSession, rateLimit, userForSession } from "./service.ts";

export const COINPAY_STATE_COOKIE = "advis0r_coinpay_state";
export const CALLBACK_PATH = "/api/v1/coinpay/oauth/callback";
const PENDING_TTL_MS = 10 * 60_000;
const START_LIMIT = { max: 30, windowMinutes: 15 };

export interface CoinPayOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** CoinPay origin; defaults to https://coinpayportal.com. */
  base?: string;
}

export interface CoinPayRouteDeps {
  db: Client;
  appUrl: string;
  secureCookies: boolean;
  oauth: CoinPayOAuthConfig;
  /** Injected in tests. */
  fetch?: typeof fetch;
  now?: () => number;
}

export function coinpayConfigFromEnv(env: Record<string, string | undefined> = process.env): CoinPayOAuthConfig {
  return {
    clientId: env.COINPAY_OAUTH_CLIENT_ID ?? "",
    clientSecret: env.COINPAY_OAUTH_CLIENT_SECRET ?? "",
    base: env.COINPAY_OAUTH_BASE || undefined,
  };
}

export const coinpayConfigured = (c: CoinPayOAuthConfig) => Boolean(c.clientId && c.clientSecret);

const iso = (ms: number) => new Date(ms).toISOString();

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

function stateCookie(value: string, secure: boolean, maxAge: number): string {
  return [
    `${COINPAY_STATE_COOKIE}=${encodeURIComponent(value)}`,
    "Path=/api/v1/coinpay/oauth",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Back to the app with an outcome the UI turns into a message. */
function backToApp(deps: CoinPayRouteDeps, outcome: Record<string, string>, cookies: string[] = []): Response {
  const url = new URL("/", deps.appUrl);
  for (const [k, v] of Object.entries(outcome)) url.searchParams.set(k, v);
  const headers = new Headers({ location: url.pathname + url.search, "cache-control": "no-store" });
  headers.append("set-cookie", stateCookie("", deps.secureCookies, 0));
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}

const fail = (deps: CoinPayRouteDeps, code: string) => backToApp(deps, { coinpay_error: code });

/* ---------------- identity store ---------------- */

export interface CoinPayLink {
  linked: boolean;
  /** False for an account Sign in with CoinPay created: CoinPay is its only way in. */
  hasPassword: boolean;
}

export async function coinpayLinkFor(db: Client, userId: string): Promise<CoinPayLink> {
  const rs = await db.execute({
    sql: `SELECT u.password_hash AS ph, c.sub AS sub FROM users u
          LEFT JOIN coinpay_identities c ON c.user_id = u.id WHERE u.id = ?`,
    args: [userId],
  });
  const row = rs.rows[0];
  return { linked: Boolean(row?.sub), hasPassword: Boolean(row?.ph) };
}

async function identityBySub(db: Client, sub: string): Promise<{ userId: string } | null> {
  const rs = await db.execute({ sql: "SELECT user_id FROM coinpay_identities WHERE sub = ?", args: [sub] });
  return rs.rows[0] ? { userId: String(rs.rows[0].user_id) } : null;
}

/** A new account for a CoinPay identity nobody has linked yet. */
async function createCoinPayAccount(
  db: Client,
  identity: { sub: string; email: string | null; name: string | null },
  nowMs: number,
): Promise<string> {
  const id = newId("usr");
  // Random, unroutable, and impossible to sign up with (.invalid is refused by
  // isValidEmail), so it can never collide with or be claimed by anyone else.
  const placeholder = `${id.toLowerCase().replace(/[^a-z0-9]/g, "")}@coinpay.advis0r.invalid`;
  await db.execute({
    sql: `INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at, digest_frequency)
          VALUES (?,?,?,?,?,?,?)`,
    args: [id, placeholder, "", identity.name?.slice(0, 120) ?? null, iso(nowMs), iso(nowMs), "off"],
  });
  await db.execute({
    sql: `INSERT INTO coinpay_identities (sub, user_id, contact_email, name, created_at, last_login_at)
          VALUES (?,?,?,?,?,?)`,
    args: [identity.sub, id, identity.email, identity.name, iso(nowMs), iso(nowMs)],
  });
  return id;
}

/* ---------------- routes ---------------- */

export async function handleCoinPayRoute(
  req: Request,
  path: string,
  deps: CoinPayRouteDeps,
): Promise<Response | null> {
  if (!path.startsWith("/api/v1/coinpay/")) return null;
  if (path === "/api/v1/coinpay/oauth/start" && req.method === "GET") return start(req, deps);
  if (path === CALLBACK_PATH && req.method === "GET") return callback(req, deps);
  if (path === "/api/v1/coinpay/disconnect" && req.method === "POST") return disconnect(req, deps);
  return null;
}

async function start(req: Request, deps: CoinPayRouteDeps): Promise<Response> {
  if (!coinpayConfigured(deps.oauth)) return fail(deps, "not_configured");
  const now = deps.now?.() ?? Date.now();
  const limit = await rateLimit(deps.db, `coinpay:${clientIp(req)}`, START_LIMIT);
  if (!limit.allowed) return fail(deps, "rate_limited");

  const mode = new URL(req.url).searchParams.get("mode") === "link" ? "link" : "login";
  let userId: string | null = null;
  if (mode === "link") {
    const user = await userForSession(deps.db, readCookie(req, SESSION_COOKIE));
    if (!user) return fail(deps, "sign_in_first");
    userId = user.id;
  }

  const state = randomToken();
  const nonce = randomToken();
  const { verifier, challenge } = pkce();
  await deps.db.execute({ sql: "DELETE FROM coinpay_oauth_pending WHERE expires_at < ?", args: [iso(now)] });
  await deps.db.execute({
    sql: `INSERT INTO coinpay_oauth_pending (state_hash, verifier, nonce, mode, user_id, created_at, expires_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [hashToken(state), verifier, nonce, mode, userId, iso(now), iso(now + PENDING_TTL_MS)],
  });

  const location = authorizeUrl({
    clientId: deps.oauth.clientId,
    redirectUri: new URL(CALLBACK_PATH, deps.appUrl).toString(),
    state,
    nonce,
    challenge,
    scopes: SIGN_IN_SCOPES,
    base: deps.oauth.base,
  });
  return new Response(null, {
    status: 302,
    headers: {
      location,
      "cache-control": "no-store",
      "set-cookie": stateCookie(state, deps.secureCookies, PENDING_TTL_MS / 1000),
    },
  });
}

/** Look up and atomically consume the pending row for this state. */
async function consumePending(
  db: Client,
  state: string,
  now: number,
): Promise<{ verifier: string; nonce: string; mode: string; userId: string | null } | null> {
  const key = hashToken(state);
  const rs = await db.execute({
    sql: "SELECT verifier, nonce, mode, user_id, expires_at FROM coinpay_oauth_pending WHERE state_hash = ?",
    args: [key],
  });
  const row = rs.rows[0];
  if (!row) return null;
  const del = await db.execute({ sql: "DELETE FROM coinpay_oauth_pending WHERE state_hash = ?", args: [key] });
  if (Number(del.rowsAffected ?? 0) === 0) return null; // a concurrent callback won
  if (String(row.expires_at) < iso(now)) return null;
  return {
    verifier: String(row.verifier),
    nonce: String(row.nonce),
    mode: String(row.mode),
    userId: row.user_id ? String(row.user_id) : null,
  };
}

async function callback(req: Request, deps: CoinPayRouteDeps): Promise<Response> {
  if (!coinpayConfigured(deps.oauth)) return fail(deps, "not_configured");
  const now = deps.now?.() ?? Date.now();
  const params = new URL(req.url).searchParams;
  const state = params.get("state") ?? "";
  const code = params.get("code") ?? "";

  // The state must match the one this browser was given (login CSRF), and
  // name a live pending row (single use).
  if (!sameState(readCookie(req, COINPAY_STATE_COOKIE), state)) return fail(deps, "bad_state");
  const pending = await consumePending(deps.db, state, now);
  if (!pending) return fail(deps, "bad_state");
  if (params.get("error")) return fail(deps, "denied");
  if (!code) return fail(deps, "bad_request");

  let identity: { sub: string; email: string | null; name: string | null };
  try {
    identity = await finishSignIn({
      code,
      verifier: pending.verifier,
      nonce: pending.nonce,
      clientId: deps.oauth.clientId,
      clientSecret: deps.oauth.clientSecret,
      redirectUri: new URL(CALLBACK_PATH, deps.appUrl).toString(),
      base: deps.oauth.base,
      fetch: deps.fetch,
      now,
    });
  } catch (err) {
    console.error("[coinpay] sign-in failed:", (err as Error).message);
    return fail(deps, "exchange_failed");
  }

  const existing = await identityBySub(deps.db, identity.sub);

  if (pending.mode === "link") {
    // Linking needs the same signed-in account that started it.
    const user = await userForSession(deps.db, readCookie(req, SESSION_COOKIE));
    if (!user || user.id !== pending.userId) return fail(deps, "sign_in_first");
    if (existing) {
      return existing.userId === user.id ? backToApp(deps, { coinpay: "linked" }) : fail(deps, "linked_elsewhere");
    }
    if ((await coinpayLinkFor(deps.db, user.id)).linked) return fail(deps, "already_linked");
    await deps.db.execute({
      sql: `INSERT INTO coinpay_identities (sub, user_id, contact_email, name, created_at)
            VALUES (?,?,?,?,?)`,
      args: [identity.sub, user.id, identity.email, identity.name, iso(now)],
    });
    return backToApp(deps, { coinpay: "linked" });
  }

  // Login: the sub alone decides the account. No email lookup, ever.
  let userId: string;
  if (existing) {
    userId = existing.userId;
    const rs = await deps.db.execute({ sql: "SELECT disabled FROM users WHERE id = ?", args: [userId] });
    if (!rs.rows[0] || Number(rs.rows[0].disabled ?? 0) === 1) return fail(deps, "disabled");
    await deps.db.execute({
      sql: "UPDATE coinpay_identities SET last_login_at = ?, contact_email = ?, name = COALESCE(?, name) WHERE sub = ?",
      args: [iso(now), identity.email, identity.name, identity.sub],
    });
  } else {
    userId = await createCoinPayAccount(deps.db, identity, now);
  }
  const token = await createSession(deps.db, userId, {
    userAgent: req.headers.get("user-agent") ?? undefined,
    ip: clientIp(req),
  });
  return backToApp(deps, { coinpay: existing ? "signed_in" : "welcome" }, [sessionCookie(token, deps.secureCookies)]);
}

async function disconnect(req: Request, deps: CoinPayRouteDeps): Promise<Response> {
  const user = await userForSession(deps.db, readCookie(req, SESSION_COOKIE));
  if (!user) return json({ error: "Sign in first.", authRequired: true }, 401);
  const link = await coinpayLinkFor(deps.db, user.id);
  if (!link.linked) return json({ ok: true, linked: false });
  if (!link.hasPassword) {
    return json({ error: "CoinPay is the only way into this account, so it cannot be disconnected." }, 409);
  }
  await deps.db.execute({ sql: "DELETE FROM coinpay_identities WHERE user_id = ?", args: [user.id] });
  return json({ ok: true, linked: false });
}
