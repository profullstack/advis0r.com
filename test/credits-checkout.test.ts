/**
 * CoinPay hosted checkout sessions for credit packages: the session payload,
 * and the webhook settling a purchase by session id exactly once.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/index.ts";
import { CoinPayClient, PAYMENT_PROPERTY, checkoutSessionBody } from "../src/credits/coinpay.ts";
import { WEBHOOK_PATH, handleCreditsRoute, openCreditCheckout } from "../src/credits/routes.ts";
import { CREDIT_PACKAGES, getBalance } from "../src/credits/ledger.ts";

const SECRET = "whsec_checkout_test";
const coinpay = new CoinPayClient({ apiKey: "cp_live_test", webhookSecret: SECRET, baseUrl: "https://coinpayportal.com/api" });
const APP = "https://advis0r.com";
const USER = { id: "usr_buyer", email: "buyer@example.com" };
const OTHER = { id: "usr_other", email: "other@example.com" };

const dir = mkdtempSync(join(tmpdir(), "advis0r-checkout-"));
let db: Client;

beforeAll(async () => {
  db = createClient({ url: `file:${join(dir, "checkout.sqlite")}` });
  await migrate(db);
  for (const u of [USER, OTHER]) {
    await db.execute({
      sql: "INSERT INTO users (id, email, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?)",
      args: [u.id, u.email, "x", new Date().toISOString(), new Date().toISOString()],
    });
  }
});

afterAll(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

function sign(body: string): string {
  const t = Math.floor(Date.now() / 1000);
  return `t=${t},v1=${createHmac("sha256", SECRET).update(`${t}.${body}`).digest("hex")}`;
}

async function webhook(payload: unknown): Promise<{ status: number; body: any }> {
  const raw = JSON.stringify(payload);
  const res = await handleCreditsRoute(
    new Request(`${APP}${WEBHOOK_PATH}`, { method: "POST", body: raw, headers: { "x-coinpay-signature": sign(raw) } }),
    WEBHOOK_PATH,
    { db, coinpay, appUrl: APP },
  );
  return { status: res!.status, body: await res!.json() };
}

function event(type: string, status: string, data: Record<string, unknown>) {
  return { id: `evt_x_${Date.now()}`, type, data: { payment_id: "pay_1", status, amount: 10, amount_usd: 10, ...data } };
}

async function openWithFakeCoinPay(user: { id: string; email: string }, sessionId: string) {
  const sent: any[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) });
    return new Response(
      JSON.stringify({ success: true, id: sessionId, url: `https://coinpayportal.com/checkout/${sessionId}`, status: "open", methods: ["USDC_POL", "BTC", "PAYPAL"], expires_at: "2030-01-01T00:00:00Z" }),
      { status: 201, headers: { "content-type": "application/json" } },
    );
  }) as typeof fetch;
  try {
    const out = await openCreditCheckout(db, coinpay, APP, user, CREDIT_PACKAGES[0]!);
    return { out, sent };
  } finally {
    globalThis.fetch = real;
  }
}

describe("checkout session payload", () => {
  test("carries email, account, property and our purchase id", () => {
    const body = checkoutSessionBody({
      amountUsd: 10, description: "advis0r.com: 1,000 credits", customerEmail: USER.email, accountId: USER.id,
      metadata: { purchase_id: "pur_1" }, successUrl: `${APP}/?credits=pending`, cancelUrl: `${APP}/`,
    });
    expect(body).toMatchObject({
      amount: 10, currency: "USD", customer_email: USER.email, account_id: USER.id, property: "advis0r.com",
      metadata: { purchase_id: "pur_1" }, expires_in_minutes: 60,
    });
    expect(PAYMENT_PROPERTY).toBe("advis0r.com");
    expect(body).not.toHaveProperty("blockchain");
  });

  test("openCreditCheckout posts a session and stores the cs_ id on the purchase", async () => {
    const { out, sent } = await openWithFakeCoinPay(USER, "cs_buyer000000000000000001");
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toBe("https://coinpayportal.com/api/checkout/sessions");
    expect(sent[0].init.headers.Authorization).toBe("Bearer cp_live_test");
    expect(sent[0].body).toMatchObject({
      customer_email: USER.email, account_id: USER.id, property: "advis0r.com",
      metadata: { purchase_id: out.purchaseId, user_id: USER.id },
    });
    expect(sent[0].body.success_url).toContain("{CHECKOUT_SESSION_ID}");
    expect(out.url).toBe("https://coinpayportal.com/checkout/cs_buyer000000000000000001");
    const rs = await db.execute({ sql: "SELECT payment_id, status FROM credit_purchases WHERE id = ?", args: [out.purchaseId] });
    expect(rs.rows[0]).toMatchObject({ payment_id: "cs_buyer000000000000000001", status: "pending" });
  });
});

describe("webhook settles by checkout session", () => {
  test("confirmed credits once; replay and forwarded do not credit again", async () => {
    const { out } = await openWithFakeCoinPay(USER, "cs_buyer000000000000000002");
    const before = (await getBalance(db, USER.id)).balance;
    const data = { checkout_session_id: "cs_buyer000000000000000002", account_id: USER.id, customer_email: USER.email, property: "advis0r.com", metadata: { purchase_id: out.purchaseId } };

    const first = await webhook(event("payment.confirmed", "confirmed", data));
    expect(first).toMatchObject({ status: 200, body: { ok: true, credited: true } });
    const credited = (await getBalance(db, USER.id)).balance;
    expect(credited).toBeGreaterThan(before);

    expect((await webhook(event("payment.confirmed", "confirmed", data))).body.credited).toBe(false);
    expect((await webhook(event("payment.forwarded", "forwarded", data))).body.credited).toBe(false);
    expect((await getBalance(db, USER.id)).balance).toBe(credited);
    const rs = await db.execute({ sql: "SELECT status FROM credit_purchases WHERE id = ?", args: [out.purchaseId] });
    expect(rs.rows[0]!.status).toBe("confirmed");
  });

  test("pending is acknowledged without credit, and an expired attempt leaves the session open", async () => {
    const { out } = await openWithFakeCoinPay(USER, "cs_buyer000000000000000003");
    const before = (await getBalance(db, USER.id)).balance;
    const data = { checkout_session_id: "cs_buyer000000000000000003", account_id: USER.id };
    expect((await webhook(event("payment.pending", "pending", data))).body).toMatchObject({ ok: true, status: "pending" });
    expect((await webhook(event("payment.expired", "expired", data))).body).toMatchObject({ ok: true, status: "failed" });
    const rs = await db.execute({ sql: "SELECT status FROM credit_purchases WHERE id = ?", args: [out.purchaseId] });
    expect(rs.rows[0]!.status).toBe("pending");
    expect((await getBalance(db, USER.id)).balance).toBe(before);
  });

  test("an event naming a different account never credits", async () => {
    await openWithFakeCoinPay(USER, "cs_buyer000000000000000004");
    const before = (await getBalance(db, USER.id)).balance;
    const r = await webhook(event("payment.confirmed", "confirmed", { checkout_session_id: "cs_buyer000000000000000004", account_id: OTHER.id }));
    expect(r.body).toMatchObject({ ok: true, ignored: true });
    expect((await getBalance(db, USER.id)).balance).toBe(before);
  });

  test("an unknown session is acknowledged and ignored", async () => {
    const r = await webhook(event("payment.confirmed", "confirmed", { checkout_session_id: "cs_unknown", payment_id: "pay_unknown" }));
    expect(r).toMatchObject({ status: 200, body: { ok: true, ignored: true } });
  });

  test("purchases made before sessions still settle by payment id", async () => {
    const pkg = CREDIT_PACKAGES[0]!;
    await db.execute({
      sql: `INSERT INTO credit_purchases (id, user_id, payment_id, package_id, credits, amount_usd, blockchain, status, payment_url, created_at)
            VALUES (?,?,?,?,?,?,?,?,?,?)`,
      args: ["pur_legacy", OTHER.id, "pay_legacy_1", pkg.id, pkg.credits, pkg.usd, "USDC_POL", "pending", "https://coinpayportal.com/pay/pay_legacy_1", new Date().toISOString()],
    });
    const before = (await getBalance(db, OTHER.id)).balance;
    const r = await webhook({ id: "evt_legacy", type: "payment.confirmed", data: { payment_id: "pay_legacy_1", status: "confirmed", metadata: { user_id: OTHER.id } } });
    expect(r.body).toMatchObject({ ok: true, credited: true });
    expect((await getBalance(db, OTHER.id)).balance).toBe(before + pkg.credits);
  });
});
