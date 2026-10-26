/**
 * Credit codes and invites, against a real database: codes land in
 * credits_ledger exactly once, monthly codes pay each month, and an invite
 * pays both sides once, only for a new account that confirmed its email and
 * passes the abuse gates.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openClient } from "../src/db/index.ts";
import type { Mailer, MailMessage, MailResult } from "../src/auth/email.ts";
import { handleAuthRoute, SESSION_COOKIE } from "../src/auth/routes.ts";
import { login } from "../src/auth/service.ts";
import { getBalance } from "../src/credits/ledger.ts";
import {
  acceptInvite,
  canonicalInvite,
  createInvite,
  isThrowaway,
  mintCode,
  redeemCode,
  sameMailbox,
} from "../src/credits/codes.ts";
import { handleCreditsRoute } from "../src/credits/routes.ts";
import { handleInvitePages } from "../src/credits/pages.ts";
import { CoinPayClient } from "../src/credits/coinpay.ts";

const dir = mkdtempSync(join(tmpdir(), "advis0r-codes-"));
let db: Client;

class FakeMailer {
  sent: MailMessage[] = [];
  get transport() { return "resend" as const; }
  get configured() { return true; }
  async send(msg: MailMessage): Promise<MailResult> {
    this.sent.push(msg);
    return { ok: true, transport: "resend", id: `m_${this.sent.length}` };
  }
}
const mailer = new FakeMailer();
const deps = () => ({ db, mailer: mailer as unknown as Mailer, appUrl: "http://local", secureCookies: false });
let ipN = 0;
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.1.${++ipN % 250}.${ipN % 200}`, ...headers },
    body: JSON.stringify(body),
  });

const PASSWORD = "a-long-enough-passphrase";
const day = 86_400_000;

async function makeUser(email: string, opts: { verified?: boolean; ageDays?: number } = {}): Promise<string> {
  const id = `usr_${email.replace(/[^a-z0-9]/gi, "")}`;
  const created = new Date(Date.now() - (opts.ageDays ?? 10) * day).toISOString();
  await db.execute({
    sql: `INSERT INTO users (id, email, password_hash, created_at, updated_at, email_verified_at) VALUES (?,?,?,?,?,?)`,
    args: [id, email, await Bun.password.hash(PASSWORD), created, created, opts.verified === false ? null : created],
  });
  return id;
}

async function sessionCookieFor(email: string): Promise<string> {
  const r = await login({ db, mailer: mailer as unknown as Mailer, appUrl: "http://local" }, { email, password: PASSWORD });
  return `${SESSION_COOKIE}=${encodeURIComponent(r.token!)}`;
}

/** Sign up through the real route, then open the emailed verification link. */
async function signupAndVerify(email: string, headers: Record<string, string> = {}, body: Record<string, unknown> = {}) {
  const before = mailer.sent.length;
  const res = await handleAuthRoute(
    post("/api/auth/signup", { email, password: PASSWORD, first_name: "New", last_name: "Person", ...body }, headers),
    "/api/auth/signup",
    deps(),
  );
  expect(res!.status).toBe(200);
  const mail = mailer.sent.slice(before).find((m) => m.to === email)!;
  const token = /token=([^"&\s<]+)/.exec(mail.text ?? mail.html ?? "")![1]!;
  const verify = await handleAuthRoute(post("/api/auth/verify", { token: decodeURIComponent(token) }), "/api/auth/verify", deps());
  const out = await verify!.json();
  const rs = await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: [email] });
  return { id: String(rs.rows[0]!.id), verify: out, token: decodeURIComponent(token) };
}

const ledgerRows = async (userId: string, reason: string) =>
  (await db.execute({ sql: "SELECT delta, idem FROM credits_ledger WHERE user_id = ? AND reason = ?", args: [userId, reason] })).rows;

beforeAll(async () => {
  process.env.INVITE_BONUS_CREDITS = "50";
  // openClient (not createClient) so the packages get bun:sqlite on the same file.
  db = openClient(`file:${join(dir, "codes.db")}`);
  await migrate(db);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("credit codes", () => {
  test("a one-off code pays once into credits_ledger; a second redeem is refused", async () => {
    const a = await makeUser("code-a@example.com");
    const b = await makeUser("code-b@example.com");
    const minted = await mintCode(db, { credits: 300, label: "test" });
    expect(minted.code).toMatch(/^ADV-/);

    const before = (await getBalance(db, a)).balance;
    const r = await redeemCode(db, a, minted.code.toLowerCase().replaceAll("-", " "));
    expect(r).toMatchObject({ ok: true, credits: 300, monthly: false });
    expect((await getBalance(db, a)).balance).toBe(before + 300);

    expect(await redeemCode(db, a, minted.code)).toMatchObject({ ok: false, reason: "already_redeemed" });
    expect(await redeemCode(db, b, minted.code)).toMatchObject({ ok: false, reason: "used_up" });
    expect(await redeemCode(db, b, "ADV-0000-0000-0000-0000")).toMatchObject({ ok: false, reason: "invalid" });
    expect(await redeemCode(db, b, "'; drop table users; --")).toMatchObject({ ok: false, reason: "invalid" });
    expect(await ledgerRows(a, "code")).toHaveLength(1);
  });

  test("a lost ledger write is repaid on the next try, never twice", async () => {
    const u = await makeUser("code-lost@example.com");
    const minted = await mintCode(db, { credits: 40 });
    await redeemCode(db, u, minted.code);
    await db.execute({ sql: "DELETE FROM credits_ledger WHERE user_id = ? AND reason = 'code'", args: [u] });
    expect(await redeemCode(db, u, minted.code)).toMatchObject({ ok: false, reason: "already_redeemed" });
    expect(await ledgerRows(u, "code")).toHaveLength(1);
    await redeemCode(db, u, minted.code);
    expect(await ledgerRows(u, "code")).toHaveLength(1);
  });

  test("a monthly code pays each calendar month for its months, then stops", async () => {
    const u = await makeUser("code-monthly@example.com");
    const minted = await mintCode(db, { credits: 25, monthly: true, months: 2, maxRedemptions: 5 });
    const july = new Date("2026-07-15T00:00:00Z");
    expect(await redeemCode(db, u, minted.code, july)).toMatchObject({ ok: true, credits: 25, monthly: true, months: 2 });
    await getBalance(db, u, july);
    await getBalance(db, u, new Date("2026-08-02T00:00:00Z"));
    await getBalance(db, u, new Date("2026-08-20T00:00:00Z"));
    await getBalance(db, u, new Date("2026-09-02T00:00:00Z"));
    const rows = await ledgerRows(u, "code_monthly");
    expect(rows.map((r) => String(r.idem)).sort()).toEqual([`${minted.id}:2026-07`, `${minted.id}:2026-08`]);
  });

  test("POST /api/credits/redeem needs a session and reports the new balance", async () => {
    await makeUser("code-http@example.com");
    const cookie = await sessionCookieFor("code-http@example.com");
    const minted = await mintCode(db, { credits: 7 });
    const coinpay = new CoinPayClient({ apiKey: "", webhookSecret: "" });
    const call = (headers: Record<string, string>) =>
      handleCreditsRoute(post("/api/credits/redeem", { code: minted.code }, headers), "/api/credits/redeem", { db, coinpay, appUrl: "http://local" });
    expect((await call({}))!.status).toBe(401);
    const ok = await call({ cookie });
    expect(ok!.status).toBe(200);
    expect((await ok!.json()).credits).toBe(7);
    const again = await call({ cookie });
    expect(again!.status).toBe(409);
  });
});

describe("invites", () => {
  test("an invited signup pays both sides once, after the email is confirmed, from any browser", async () => {
    const inviter = await makeUser("inviter@acme.com");
    const made = await createInvite(db, inviter, "for carol", "http://local");
    expect(made.ok).toBe(true);
    const code = (made as { code: string }).code;
    expect(canonicalInvite(code.toLowerCase())).toBe(code);

    // The /i/<code> landing sets the cookie the signup reads.
    const landing = await handleInvitePages(new Request(`http://local/i/${code}`), `/i/${code}`, {
      db, appUrl: "http://local", secureCookies: false,
    });
    expect(landing!.status).toBe(200);
    const setCookie = landing!.headers.get("set-cookie")!;
    expect(setCookie).toContain(`advis0r_invite=${code}`);

    const inviterBefore = (await getBalance(db, inviter)).balance;
    const invitee = await signupAndVerify("carol@other.org", { cookie: setCookie.split(";")[0]! });
    expect(invitee.verify).toMatchObject({ ok: true, inviteBonus: 50 });
    expect(await ledgerRows(invitee.id, "invite_bonus")).toHaveLength(1);
    expect((await getBalance(db, inviter)).balance).toBe(inviterBefore + 50);

    // Settled once: nothing pending, no second payment however often it runs.
    const pending = await db.execute({ sql: "SELECT * FROM pending_invites WHERE user_id = ?", args: [invitee.id] });
    expect(pending.rows).toHaveLength(0);
    expect(await ledgerRows(inviter, "invite_bonus")).toHaveLength(1);

    // A second invite for the same account is refused and pays nobody.
    const other = await makeUser("other-inviter@acme.com");
    const second = await createInvite(db, other, "", "http://local");
    const again = await acceptInvite(db, (second as { code: string }).code, { id: invitee.id, email: "carol@other.org" });
    expect(again.invite).toMatchObject({ ok: false, reason: "already_invited" });
    expect(await ledgerRows(other, "invite_bonus")).toHaveLength(0);

    // The spent invite pays nobody for a third account.
    const reuse = await signupAndVerify("dave@third.org", {}, { inviteCode: code });
    expect(reuse.verify.inviteBonus).toBe(0);
    expect(await ledgerRows(reuse.id, "invite_bonus")).toHaveLength(0);
  });

  test("abuse gates: same mailbox, throwaway address, a brand-new inviter", async () => {
    const owner = await makeUser("john.smith@gmail.com");
    const inv1 = (await createInvite(db, owner, "", "http://local")) as { code: string };
    const alias = await signupAndVerify("johnsmith+alt@gmail.com", {}, { inviteCode: inv1.code });
    expect(alias.verify.inviteBonus).toBe(0);
    const bonus = await db.execute({ sql: "SELECT status FROM invite_bonuses WHERE user_id = ?", args: [alias.id] });
    expect(String(bonus.rows[0]!.status)).toBe("same_mailbox");

    const inv2 = (await createInvite(db, owner, "", "http://local")) as { code: string };
    const temp = await signupAndVerify("x@mailinator.com", {}, { inviteCode: inv2.code });
    expect(temp.verify.inviteBonus).toBe(0);

    const fresh = await makeUser("fresh@acme.com", { ageDays: 0 });
    const inv3 = (await createInvite(db, fresh, "", "http://local")) as { code: string };
    const young = await signupAndVerify("young@else.org", {}, { inviteCode: inv3.code });
    expect(young.verify.inviteBonus).toBe(0);
    const s = await db.execute({ sql: "SELECT status FROM invite_bonuses WHERE user_id = ?", args: [young.id] });
    expect(String(s.rows[0]!.status)).toBe("inviter_too_new");

    expect(sameMailbox("A.B@googlemail.com", "ab+x@gmail.com")).toBe(true);
    expect(isThrowaway("a@sub.yopmail.com")).toBe(true);
  });

  test("an existing account signing up again with an invite gets nothing", async () => {
    const inviter = await makeUser("inviter2@acme.com");
    await makeUser("already@else.org");
    const inv = (await createInvite(db, inviter, "", "http://local")) as { code: string };
    const res = await handleAuthRoute(
      post("/api/auth/signup", { email: "already@else.org", password: PASSWORD, first_name: "A", last_name: "B", inviteCode: inv.code }),
      "/api/auth/signup",
      deps(),
    );
    expect(res!.status).toBe(200);
    const pending = await db.execute("SELECT COUNT(*) AS n FROM pending_invites WHERE user_id = 'usr_alreadyelseorg'");
    expect(Number(pending.rows[0]!.n)).toBe(0);
  });

  test("/api/invites: quota of three, verified accounts only", async () => {
    await makeUser("quota@acme.com");
    await makeUser("unverified@acme.com", { verified: false });
    const coinpay = new CoinPayClient({ apiKey: "", webhookSecret: "" });
    const d = { db, coinpay, appUrl: "http://local" };
    const call = (method: string, cookie: string) =>
      handleCreditsRoute(
        method === "GET"
          ? new Request("http://local/api/invites", { headers: { cookie } })
          : post("/api/invites", { note: "x" }, { cookie }),
        "/api/invites",
        d,
      );
    const unverified = await sessionCookieFor("unverified@acme.com");
    expect((await call("POST", unverified))!.status).toBe(403);
    const cookie = await sessionCookieFor("quota@acme.com");
    for (let i = 0; i < 3; i++) {
      const r = await call("POST", cookie);
      expect(r!.status).toBe(200);
      expect((await r!.json()).url).toMatch(/^http:\/\/local\/i\/INV-/);
    }
    expect((await call("POST", cookie))!.status).toBe(409);
    const summary = await (await call("GET", cookie))!.json();
    expect(summary.quota).toEqual({ total: 3, used: 3, left: 0 });
    expect(summary.affiliateUrl).toMatch(/^http:\/\/local\/\?ref=/);
  });

  test("/i/<garbage> is a 404 and sets no cookie", async () => {
    const res = await handleInvitePages(new Request("http://local/i/nope"), "/i/nope", { db, appUrl: "http://local", secureCookies: false });
    expect(res!.status).toBe(404);
    expect(res!.headers.get("set-cookie")).toBeNull();
  });
});
