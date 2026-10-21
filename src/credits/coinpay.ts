/**
 * CoinPayPortal integration for credit purchases (PRD v3 §8).
 *
 * Payment flow:
 *   1. user picks a package     -> POST /api/credits/checkout
 *   2. we open a checkout session (POST /api/checkout/sessions) and store its
 *      cs_ id on the purchase row
 *   3. user pays on CoinPay's hosted page, in any coin the business holds or
 *      PayPal -> CoinPay POSTs a webhook carrying checkout_session_id
 *   4. we verify the signature and credit the ledger (idempotent per purchase)
 *
 * The webhook is the only path that grants credits, and it is treated as
 * untrusted input: the HMAC signature is verified before the body is parsed for
 * meaning, and the credit amount is taken from **our** stored purchase record
 * rather than from the webhook payload — otherwise anyone able to forge a body
 * could name their own credit total.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_BASE_URL = "https://coinpayportal.com/api";

/**
 * Chain codes CoinPayPortal accepts. These are symbol-style codes ("ETH",
 * "USDC_ETH") — not chain names like "ethereum", which the API rejects.
 * Fetched live from /supported-coins on 2026-07-24.
 */
export const SUPPORTED_CHAINS = [
  "BTC", "ETH", "SOL", "POL", "BNB", "ADA", "BCH", "DOGE",
  "USDC_ETH", "USDC_POL", "USDC_SOL", "USDT_ETH", "USDT_POL", "USDT_SOL",
] as const;

/** Stablecoin on a low-fee chain: predictable amount, cheap to send. */
export const DEFAULT_CHAIN = "USDC_POL";

export function isSupportedChain(chain: string): boolean {
  return (SUPPORTED_CHAINS as readonly string[]).includes(chain);
}

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
  /** Hosted checkout page. */
  paymentUrl: string;
  /** On-chain destination, so the UI can show pay-by-address as a fallback. */
  paymentAddress?: string;
  cryptoAmount?: string;
  cryptoCurrency?: string;
  expiresAt?: string;
  raw: unknown;
}

/** Every checkout from this site carries this as its CoinPay property. */
export const PAYMENT_PROPERTY = "advis0r.com";

export const CHECKOUT_WINDOW_MINUTES = 60;

export interface CheckoutSessionInput {
  amountUsd: number;
  description: string;
  customerEmail: string;
  accountId: string;
  metadata: Record<string, string>;
  successUrl: string;
  cancelUrl: string;
  idempotencyKey?: string;
}

export interface CreatedSession {
  sessionId: string;
  /** CoinPay's hosted checkout page (any coin or PayPal). */
  url: string;
  expiresAt?: string;
  methods: string[];
}

/** The POST /api/checkout/sessions body. */
export function checkoutSessionBody(input: CheckoutSessionInput): Record<string, unknown> {
  return {
    amount: input.amountUsd,
    currency: "USD",
    description: input.description,
    customer_email: input.customerEmail,
    account_id: input.accountId,
    property: PAYMENT_PROPERTY,
    metadata: input.metadata,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
    expires_in_minutes: CHECKOUT_WINDOW_MINUTES,
  };
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
    if (!paymentId) throw new Error("CoinPayPortal returned no payment id");
    // The API returns no hosted-page URL; the portal serves one at /pay/<id>.
    // The on-chain address is carried through as well so the UI can fall back
    // to showing address + amount if the hosted page is ever unavailable.
    const portalUrl = this.baseUrl.replace(/\/api\/?$/, "");
    return {
      paymentId,
      paymentUrl: `${portalUrl}/pay/${paymentId}`,
      paymentAddress: payment?.payment_address ? String(payment.payment_address) : undefined,
      cryptoAmount: payment?.crypto_amount != null ? String(payment.crypto_amount) : undefined,
      cryptoCurrency: payment?.crypto_currency ? String(payment.crypto_currency) : undefined,
      expiresAt: payment?.expires_at ? String(payment.expires_at) : undefined,
      raw: body,
    };
  }

  /** Open a hosted checkout session; the buyer picks the coin (or PayPal) on CoinPay. */
  async createCheckoutSession(input: CheckoutSessionInput): Promise<CreatedSession> {
    if (!this.configured) throw new Error("CoinPayPortal is not configured");
    const res = await fetch(`${this.baseUrl}/checkout/sessions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
        ...(input.idempotencyKey ? { "Idempotency-Key": input.idempotencyKey } : {}),
      },
      body: JSON.stringify(checkoutSessionBody(input)),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !body?.id || !body?.url) {
      throw new Error(
        `CoinPay checkout session ${res.status}: ${String(body?.code ?? "")} ${String(body?.error ?? "").slice(0, 200)}`.trim(),
      );
    }
    // Only ever send buyers to CoinPay's own origin.
    const origin = new URL(this.baseUrl).origin;
    const url = new URL(String(body.url), origin);
    if (url.origin !== origin) throw new Error("CoinPay checkout session returned a foreign url");
    return {
      sessionId: String(body.id),
      url: url.toString(),
      expiresAt: body.expires_at ? String(body.expires_at) : undefined,
      methods: Array.isArray(body.methods) ? body.methods.map((m: unknown) => String((m as any)?.code ?? (m as any)?.method ?? m)) : [],
    };
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
const CONFIRMED = new Set(["confirmed", "forwarded", "completed", "paid", "success", "succeeded"]);
const FAILED = new Set(["failed", "cancelled", "canceled", "expired", "refunded"]);

export type PaymentOutcome = "confirmed" | "failed" | "pending";

export function classifyStatus(status: unknown): PaymentOutcome {
  const s = String(status ?? "").toLowerCase();
  if (CONFIRMED.has(s)) return "confirmed";
  if (FAILED.has(s)) return "failed";
  return "pending";
}

export interface WebhookEvent {
  /** CoinPay payment id (or PayPal transaction id); never the event id. */
  paymentId: string;
  checkoutSessionId: string;
  accountId: string;
  type: string;
  outcome: PaymentOutcome;
  metadata: Record<string, unknown>;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Read a webhook body. CoinPay nests the payment under `data` and the top-level
 * `id` is the EVENT id, so `data` is read first and the flat shape (older test
 * sender) is the fallback. `forwarded` counts as paid: it follows `confirmed`
 * and is the one CoinPay keeps retrying.
 */
export function parseWebhook(body: any): WebhookEvent {
  const nested = body?.data && typeof body.data === "object" ? body.data : null;
  const d = nested ?? body?.payment ?? body ?? {};
  const metadata = (d?.metadata ?? body?.metadata ?? {}) as Record<string, unknown>;
  const paymentId = String(d?.payment_id ?? (nested ? "" : d?.id ?? body?.payment_id) ?? "");
  const type = String(body?.type ?? body?.event ?? "");
  const status = d?.status ?? body?.status ?? (type.startsWith("payment.") ? type.slice(8) : type);
  return {
    paymentId,
    checkoutSessionId: String(d?.checkout_session_id ?? metadata.checkout_session_id ?? ""),
    accountId: String(d?.account_id ?? metadata.account_id ?? ""),
    type,
    outcome: classifyStatus(status),
    metadata,
  };
}
