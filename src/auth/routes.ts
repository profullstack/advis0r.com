/**
 * Auth HTTP surface (PRD v3 §7).
 *
 *   POST /api/auth/signup          { email, password, displayName? }
 *   POST /api/auth/login           { email, password }
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 *   POST /api/auth/verify          { token }
 *   POST /api/auth/request-reset   { email }
 *   POST /api/auth/reset           { token, password }
 *
 * The session cookie is HttpOnly (JavaScript cannot read it, so XSS cannot
 * exfiltrate it), SameSite=Lax (blocks cross-site POST CSRF while keeping
 * ordinary top-level navigation working), and Secure in production.
 */
import type { Client } from "@libsql/client";
import { Mailer } from "./email.ts";
import {
  type PublicUser,
  RATE_LIMITS,
  SESSION_TTL_DAYS,
  type AuthContext,
  login,
  logout,
  rateLimit,
  requestPasswordReset,
  resetPassword,
  signup,
  userForSession,
  verifyEmail,
} from "./service.ts";

export const SESSION_COOKIE = "advis0r_session";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });

export function readCookie(req: Request, name: string): string {
  const header = req.headers.get("cookie") ?? "";
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

export function sessionCookie(token: string, secure: boolean): string {
  const maxAge = SESSION_TTL_DAYS * 86_400;
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`,
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

export function clearCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
    secure ? "Secure" : "",
  ]
    .filter(Boolean)
    .join("; ");
}

/** Best-effort client IP for rate-limit bucketing behind a proxy. */
export function clientIp(req: Request): string {
  const fwd = req.headers.get("x-forwarded-for") ?? "";
  return (fwd.split(",")[0] || req.headers.get("x-real-ip") || "unknown").trim();
}

async function readJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    return body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

export interface AuthRouteDeps {
  db: Client;
  mailer: Mailer;
  appUrl: string;
  secureCookies: boolean;
}

/**
 * Handle an /api/auth/* request. Returns null when the path is not an auth
 * route, so the caller can continue its own routing.
 */
export async function handleAuthRoute(
  req: Request,
  path: string,
  deps: AuthRouteDeps,
): Promise<Response | null> {
  if (!path.startsWith("/api/auth/")) return null;
  const ctx: AuthContext = { db: deps.db, mailer: deps.mailer, appUrl: deps.appUrl };
  const ip = clientIp(req);

  if (path === "/api/auth/me") {
    const user = await userForSession(deps.db, readCookie(req, SESSION_COOKIE));
    return json({ user, authenticated: Boolean(user) });
  }

  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const body = await readJson(req);

  if (path === "/api/auth/signup") {
    const email = str(body.email);
    const limit = await rateLimit(deps.db, `signup:${ip}`, RATE_LIMITS.signup);
    if (!limit.allowed) {
      return json({ error: `Too many signups. Try again in ${limit.retryAfterMinutes} minutes.` }, 429);
    }
    const result = await signup(ctx, {
      email,
      password: str(body.password),
      displayName: str(body.displayName) || undefined,
    });
    if (!result.ok) return json({ error: result.error }, 400);
    return json({
      ok: true,
      // Identical whether or not the address already exists.
      message: "Check your email for a verification link.",
      devVerifyUrl: result.devVerifyUrl,
    });
  }

  if (path === "/api/auth/login") {
    const email = str(body.email).trim().toLowerCase();
    for (const bucket of [`login:${ip}`, `login:${email}`]) {
      const limit = await rateLimit(deps.db, bucket, RATE_LIMITS.login);
      if (!limit.allowed) {
        return json({ error: `Too many attempts. Try again in ${limit.retryAfterMinutes} minutes.` }, 429);
      }
    }
    const result = await login(ctx, {
      email,
      password: str(body.password),
      userAgent: req.headers.get("user-agent") ?? undefined,
      ip,
    });
    if (!result.ok || !result.token) return json({ error: result.error }, 401);
    return json(
      { ok: true, user: result.user },
      200,
      { "set-cookie": sessionCookie(result.token, deps.secureCookies) },
    );
  }

  if (path === "/api/auth/logout") {
    await logout(deps.db, readCookie(req, SESSION_COOKIE));
    return json({ ok: true }, 200, { "set-cookie": clearCookie(deps.secureCookies) });
  }

  if (path === "/api/auth/verify") {
    const result = await verifyEmail(ctx, str(body.token));
    return result.ok ? json({ ok: true }) : json({ error: result.error }, 400);
  }

  if (path === "/api/auth/request-reset") {
    const limit = await rateLimit(deps.db, `reset:${ip}`, RATE_LIMITS.reset);
    if (!limit.allowed) {
      return json({ error: `Too many requests. Try again in ${limit.retryAfterMinutes} minutes.` }, 429);
    }
    const result = await requestPasswordReset(ctx, str(body.email));
    return json({
      ok: true,
      message: "If that address has an account, a reset link is on its way.",
      devResetUrl: result.devResetUrl,
    });
  }

  if (path === "/api/auth/reset") {
    const result = await resetPassword(ctx, {
      token: str(body.token),
      password: str(body.password),
    });
    if (!result.ok) return json({ error: result.error }, 400);
    // Every session was revoked, so the old cookie is dead — clear it too.
    return json({ ok: true }, 200, { "set-cookie": clearCookie(deps.secureCookies) });
  }

  return json({ error: "not found" }, 404);
}

/* ---------------- route guards ---------------- */

export interface GuardFailure {
  status: number;
  body: { error: string; authRequired?: boolean; verificationRequired?: boolean };
}

export interface GuardResult {
  user?: PublicUser;
  failure?: GuardFailure;
}

/**
 * Resolve the caller for a protected route.
 *
 * `requireVerified` matters for anything that costs money: an unverified
 * account is free to create in bulk, so email verification is the cheapest
 * barrier between an abusive signup and metered LLM spend.
 *
 * The two failure modes are reported distinctly (`authRequired` vs
 * `verificationRequired`) because the UI response differs — one opens the
 * sign-in modal, the other tells the user to check their inbox.
 */
export async function requireUser(
  req: Request,
  db: Client,
  opts: { requireVerified?: boolean } = {},
): Promise<GuardResult> {
  const user = await userForSession(db, readCookie(req, SESSION_COOKIE));
  if (!user) {
    return {
      failure: {
        status: 401,
        body: { error: "Sign in to run AI analysis.", authRequired: true },
      },
    };
  }
  if (opts.requireVerified && !user.emailVerified) {
    return {
      failure: {
        status: 403,
        body: {
          error: "Verify your email address to run AI analysis. Check your inbox for the link.",
          verificationRequired: true,
        },
      },
    };
  }
  return { user };
}

export function guardResponse(failure: GuardFailure): Response {
  return json(failure.body, failure.status);
}
