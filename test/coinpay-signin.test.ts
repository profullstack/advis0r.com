/**
 * Sign in with CoinPay, against a real database with a fake CoinPay: the
 * account binds to the CoinPay sub only, an email collision never takes over an
 * existing account, linking needs a session, and a bad state or nonce is refused.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openClient } from "../src/db/index.ts";
import { COINPAY_STATE_COOKIE, handleCoinPayRoute, type CoinPayRouteDeps } from "../src/auth/coinpay.ts";
import { isValidEmail } from "../src/auth/crypto.ts";
import { handleAuthRoute, SESSION_COOKIE } from "../src/auth/routes.ts";
import { login, userForSession } from "../src/auth/service.ts";
import type { Mailer } from "../src/auth/email.ts";

const dir = mkdtempSync(join(tmpdir(), "advis0r-coinpay-"));
let db: Client;
const BASE = "https://coinpay.test";
const CLIENT_ID = "cp_test_client";
const PASSWORD = "a-long-enough-passphrase";

/** What the fake CoinPay will say about the next code exchange. */
let identity = { sub: "sub-1", email: "someone@example.com", name: "Some One" };
let nonceOverride: string | null = null;
let lastNonce = "";
let tokenRequests: URLSearchParams[] = [];

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  if (url.endsWith("/api/oauth/token")) {
    const body = new URLSearchParams(String(init?.body));
    tokenRequests.push(body);
    const idToken = [
      b64({ alg: "HS256", typ: "JWT" }),
      b64({ iss: BASE, aud: CLIENT_ID, sub: identity.sub, exp: Math.floor(Date.now() / 1000) + 600, nonce: nonceOverride ?? lastNonce, email: identity.email }),
      "sig",
    ].join(".");
    return Response.json({ access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: idToken });
  }
  if (url.endsWith("/api/oauth/userinfo")) {
    return Response.json({ sub: identity.sub, email: identity.email, email_verified: false, name: identity.name });
  }
  return new Response("not found", { status: 404 });
}) as typeof fetch;

const deps = (): CoinPayRouteDeps => ({
  db,
  appUrl: "https://advis0r.test",
  secureCookies: false,
  oauth: { clientId: CLIENT_ID, clientSecret: "test-secret", base: BASE },
  fetch: fakeFetch,
});

let ipN = 0;
function get(path: string, cookies: Record<string, string> = {}): Request {
  return new Request(`https://advis0r.test${path}`, {
    headers: {
      cookie: Object.entries(cookies).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join("; "),
      "x-forwarded-for": `10.9.${++ipN % 250}.1`,
    },
  });
}

function cookieValue(res: Response, name: string): string {
  for (const c of res.headers.getSetCookie()) {
    const [kv] = c.split(";");
    const [k, ...v] = kv!.split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return "";
}

/** Start a flow and return what the browser would hold. */
async function startFlow(mode: "login" | "link", session?: string) {
  const res = (await handleCoinPayRoute(get(`/api/v1/coinpay/oauth/start?mode=${mode}`, session ? { [SESSION_COOKIE]: session } : {}), "/api/v1/coinpay/oauth/start", deps()))!;
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get("location")!, "https://advis0r.test");
  return { res, location, stateCookie: cookieValue(res, COINPAY_STATE_COOKIE) };
}

async function callback(state: string, cookies: Record<string, string>) {
  return (await handleCoinPayRoute(
    get(`/api/v1/coinpay/oauth/callback?code=abc&state=${encodeURIComponent(state)}`, cookies),
    "/api/v1/coinpay/oauth/callback",
    deps(),
  ))!;
}

/** Full happy-path round trip; returns the callback response. */
async function roundTrip(mode: "login" | "link", session?: string) {
  const { location, stateCookie } = await startFlow(mode, session);
  lastNonce = location.searchParams.get("nonce")!;
  const cookies: Record<string, string> = { [COINPAY_STATE_COOKIE]: stateCookie };
  if (session) cookies[SESSION_COOKIE] = session;
  return callback(location.searchParams.get("state")!, cookies);
}

async function makeUser(email: string): Promise<string> {
  const id = `usr_${email.replace(/[^a-z0-9]/gi, "")}`;
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO users (id, email, password_hash, created_at, updated_at, email_verified_at) VALUES (?,?,?,?,?,?)`,
    args: [id, email, await Bun.password.hash(PASSWORD), now, now, now],
  });
  return id;
}

const ctx = () => ({ db, mailer: { configured: true, send: async () => ({ ok: true }) } as unknown as Mailer, appUrl: "https://advis0r.test" });

beforeAll(async () => {
  db = openClient(`file:${join(dir, "t.db")}`);
  await migrate(db);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("start", () => {
  test("302s to CoinPay authorize with PKCE S256, state, nonce and the exact redirect", async () => {
    const { location, stateCookie } = await startFlow("login");
    expect(location.origin + location.pathname).toBe(`${BASE}/api/oauth/authorize`);
    expect(location.searchParams.get("code_challenge_method")).toBe("S256");
    expect(location.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(location.searchParams.get("nonce")).toBeTruthy();
    expect(location.searchParams.get("state")).toBe(stateCookie);
    expect(location.searchParams.get("redirect_uri")).toBe("https://advis0r.test/api/v1/coinpay/oauth/callback");
    expect(location.searchParams.get("scope")).toBe("openid profile email");
  });

  test("link mode without a session is refused", async () => {
    const res = (await handleCoinPayRoute(get("/api/v1/coinpay/oauth/start?mode=link"), "/api/v1/coinpay/oauth/start", deps()))!;
    expect(res.headers.get("location")).toBe("/?coinpay_error=sign_in_first");
  });
});

describe("callback", () => {
  test("a first CoinPay login creates a new account bound to the sub, with a placeholder email", async () => {
    identity = { sub: "sub-new", email: "fresh@example.com", name: "Fresh" };
    tokenRequests = [];
    const res = await roundTrip("login");
    expect(res.headers.get("location")).toBe("/?coinpay=welcome");
    // The code exchange sent the PKCE verifier and the client secret.
    expect(tokenRequests[0]!.get("code_verifier")).toBeTruthy();
    expect(tokenRequests[0]!.get("client_secret")).toBe("test-secret");
    const user = await userForSession(db, cookieValue(res, SESSION_COOKIE));
    expect(user).toBeTruthy();
    expect(user!.email).toEndWith("@coinpay.advis0r.invalid");
    expect(user!.emailVerified).toBe(false);
    expect(user!.displayName).toBe("Fresh");

    // Signing in again lands on the same account.
    const again = await roundTrip("login");
    expect(again.headers.get("location")).toBe("/?coinpay=signed_in");
    expect((await userForSession(db, cookieValue(again, SESSION_COOKIE)))!.id).toBe(user!.id);
  });

  test("a CoinPay email equal to an existing account's email does NOT get that account", async () => {
    const victim = await makeUser("victim@example.com");
    identity = { sub: "sub-attacker", email: "victim@example.com", name: "Attacker" };
    const res = await roundTrip("login");
    const user = await userForSession(db, cookieValue(res, SESSION_COOKIE));
    expect(user).toBeTruthy();
    expect(user!.id).not.toBe(victim);
    expect(user!.email).not.toBe("victim@example.com");
    const link = await db.execute({ sql: "SELECT sub FROM coinpay_identities WHERE user_id = ?", args: [victim] });
    expect(link.rows.length).toBe(0);
  });

  test("a CoinPay-created account cannot be entered with a password", async () => {
    const rs = await db.execute({ sql: "SELECT u.email FROM users u JOIN coinpay_identities c ON c.user_id = u.id WHERE c.sub = 'sub-new'", args: [] });
    const r = await login(ctx(), { email: String(rs.rows[0]!.email), password: "" });
    expect(r.ok).toBe(false);
  });

  test("a forged or missing state is rejected", async () => {
    const { location, stateCookie } = await startFlow("login");
    lastNonce = location.searchParams.get("nonce")!;
    const forged = await callback("forged-state", { [COINPAY_STATE_COOKIE]: "forged-state" });
    expect(forged.headers.get("location")).toBe("/?coinpay_error=bad_state");
    const mismatch = await callback(location.searchParams.get("state")!, { [COINPAY_STATE_COOKIE]: "other" });
    expect(mismatch.headers.get("location")).toBe("/?coinpay_error=bad_state");
    const noCookie = await callback(location.searchParams.get("state")!, {});
    expect(noCookie.headers.get("location")).toBe("/?coinpay_error=bad_state");
    // The real state still works once, then never again.
    const ok = await callback(location.searchParams.get("state")!, { [COINPAY_STATE_COOKIE]: stateCookie });
    expect(ok.headers.get("location")).toMatch(/^\/\?coinpay=(welcome|signed_in)$/);
    const replay = await callback(location.searchParams.get("state")!, { [COINPAY_STATE_COOKIE]: stateCookie });
    expect(replay.headers.get("location")).toBe("/?coinpay_error=bad_state");
  });

  test("an id_token with the wrong nonce is rejected", async () => {
    identity = { sub: "sub-nonce", email: "n@example.com", name: "N" };
    nonceOverride = "not-the-nonce";
    try {
      const res = await roundTrip("login");
      expect(res.headers.get("location")).toBe("/?coinpay_error=exchange_failed");
      expect(cookieValue(res, SESSION_COOKIE)).toBe("");
    } finally {
      nonceOverride = null;
    }
  });
});

describe("connect / disconnect", () => {
  test("linking needs the signed-in account, then CoinPay signs into it", async () => {
    const userId = await makeUser("linker@example.com");
    const session = (await login(ctx(), { email: "linker@example.com", password: PASSWORD })).token!;
    identity = { sub: "sub-linker", email: "whatever@example.com", name: "L" };
    const res = await roundTrip("link", session);
    expect(res.headers.get("location")).toBe("/?coinpay=linked");

    const signIn = await roundTrip("login");
    expect((await userForSession(db, cookieValue(signIn, SESSION_COOKIE)))!.id).toBe(userId);

    const me = await handleAuthRoute(get("/api/auth/me", { [SESSION_COOKIE]: session }), "/api/auth/me", { ...ctx(), secureCookies: false, coinpayEnabled: true });
    expect((await me!.json()).coinpay).toEqual({ enabled: true, linked: true, hasPassword: true });

    // Disconnect works for an account that also has a password.
    const disc = await handleCoinPayRoute(
      new Request("https://advis0r.test/api/v1/coinpay/disconnect", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${session}` } }),
      "/api/v1/coinpay/disconnect",
      deps(),
    );
    expect(disc!.status).toBe(200);
  });

  test("a link callback without the session that started it is refused", async () => {
    await makeUser("linker2@example.com");
    const session = (await login(ctx(), { email: "linker2@example.com", password: PASSWORD })).token!;
    identity = { sub: "sub-linker2", email: "x@example.com", name: "X" };
    const { location, stateCookie } = await startFlow("link", session);
    lastNonce = location.searchParams.get("nonce")!;
    const res = await callback(location.searchParams.get("state")!, { [COINPAY_STATE_COOKIE]: stateCookie });
    expect(res.headers.get("location")).toBe("/?coinpay_error=sign_in_first");
    const rows = await db.execute({ sql: "SELECT 1 FROM coinpay_identities WHERE sub = 'sub-linker2'", args: [] });
    expect(rows.rows.length).toBe(0);
  });

  test("a sub already bound to another account cannot be linked again", async () => {
    await makeUser("linker3@example.com");
    const session = (await login(ctx(), { email: "linker3@example.com", password: PASSWORD })).token!;
    identity = { sub: "sub-new", email: "fresh@example.com", name: "Fresh" };
    const res = await roundTrip("link", session);
    expect(res.headers.get("location")).toBe("/?coinpay_error=linked_elsewhere");
  });

  test("disconnect is refused when CoinPay is the only way in", async () => {
    identity = { sub: "sub-only", email: "only@example.com", name: "Only" };
    const res = await roundTrip("login");
    const session = cookieValue(res, SESSION_COOKIE);
    const disc = await handleCoinPayRoute(
      new Request("https://advis0r.test/api/v1/coinpay/disconnect", { method: "POST", headers: { cookie: `${SESSION_COOKIE}=${session}` } }),
      "/api/v1/coinpay/disconnect",
      deps(),
    );
    expect(disc!.status).toBe(409);
  });

  test("nobody can sign up with a .invalid placeholder-style address", () => {
    expect(isValidEmail("usrabc@coinpay.advis0r.invalid")).toBe(false);
  });
});
