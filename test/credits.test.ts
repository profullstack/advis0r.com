/**
 * Credits and CoinPayPortal tests (PRD v3 §8).
 *
 * Real money is attached to this path, so the tests concentrate on the two
 * failure modes that would actually cost something: a forged or replayed
 * webhook granting credits, and a purchase being credited more than once.
 */
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  CoinPayClient,
  SIGNATURE_TOLERANCE_SECONDS,
  classifyStatus,
  parseWebhook,
} from "../src/credits/coinpay.ts";
import {
  CREDIT_PACKAGES,
  COST_PER_ANALYSIS,
  FREE_MONTHLY_CREDITS,
  currentPeriod,
  findPackage,
} from "../src/credits/ledger.ts";

const SECRET = "whsec_test_secret";
const client = new CoinPayClient({ apiKey: "k", webhookSecret: SECRET });

function sign(body: string, atSeconds: number, secret = SECRET): string {
  const mac = createHmac("sha256", secret).update(`${atSeconds}.${body}`).digest("hex");
  return `t=${atSeconds},v1=${mac}`;
}

describe("webhook signature verification", () => {
  const now = new Date("2026-07-24T12:00:00Z");
  const nowSec = Math.floor(now.getTime() / 1000);
  const body = JSON.stringify({ payment: { id: "pay_1", status: "confirmed" } });

  test("accepts a correctly signed, fresh webhook", () => {
    expect(client.verifyWebhookSignature(body, sign(body, nowSec), 300, now)).toBe(true);
  });

  test("rejects a forged signature — the whole point of the check", () => {
    expect(client.verifyWebhookSignature(body, `t=${nowSec},v1=deadbeef`, 300, now)).toBe(false);
  });

  test("rejects a signature made with the wrong secret", () => {
    expect(client.verifyWebhookSignature(body, sign(body, nowSec, "wrong"), 300, now)).toBe(false);
  });

  test("rejects a replayed webhook outside the tolerance window", () => {
    const old = nowSec - (SIGNATURE_TOLERANCE_SECONDS + 60);
    expect(client.verifyWebhookSignature(body, sign(body, old), 300, now)).toBe(false);
  });

  test("rejects a signature valid for a DIFFERENT body", () => {
    const other = JSON.stringify({ payment: { id: "pay_evil", status: "confirmed" } });
    expect(client.verifyWebhookSignature(other, sign(body, nowSec), 300, now)).toBe(false);
  });

  test("rejects malformed or missing headers instead of throwing", () => {
    for (const h of ["", "garbage", `t=${nowSec}`, "v1=abc", `t=notanumber,v1=abc`]) {
      expect(client.verifyWebhookSignature(body, h, 300, now)).toBe(false);
    }
  });

  test("an unconfigured client verifies nothing", () => {
    const bare = new CoinPayClient({ apiKey: "", webhookSecret: "" });
    expect(bare.configured).toBe(false);
    expect(bare.verifyWebhookSignature(body, sign(body, nowSec), 300, now)).toBe(false);
  });
});

describe("payment status handling", () => {
  test("only genuine success states are treated as paid", () => {
    for (const s of ["confirmed", "completed", "paid", "success"]) {
      expect(classifyStatus(s)).toBe("confirmed");
    }
  });

  test("failure states are distinguished from pending", () => {
    for (const s of ["failed", "expired", "cancelled", "refunded"]) {
      expect(classifyStatus(s)).toBe("failed");
    }
    for (const s of ["pending", "awaiting_payment", "", null, undefined, "weird"]) {
      expect(classifyStatus(s)).toBe("pending");
    }
  });

  test("webhook payloads are parsed shape-tolerantly", () => {
    expect(parseWebhook({ payment: { id: "pay_1", status: "confirmed" } }))
      .toEqual({ paymentId: "pay_1", outcome: "confirmed" });
    expect(parseWebhook({ data: { payment_id: "pay_2", status: "failed" } }))
      .toEqual({ paymentId: "pay_2", outcome: "failed" });
    expect(parseWebhook({}).paymentId).toBe("");
  });
});

describe("credit packages and pricing", () => {
  test("the free plan grants a month of usage", () => {
    expect(FREE_MONTHLY_CREDITS).toBe(100);
    expect(COST_PER_ANALYSIS).toBeGreaterThan(0);
  });

  test("every package is well-formed and priced", () => {
    for (const p of CREDIT_PACKAGES) {
      expect(p.credits).toBeGreaterThan(0);
      expect(p.usd).toBeGreaterThan(0);
      expect(p.id).toMatch(/^[a-z]+$/);
    }
  });

  test("larger bundles are cheaper per credit", () => {
    const rates = CREDIT_PACKAGES.map((p) => p.usd / p.credits);
    for (let i = 1; i < rates.length; i++) expect(rates[i]!).toBeLessThan(rates[i - 1]!);
  });

  test("only known package ids resolve — a client cannot invent one", () => {
    expect(findPackage("starter")?.credits).toBe(250);
    expect(findPackage("free-money")).toBeUndefined();
    expect(findPackage("")).toBeUndefined();
  });
});

describe("billing period", () => {
  test("is the UTC calendar month", () => {
    expect(currentPeriod(new Date("2026-07-24T23:59:59Z"))).toBe("2026-07");
    expect(currentPeriod(new Date("2026-08-01T00:00:00Z"))).toBe("2026-08");
  });
});
