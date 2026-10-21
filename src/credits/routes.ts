/**
 * Credits HTTP surface (PRD v3 §8).
 *
 *   GET  /api/credits              -> balance, packages, recent ledger
 *   POST /api/credits/checkout     -> { packageId } -> CoinPay hosted checkout session URL
 *   POST /api/webhook/coinpay      -> CoinPayPortal callback (signed, unauthenticated)
 *
 * The webhook is the only unauthenticated route here and the only one that
 * grants credits, so it carries the strictest handling: signature first, then
 * the credit amount is read from our own purchase row rather than the payload.
 */
import type { Client } from "@libsql/client";
import { newId } from "../auth/crypto.ts";
import { guardResponse, requireUser } from "../auth/routes.ts";
import { CoinPayClient, parseWebhook, type WebhookEvent } from "./coinpay.ts";
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
    const ev = parseWebhook(body);
    const purchaseRef = String(ev.metadata.purchase_id ?? "");
    if (!ev.paymentId && !ev.checkoutSessionId && !purchaseRef) {
      return json({ error: "missing payment id" }, 400);
    }

    const purchase = await findPurchase(db, ev);
    if (!purchase) {
      // Unknown payment: acknowledge so the provider stops retrying, but never
      // grant credits for a purchase we have no record of.
      console.warn(`[credits] webhook for unknown payment ${ev.checkoutSessionId || ev.paymentId || purchaseRef}`);
      return json({ ok: true, ignored: true });
    }
    // The purchase's own reference (the cs_ session id, or the payment id for
    // purchases made before checkout sessions) is the idempotency key, so one
    // purchase credits once however many events arrive.
    const ref = String(purchase.payment_id);
    const isSession = ref.startsWith("cs_");

    if (ev.outcome === "confirmed") {
      // Credit amount comes from OUR row, not the payload — a forged body must
      // not be able to name its own credit total.
      const credits = Number(purchase.credits);
      const userId = String(purchase.user_id);
      const result = await creditPurchase(db, userId, ref, credits);
      await db.execute({
        sql: "UPDATE credit_purchases SET status = 'confirmed', updated_at = ? WHERE id = ?",
        args: [new Date().toISOString(), String(purchase.id)],
      });
      console.log(
        `[credits] purchase ${String(purchase.id)} (${ref}) ${ev.type || "confirmed"}: ${credits} credits for ${userId} (newly credited: ${result.credited})`,
      );
      return json({ ok: true, credited: result.credited });
    }

    // A session outlives one payment attempt (the buyer can pick another coin),
    // so only a pre-session purchase is failed by a payment-level failure.
    if (ev.outcome === "failed" && !isSession && String(purchase.status) !== "confirmed") {
      await db.execute({
        sql: "UPDATE credit_purchases SET status = 'failed', updated_at = ? WHERE id = ?",
        args: [new Date().toISOString(), String(purchase.id)],
      });
    }
    return json({ ok: true, status: ev.outcome });
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
      paymentMethods: "crypto or PayPal",
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

    try {
      const session = await openCreditCheckout(db, coinpay, deps.appUrl, user, pkg);
      return json({
        ok: true,
        purchaseId: session.purchaseId,
        checkoutSessionId: session.sessionId,
        // Kept as paymentUrl for existing clients: the hosted checkout page.
        paymentUrl: session.url,
        checkoutUrl: session.url,
        expiresAt: session.expiresAt,
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

type Row = Record<string, unknown>;

/**
 * Find the purchase a webhook is about: by checkout session id (stored as the
 * purchase's payment_id at create time), then our purchase_id in metadata, then
 * the CoinPay payment id for purchases made before checkout sessions. A
 * purchase owned by a different account than the event names is never matched.
 */
export async function findPurchase(db: Client, ev: WebhookEvent): Promise<Row | null> {
  const cols = "id, user_id, payment_id, credits, status";
  const by = async (col: "payment_id" | "id", val: string) => {
    if (!val) return null;
    const rs = await db.execute({ sql: `SELECT ${cols} FROM credit_purchases WHERE ${col} = ?`, args: [val] });
    return (rs.rows[0] as Row | undefined) ?? null;
  };
  const found =
    (await by("payment_id", ev.checkoutSessionId)) ??
    (await by("id", String(ev.metadata.purchase_id ?? ""))) ??
    (await by("payment_id", ev.paymentId));
  if (!found) return null;
  if (ev.accountId && ev.accountId !== String(found.user_id)) return null;
  return found;
}

/**
 * Open a CoinPay hosted checkout session for a credit package and record the
 * purchase under its cs_ id. The buyer's email is the CoinPay customer and the
 * advis0r user id is the account; our purchase id rides in metadata.
 */
export async function openCreditCheckout(
  db: Client,
  coinpay: CoinPayClient,
  appUrl: string,
  user: { id: string; email: string },
  pkg: { id: string; label: string; credits: number; usd: number },
): Promise<{ purchaseId: string; sessionId: string; url: string; expiresAt?: string }> {
  const base = appUrl.replace(/\/$/, "");
  const purchaseId = newId("pur");
  const session = await coinpay.createCheckoutSession({
    amountUsd: pkg.usd,
    description: `advis0r.com: ${pkg.label}`,
    customerEmail: user.email,
    accountId: user.id,
    // Only our own identifiers, never anything user-supplied: this metadata
    // comes back on the webhook.
    metadata: { purchase_id: purchaseId, user_id: user.id, package_id: pkg.id, credits: String(pkg.credits) },
    successUrl: `${base}/?credits=pending&session={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${base}/`,
    idempotencyKey: `advis0r-${purchaseId}`,
  });
  await db.execute({
    sql: `INSERT INTO credit_purchases
          (id, user_id, payment_id, package_id, credits, amount_usd, blockchain, status, payment_url, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    args: [
      purchaseId, user.id, session.sessionId, pkg.id, pkg.credits, pkg.usd,
      "CHECKOUT", "pending", session.url, new Date().toISOString(),
    ],
  });
  return { purchaseId, sessionId: session.sessionId, url: session.url, expiresAt: session.expiresAt };
}
