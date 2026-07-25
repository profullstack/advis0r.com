/**
 * Authentication service (PRD v3 §7): signup, login, email verification and
 * password reset.
 *
 * Two properties are load-bearing throughout and worth naming:
 *
 *  - **No user enumeration.** Signup and password-reset return the same shape
 *    whether or not the address exists. An attacker must not be able to use
 *    this service to discover who has an account.
 *  - **Gating is narrow and deliberate.** Only the saved watchlist and the
 *    metered AI-analysis paths require an account; browsing, search, signals
 *    and topic discovery stay public. Analysis additionally requires a verified
 *    email, since unverified accounts are free to create in bulk and each call
 *    costs real money.
 */
import type { Client } from "@libsql/client";
import {
  checkPasswordStrength,
  generateToken,
  hashPassword,
  hashToken,
  isValidEmail,
  newId,
  normalizeEmail,
  verifyPassword,
} from "./crypto.ts";
import { Mailer, resetEmail, verificationEmail } from "./email.ts";

export const SESSION_TTL_DAYS = 30;
export const VERIFY_TTL_HOURS = 24;
export const RESET_TTL_MINUTES = 60;

/** Throttle windows: max attempts per bucket within the window. */
export const RATE_LIMITS = {
  login: { max: 8, windowMinutes: 15 },
  signup: { max: 5, windowMinutes: 60 },
  reset: { max: 5, windowMinutes: 60 },
  // Each analyze call is a real, metered LLM request (~40s of frontier-model
  // time). Cap it per account so one signed-in user cannot drain the budget.
  analyze: { max: 40, windowMinutes: 60 },
} as const;

export interface PublicUser {
  id: string;
  email: string;
  displayName?: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface AuthContext {
  db: Client;
  mailer: Mailer;
  appUrl: string;
}

const iso = () => new Date().toISOString();
const plus = (ms: number) => new Date(Date.now() + ms).toISOString();

function toPublicUser(row: Record<string, unknown>): PublicUser {
  return {
    id: String(row.id),
    email: String(row.email),
    displayName: row.display_name ? String(row.display_name) : undefined,
    emailVerified: Boolean(row.email_verified_at),
    createdAt: String(row.created_at),
  };
}

/* ---------------- rate limiting ---------------- */

/**
 * Count-and-record throttle. Buckets are keyed by action plus identity (email
 * or IP) so one abusive client cannot lock out unrelated users.
 */
export async function rateLimit(
  db: Client,
  bucket: string,
  limit: { max: number; windowMinutes: number },
): Promise<{ allowed: boolean; retryAfterMinutes: number }> {
  const since = new Date(Date.now() - limit.windowMinutes * 60_000).toISOString();
  await db.execute({ sql: "DELETE FROM auth_attempts WHERE created_at < ?", args: [since] });
  const rs = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM auth_attempts WHERE bucket = ? AND created_at >= ?",
    args: [bucket, since],
  });
  const n = Number(rs.rows[0]?.n ?? 0);
  if (n >= limit.max) return { allowed: false, retryAfterMinutes: limit.windowMinutes };
  await db.execute({
    sql: "INSERT INTO auth_attempts (id, bucket, created_at) VALUES (?,?,?)",
    args: [newId("att"), bucket, iso()],
  });
  return { allowed: true, retryAfterMinutes: 0 };
}

/* ---------------- signup + verification ---------------- */

export interface SignupResult {
  ok: boolean;
  /** Present only in development when no mail transport is configured. */
  devVerifyUrl?: string;
  error?: string;
}

export async function signup(
  ctx: AuthContext,
  input: { email: string; password: string; displayName?: string },
): Promise<SignupResult> {
  const email = normalizeEmail(input.email);
  if (!isValidEmail(email)) return { ok: false, error: "Enter a valid email address." };
  const strength = checkPasswordStrength(input.password);
  if (!strength.ok) return { ok: false, error: strength.reason };

  const existing = await ctx.db.execute({
    sql: "SELECT id, email_verified_at FROM users WHERE email = ?",
    args: [email],
  });

  // Same response either way — the caller cannot learn whether the address is
  // already registered. An existing unverified account gets a fresh link; an
  // existing verified account gets nothing (and no error).
  if (existing.rows.length) {
    const row = existing.rows[0]!;
    if (!row.email_verified_at) {
      const url = await issueEmailToken(ctx, String(row.id), "verify_email");
      return { ok: true, devVerifyUrl: ctx.mailer.configured ? undefined : url };
    }
    return { ok: true };
  }

  const id = newId("usr");
  await ctx.db.execute({
    sql: `INSERT INTO users (id, email, password_hash, display_name, created_at, updated_at)
          VALUES (?,?,?,?,?,?)`,
    args: [id, email, await hashPassword(input.password), input.displayName ?? null, iso(), iso()],
  });
  const url = await issueEmailToken(ctx, id, "verify_email");
  return { ok: true, devVerifyUrl: ctx.mailer.configured ? undefined : url };
}

/** Mint a single-use token, invalidate prior ones of the same kind, and email it. */
export async function issueEmailToken(
  ctx: AuthContext,
  userId: string,
  kind: "verify_email" | "reset_password",
): Promise<string> {
  // Only the newest link should work — otherwise an old email remains a valid
  // credential long after the user requested a replacement.
  await ctx.db.execute({
    sql: "UPDATE auth_tokens SET consumed_at = ? WHERE user_id = ? AND kind = ? AND consumed_at IS NULL",
    args: [iso(), userId, kind],
  });

  const token = generateToken();
  const ttlMs =
    kind === "verify_email" ? VERIFY_TTL_HOURS * 3_600_000 : RESET_TTL_MINUTES * 60_000;
  await ctx.db.execute({
    sql: `INSERT INTO auth_tokens (id, user_id, kind, token_hash, created_at, expires_at)
          VALUES (?,?,?,?,?,?)`,
    args: [newId("tok"), userId, kind, hashToken(token), iso(), plus(ttlMs)],
  });

  const path = kind === "verify_email" ? "/verify" : "/reset";
  const url = `${ctx.appUrl.replace(/\/$/, "")}${path}?token=${encodeURIComponent(token)}`;

  const rs = await ctx.db.execute({ sql: "SELECT email FROM users WHERE id = ?", args: [userId] });
  const to = String(rs.rows[0]?.email ?? "");
  if (to) {
    const msg =
      kind === "verify_email"
        ? verificationEmail(url, VERIFY_TTL_HOURS)
        : resetEmail(url, RESET_TTL_MINUTES);
    const result = await ctx.mailer.send({ to, ...msg });
    if (!result.ok) {
      console.error(`[auth] ${kind} email to ${to} failed (${result.transport}): ${result.error}`);
    }
  }
  return url;
}

export async function verifyEmail(
  ctx: AuthContext,
  token: string,
): Promise<{ ok: boolean; error?: string }> {
  const row = await consumeToken(ctx.db, token, "verify_email");
  if (!row) return { ok: false, error: "This verification link is invalid or has expired." };
  await ctx.db.execute({
    sql: "UPDATE users SET email_verified_at = ?, updated_at = ? WHERE id = ?",
    args: [iso(), iso(), row.userId],
  });
  return { ok: true };
}

/** Look up, validate and atomically consume a single-use token. */
async function consumeToken(
  db: Client,
  token: string,
  kind: string,
): Promise<{ id: string; userId: string } | null> {
  if (!token) return null;
  const rs = await db.execute({
    sql: `SELECT id, user_id, expires_at, consumed_at FROM auth_tokens
          WHERE token_hash = ? AND kind = ?`,
    args: [hashToken(token), kind],
  });
  const row = rs.rows[0];
  if (!row) return null;
  if (row.consumed_at) return null;
  if (String(row.expires_at) < iso()) return null;

  // Guarded update doubles as the atomic claim: a concurrent second request
  // affects zero rows and is rejected.
  const upd = await db.execute({
    sql: "UPDATE auth_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL",
    args: [iso(), String(row.id)],
  });
  if (Number(upd.rowsAffected ?? 0) === 0) return null;
  return { id: String(row.id), userId: String(row.user_id) };
}

/* ---------------- login / sessions ---------------- */

export interface LoginResult {
  ok: boolean;
  token?: string;
  user?: PublicUser;
  error?: string;
}

export async function login(
  ctx: AuthContext,
  input: { email: string; password: string; userAgent?: string; ip?: string },
): Promise<LoginResult> {
  const email = normalizeEmail(input.email);
  const rs = await ctx.db.execute({
    sql: "SELECT * FROM users WHERE email = ?",
    args: [email],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;

  // Always run a verification so a missing account and a wrong password take
  // comparable time — a fast "no such user" is an enumeration oracle.
  const hash = row ? String(row.password_hash) : "$argon2id$v=19$m=19456,t=2,p=1$Ymx1ZmY$bm90YXJlYWxoYXNo";
  const passwordOk = await verifyPassword(input.password, hash);

  if (!row || !passwordOk) return { ok: false, error: "Incorrect email or password." };
  if (Number(row.disabled ?? 0) === 1) return { ok: false, error: "This account is disabled." };

  const token = generateToken();
  await ctx.db.execute({
    sql: `INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at, user_agent, ip)
          VALUES (?,?,?,?,?,?,?)`,
    args: [
      newId("ses"), String(row.id), hashToken(token), iso(),
      plus(SESSION_TTL_DAYS * 86_400_000),
      input.userAgent?.slice(0, 300) ?? null, input.ip?.slice(0, 100) ?? null,
    ],
  });
  await ctx.db.execute({
    sql: "UPDATE users SET last_login_at = ? WHERE id = ?",
    args: [iso(), String(row.id)],
  });

  return { ok: true, token, user: toPublicUser(row) };
}

/** Resolve a session token to its user, or null when invalid/expired/revoked. */
export async function userForSession(db: Client, token: string): Promise<PublicUser | null> {
  if (!token) return null;
  const rs = await db.execute({
    sql: `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > ?
            AND COALESCE(u.disabled, 0) = 0`,
    args: [hashToken(token), iso()],
  });
  const row = rs.rows[0] as Record<string, unknown> | undefined;
  return row ? toPublicUser(row) : null;
}

export async function logout(db: Client, token: string): Promise<void> {
  if (!token) return;
  await db.execute({
    sql: "UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL",
    args: [iso(), hashToken(token)],
  });
}

/* ---------------- password reset ---------------- */

export async function requestPasswordReset(
  ctx: AuthContext,
  email: string,
): Promise<{ ok: true; devResetUrl?: string }> {
  const normalized = normalizeEmail(email);
  const rs = await ctx.db.execute({
    sql: "SELECT id FROM users WHERE email = ? AND COALESCE(disabled, 0) = 0",
    args: [normalized],
  });
  const row = rs.rows[0];
  let devUrl: string | undefined;
  if (row) {
    const url = await issueEmailToken(ctx, String(row.id), "reset_password");
    if (!ctx.mailer.configured) devUrl = url;
  }
  // Unconditional success: whether the address exists is not disclosed.
  return { ok: true, devResetUrl: devUrl };
}

export async function resetPassword(
  ctx: AuthContext,
  input: { token: string; password: string },
): Promise<{ ok: boolean; error?: string }> {
  const strength = checkPasswordStrength(input.password);
  if (!strength.ok) return { ok: false, error: strength.reason };

  const row = await consumeToken(ctx.db, input.token, "reset_password");
  if (!row) return { ok: false, error: "This reset link is invalid or has expired." };

  await ctx.db.execute({
    sql: "UPDATE users SET password_hash = ?, updated_at = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?",
    args: [await hashPassword(input.password), iso(), iso(), row.userId],
  });

  // A password change invalidates every existing session: if the reset was
  // triggered because the account was compromised, the attacker's session must
  // not survive it.
  await ctx.db.execute({
    sql: "UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
    args: [iso(), row.userId],
  });
  return { ok: true };
}
