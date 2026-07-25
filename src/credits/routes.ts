/**
 * Credits HTTP surface (PRD v3 §8).
 *
 *   GET  /api/credits              -> balance, packages, recent ledger
 *   POST /api/credits/checkout     -> { packageId, blockchain } -> hosted payment URL
 *   POST /api/webhook/coinpay      -> CoinPayPortal callback (signed, unauthenticated)
 *
 * The webhook is the only unauthenticated route here and the only one that
 * grants credits, so it carries the strictest handling: signature first, then
 * the credit amount is read from our own purchase row rather than the payload.
 */
import type { Client } from "@libsql/client";
import { newId } from "../auth/crypto.ts";
import { guardResponse, requireUser } from "../auth/routes.ts";
import { CoinPayClient, DEFAULT_CHAIN, SUPPORTED_CHAINS, isSupportedChain, parseWebhook } from "./coinpay.ts";
import {
  CREDIT_PACKAGES,
  creditPurchase,
  findPackage,
  getBalance,
  recentLedger,
} from "./ledger.ts";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

export interface CreditsDeps {
  db: Client;
  coinpay: CoinPayClient;
  appUrl: string;
}

/** The webhook URL registered with CoinPayPortal. */
export const WEBHOOK_PATH = "/api/webhook/coinpay";

export async function handleCreditsRoute(
  req: Request,
  path: string,
  deps: CreditsDeps,
): Promise<Response | null> {
  const isWebhook = path === WEBHOOK_PATH;
  if (!path.startsWith("/api/credits") && !isWebhook) return null;
  const { db, coinpay } = deps;

  /* ---- webhook: unauthenticated but signed ---- */
  if (isWebhook) {
    if (req.method !== "POST") return json({ error: "method not allowed" }, 405);
    // Read the raw body: the signature covers the exact bytes, so re-serializing
    // parsed JSON would produce a different string and fail verification.
    const raw = await req.text();
    const signature =
      req.headers.get("x-coinpay-signature") ??
      req.headers.get("x-signature") ??
      req.headers.get("coinpay-signature") ??
      "";

    if (!coinpay.verifyWebhookSignature(raw, signature)) {
      console.error("[credits] webhook rejected: bad or missing signature");
      return json({ error: "invalid signature" }, 401);
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const { paymentId, outcome } = parseWebhook(body);
    if (!paymentId) return json({ error: "missing payment id" }, 400);

    const rs = await db.execute({
      sql: "SELECT user_id, credits, status FROM credit_purchases WHERE payment_id = ?",
      args: [paymentId],
    });
    const purchase = rs.rows[0];
    if (!purchase) {
      // Unknown payment: acknowledge so the provider stops retrying, but never
      // grant credits for a purchase we have no record of.
      console.warn(`[credits] webhook for unknown payment ${paymentId}`);
      return json({ ok: true, ignored: true });
    }

    if (outcome === "confirmed") {
      // Credit amount comes from OUR row, not the payload — a forged body must
      // not be able to name its own credit total.
      const credits = Number(purchase.credits);
      const userId = String(purchase.user_id);
      const result = await creditPurchase(db, userId, paymentId, credits);
      await db.execute({
        sql: "UPDATE credit_purchases SET status = 'confirmed', updated_at = ? WHERE payment_id = ?",
        args: [new Date().toISOString(), paymentId],
      });
      console.log(
        `[credits] payment ${paymentId} confirmed: ${credits} credits for ${userId} (newly credited: ${result.credited})`,
      );
      return json({ ok: true, credited: result.credited });
    }

    if (outcome === "failed") {
      await db.execute({
        sql: "UPDATE credit_purchases SET status = 'failed', updated_at = ? WHERE payment_id = ?",
        args: [new Date().toISOString(), paymentId],
      });
    }
    return json({ ok: true, status: outcome });
  }

  /* ---- everything else requires a signed-in user ---- */
  const guard = await requireUser(req, db);
  if (guard.failure) return guardResponse(guard.failure);
  const user = guard.user!;

  if (path === "/api/credits" && req.method === "GET") {
    const balance = await getBalance(db, user.id);
    return json({
      ...balance,
      packages: CREDIT_PACKAGES,
      paymentsEnabled: coinpay.configured,
      chains: SUPPORTED_CHAINS,
      defaultChain: DEFAULT_CHAIN,
      ledger: await recentLedger(db, user.id),
    });
  }

  if (path === "/api/credits/checkout" && req.method === "POST") {
    if (!coinpay.configured) {
      return json({ error: "Credit purchases are not available right now." }, 503);
    }
    let body: Record<string, unknown> = {};
    try {
      body = ((await req.json()) ?? {}) as Record<string, unknown>;
    } catch {
      body = {};
    }
    const pkg = findPackage(String(body.packageId ?? ""));
    if (!pkg) return json({ error: "Unknown credit package." }, 400);
    // Chain codes are validated against the provider's list rather than passed
    // through: an unsupported value would fail at the API with an opaque error.
    const blockchain = String(body.blockchain || DEFAULT_CHAIN);
    if (!isSupportedChain(blockchain)) {
      return json({ error: "Unsupported payment chain.", chains: SUPPORTED_CHAINS }, 400);
    }

    try {
      const payment = await coinpay.createPayment({
        amountUsd: pkg.usd,
        blockchain,
        description: `advis0r.com — ${pkg.label}`,
        // Only our own identifiers, never anything user-supplied: this metadata
        // comes back on the webhook.
        metadata: { user_id: user.id, package_id: pkg.id, credits: String(pkg.credits) },
        webhookUrl: `${deps.appUrl.replace(/\/$/, "")}${WEBHOOK_PATH}`,
        redirectUrl: `${deps.appUrl.replace(/\/$/, "")}/?credits=pending`,
      });

      await db.execute({
        sql: `INSERT INTO credit_purchases
              (id, user_id, payment_id, package_id, credits, amount_usd, blockchain, status, payment_url, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [
          newId("pur"), user.id, payment.paymentId, pkg.id, pkg.credits, pkg.usd,
          blockchain, "pending", payment.paymentUrl, new Date().toISOString(),
        ],
      });

      return json({
        ok: true,
        paymentId: payment.paymentId,
        paymentUrl: payment.paymentUrl,
        paymentAddress: payment.paymentAddress,
        cryptoAmount: payment.cryptoAmount,
        cryptoCurrency: payment.cryptoCurrency,
        expiresAt: payment.expiresAt,
        credits: pkg.credits,
        amountUsd: pkg.usd,
      });
    } catch (err) {
      console.error(`[credits] checkout failed for ${user.id}: ${String(err).slice(0, 200)}`);
      return json({ error: "Could not start the payment. Try again shortly." }, 502);
    }
  }

  return json({ error: "not found" }, 404);
}
