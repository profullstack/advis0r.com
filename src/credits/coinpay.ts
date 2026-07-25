/**
 * CoinPayPortal integration for credit purchases (PRD v3 §8).
 *
 * Payment flow:
 *   1. user picks a package  -> POST /api/credits/checkout
 *   2. we create a payment   -> CoinPayPortal returns a hosted payment URL
 *   3. user pays in crypto   -> CoinPayPortal POSTs a webhook
 *   4. we verify the signature and credit the ledger (idempotent by payment id)
 *
 * The webhook is the only path that grants credits, and it is treated as
 * untrusted input: the HMAC signature is verified before the body is parsed for
 * meaning, and the credit amount is taken from **our** stored purchase record
 * rather than from the webhook payload — otherwise anyone able to forge a body
 * could name their own credit total.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_BASE_URL = "https://coinpayportal.com/api";

/** Replay window for webhook timestamps, in seconds. */
export const SIGNATURE_TOLERANCE_SECONDS = 300;

export interface CoinPayConfig {
  apiKey: string;
  businessId?: string;
  webhookSecret: string;
  baseUrl?: string;
}

export interface CreatePaymentInput {
  amountUsd: number;
  blockchain: string;
  description: string;
  metadata?: Record<string, string>;
  webhookUrl?: string;
  redirectUrl?: string;
}

export interface CreatedPayment {
  paymentId: string;
  paymentUrl: string;
  raw: unknown;
}

export class CoinPayClient {
  constructor(private config: CoinPayConfig) {}

  get configured(): boolean {
    return Boolean(this.config.apiKey && this.config.webhookSecret);
  }

  private get baseUrl(): string {
    return this.config.baseUrl || DEFAULT_BASE_URL;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatedPayment> {
    if (!this.configured) throw new Error("CoinPayPortal is not configured");
    const res = await fetch(`${this.baseUrl}/payments/create`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        amount: input.amountUsd,
        blockchain: input.blockchain,
        description: input.description,
        metadata: input.metadata,
        webhook_url: input.webhookUrl,
        redirect_url: input.redirectUrl,
        ...(this.config.businessId ? { business_id: this.config.businessId } : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok) {
      throw new Error(
        `CoinPayPortal ${res.status}: ${String(body?.error ?? body?.message ?? "").slice(0, 200)}`,
      );
    }
    const payment = body.payment ?? body.data ?? body;
    const paymentId = String(payment?.id ?? payment?.payment_id ?? "");
    const paymentUrl = String(body.payment_url ?? body.paymentUrl ?? payment?.payment_url ?? "");
    if (!paymentId) throw new Error("CoinPayPortal returned no payment id");
    return { paymentId, paymentUrl, raw: body };
  }

  async getPayment(paymentId: string): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${this.config.apiKey}` },
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) throw new Error(`CoinPayPortal ${res.status}`);
    return (await res.json()) as Record<string, unknown>;
  }

  /**
   * Verify a webhook signature of the form `t=<unix>,v1=<hex hmac>`.
   *
   * The timestamp is part of the signed payload and is range-checked, so a
   * captured webhook cannot be replayed later to grant credits again.
   */
  verifyWebhookSignature(
    rawBody: string,
    signatureHeader: string,
    toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS,
    now: Date = new Date(),
  ): boolean {
    if (!this.config.webhookSecret || !signatureHeader) return false;

    const parts: Record<string, string> = {};
    for (const seg of signatureHeader.split(",")) {
      const idx = seg.indexOf("=");
      if (idx > 0) parts[seg.slice(0, idx).trim()] = seg.slice(idx + 1).trim();
    }
    const timestamp = parts.t;
    const provided = parts.v1;
    if (!timestamp || !provided) return false;

    const age = Math.floor(now.getTime() / 1000) - Number(timestamp);
    if (!Number.isFinite(age) || Math.abs(age) > toleranceSeconds) return false;

    const expected = createHmac("sha256", this.config.webhookSecret)
      .update(`${timestamp}.${rawBody}`)
      .digest("hex");

    // Compare over fixed-length buffers; a length mismatch must not throw or
    // short-circuit, since either would leak information about the signature.
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(provided, "utf8");
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }
}

/** Payment states CoinPayPortal reports that mean "the money arrived". */
const CONFIRMED = new Set(["confirmed", "completed", "paid", "success", "succeeded"]);
const FAILED = new Set(["failed", "cancelled", "canceled", "expired", "refunded"]);

export type PaymentOutcome = "confirmed" | "failed" | "pending";

export function classifyStatus(status: unknown): PaymentOutcome {
  const s = String(status ?? "").toLowerCase();
  if (CONFIRMED.has(s)) return "confirmed";
  if (FAILED.has(s)) return "failed";
  return "pending";
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/** Pull the payment id and status out of a webhook body, shape-tolerantly. */
export function parseWebhook(body: any): { paymentId: string; outcome: PaymentOutcome } {
  const payment = body?.payment ?? body?.data ?? body ?? {};
  const paymentId = String(payment?.id ?? payment?.payment_id ?? body?.payment_id ?? "");
  const status = payment?.status ?? body?.status ?? body?.event ?? body?.type;
  return { paymentId, outcome: classifyStatus(status) };
}
