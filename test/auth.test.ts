/**
 * Authentication unit tests (PRD v3 §7).
 *
 * The properties worth testing here are the security ones: password policy,
 * email normalization, token opacity, constant-time comparison, and the
 * cookie flags that decide whether a session can be stolen by XSS or CSRF.
 */
import { describe, expect, test } from "bun:test";
import {
  checkPasswordStrength,
  generateToken,
  hashPassword,
  hashToken,
  isValidEmail,
  normalizeEmail,
  safeEqual,
  verifyPassword,
} from "../src/auth/crypto.ts";
import { SESSION_COOKIE, clearCookie, clientIp, sessionCookie } from "../src/auth/routes.ts";
import { Mailer, resetEmail, verificationEmail } from "../src/auth/email.ts";
import { MAX_WATCHLIST_ITEMS, normalizeTicker } from "../src/auth/watchlist.ts";

describe("password hashing", () => {
  test("verifies a correct password and rejects a wrong one", async () => {
    const hash = await hashPassword("correct-horse-battery");
    expect(await verifyPassword("correct-horse-battery", hash)).toBe(true);
    expect(await verifyPassword("Correct-horse-battery", hash)).toBe(false);
  });

  test("uses argon2id and salts each hash", async () => {
    const a = await hashPassword("same-password-here");
    const b = await hashPassword("same-password-here");
    expect(a).toContain("$argon2id$");
    expect(a).not.toBe(b); // distinct salts
  });

  test("a malformed stored hash returns false instead of throwing", async () => {
    expect(await verifyPassword("x", "not-a-hash")).toBe(false);
  });
});

describe("password policy", () => {
  test("length is the primary requirement", () => {
    expect(checkPasswordStrength("short").ok).toBe(false);
    expect(checkPasswordStrength("a-long-enough-passphrase").ok).toBe(true);
  });

  test("rejects well-known passwords", () => {
    expect(checkPasswordStrength("password123").ok).toBe(false);
  });

  test("rejects absurdly long input (hashing DoS)", () => {
    expect(checkPasswordStrength("x".repeat(500)).ok).toBe(false);
  });
});

describe("email handling", () => {
  test("normalizes case and whitespace", () => {
    expect(normalizeEmail("  Someone@Example.COM ")).toBe("someone@example.com");
  });

  test("accepts ordinary addresses", () => {
    expect(isValidEmail("a.b+tag@sub.example.co.uk")).toBe(true);
  });

  test("rejects malformed addresses", () => {
    for (const bad of ["nope", "a@b", "@example.com", "a@@b.com", "a b@c.com", "a@b..com", "a@b.", ""]) {
      expect(isValidEmail(bad)).toBe(false);
    }
  });
});

describe("tokens", () => {
  test("are high-entropy and unique", () => {
    const a = generateToken(), b = generateToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(43); // 256 bits base64url
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe: survives an email link
  });

  test("only the hash is ever stored, and it is not reversible to the token", () => {
    const t = generateToken();
    const h = hashToken(t);
    expect(h).not.toContain(t);
    expect(h).toHaveLength(64); // sha256 hex
    expect(hashToken(t)).toBe(h); // deterministic lookup
  });

  test("comparison is constant-time and correct", () => {
    const t = generateToken();
    expect(safeEqual(t, t)).toBe(true);
    expect(safeEqual(t, generateToken())).toBe(false);
    // Must not throw on differing lengths — that would itself leak length.
    expect(safeEqual("a", "much-longer-value")).toBe(false);
  });
});

describe("session cookie flags", () => {
  test("HttpOnly and SameSite are always set — XSS and CSRF defence", () => {
    const c = sessionCookie("tok", true);
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/");
    expect(c).toStartWith(`${SESSION_COOKIE}=`);
  });

  test("Secure is set over HTTPS and omitted on local HTTP", () => {
    expect(sessionCookie("tok", true)).toContain("Secure");
    expect(sessionCookie("tok", false)).not.toContain("Secure");
  });

  test("logout expires the cookie immediately", () => {
    expect(clearCookie(true)).toContain("Max-Age=0");
  });

  test("token is URL-encoded into the cookie", () => {
    expect(sessionCookie("a b", false)).toContain("a%20b");
  });
});

describe("client IP resolution", () => {
  const req = (h: Record<string, string>) => new Request("https://x/", { headers: h });

  test("takes the first hop of x-forwarded-for", () => {
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 5.6.7.8" }))).toBe("1.2.3.4");
  });

  test("falls back to x-real-ip, then unknown", () => {
    expect(clientIp(req({ "x-real-ip": "9.9.9.9" }))).toBe("9.9.9.9");
    expect(clientIp(req({}))).toBe("unknown");
  });
});

describe("mailer", () => {
  test("selects a transport from available credentials", () => {
    expect(new Mailer({ resendApiKey: "k" }).transport).toBe("resend");
    expect(new Mailer({ mailgunApiKey: "k", mailgunDomain: "d" }).transport).toBe("mailgun");
    expect(new Mailer({ mailgunApiKey: "k" }).transport).toBe("logged"); // domain required
  });

  test("never claims success when nothing is configured", async () => {
    const r = await new Mailer({}).send({ to: "a@b.com", subject: "s", text: "t", html: "<p>t</p>" });
    expect(r.ok).toBe(false);
    expect(r.transport).toBe("logged");
  });

  test("templates carry the link in both text and html", () => {
    const url = "https://advis0r.com/verify?token=abc123";
    for (const m of [verificationEmail(url, 24), resetEmail(url, 60)]) {
      expect(m.text).toContain(url);
      expect(m.html).toContain(url);
      expect(m.subject.length).toBeGreaterThan(0);
    }
  });

  test("escapes HTML so a crafted link cannot inject markup", () => {
    const m = verificationEmail('https://x/?t="><script>alert(1)</script>', 24);
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
  });
});

describe("watchlist ticker validation", () => {
  test("normalizes case and whitespace", () => {
    expect(normalizeTicker("  nvda ")).toBe("NVDA");
  });

  test("accepts class-suffixed symbols", () => {
    expect(normalizeTicker("BRK.B")).toBe("BRK.B");
  });

  test("rejects anything that is not a ticker", () => {
    for (const bad of ["", "TOOLONGX", "not a ticker!", "../etc/passwd", "'; DROP TABLE users;--", "<script>"]) {
      expect(normalizeTicker(bad)).toBeNull();
    }
  });

  test("is bounded so one account cannot fill the table", () => {
    expect(MAX_WATCHLIST_ITEMS).toBeGreaterThan(0);
    expect(MAX_WATCHLIST_ITEMS).toBeLessThanOrEqual(1000);
  });
});
