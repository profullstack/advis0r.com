/**
 * Password hashing, token generation and comparison (PRD v3 §7).
 *
 * Security decisions worth stating explicitly, because they are the ones that
 * matter if the database ever leaks:
 *
 *   - Passwords use **argon2id** via `Bun.password`, which is built into the
 *     runtime — no dependency, memory-hard, and salted per hash.
 *   - Session and email tokens are high-entropy random values. Only their
 *     SHA-256 is stored, so a database dump yields no usable session or reset
 *     link. The plaintext exists only in the user's cookie or their email.
 *   - Token comparison is constant-time, so a timing side channel cannot be
 *     used to guess a token byte by byte.
 */
import { randomBytes, timingSafeEqual, createHash } from "node:crypto";

/** Bytes of entropy per token. 32 bytes = 256 bits. */
const TOKEN_BYTES = 32;

/** argon2id parameters. Deliberately above Bun's defaults for a login path. */
const ARGON2 = {
  algorithm: "argon2id",
  memoryCost: 19_456, // ~19 MiB — OWASP minimum for argon2id
  timeCost: 2,
} as const;

export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, ARGON2);
}

/**
 * Verify a password. Returns false on a malformed stored hash rather than
 * throwing, so a corrupt row cannot 500 the login endpoint.
 */
export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}

/** URL-safe random token, suitable for a cookie value or an email link. */
export function generateToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/** SHA-256 of a token — this is what gets stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, which would itself leak length.
  // Compare fixed-size digests so every call does the same work.
  const ah = createHash("sha256").update(ab).digest();
  const bh = createHash("sha256").update(bb).digest();
  return timingSafeEqual(ah, bh);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(12).toString("base64url")}`;
}

/** Normalize an email for storage and lookup: trimmed and lowercased. */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Pragmatic email validation. Deliberately not an RFC 5322 regex — the only
 * authoritative test of an address is whether mail to it arrives, which is
 * exactly what the verification step does.
 */
export function isValidEmail(email: string): boolean {
  const e = normalizeEmail(email);
  if (e.length < 3 || e.length > 254) return false;
  if (/\s/.test(e)) return false;
  const at = e.indexOf("@");
  if (at <= 0 || at !== e.lastIndexOf("@")) return false;
  const domain = e.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) return false;
  if (domain.includes("..")) return false;
  return true;
}

export interface PasswordCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Password policy: length first, since length dominates strength. A long
 * passphrase is accepted without composition rules, which push users toward
 * predictable substitutions.
 */
export function checkPasswordStrength(password: string): PasswordCheck {
  if (password.length < 10) {
    return { ok: false, reason: "Password must be at least 10 characters." };
  }
  if (password.length > 200) {
    return { ok: false, reason: "Password must be at most 200 characters." };
  }
  const common = new Set([
    "password12", "password123", "1234567890", "qwertyuiop",
    "letmein123", "iloveyou12", "admin12345", "welcome123",
  ]);
  if (common.has(password.toLowerCase())) {
    return { ok: false, reason: "That password is too common." };
  }
  return { ok: true };
}
