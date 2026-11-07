/**
 * Profullstack Pass (2026-11-07): a user who deposits $99 into their own CoinPay
 * wallet gets a free month on every Profullstack property. advis0r is
 * pay-as-you-go, so the pass pays the smallest credit package (250 credits, the
 * $5 starter) once per pass, into the same append-only ledger as a purchase.
 *
 * CoinPay reports the pass on userinfo, which is only seen at sign-in, so the
 * callback records `pass_until` on the CoinPay identity and calls this.
 * Idempotent: keyed on `coinpay-pass:<sub>:<expires_at>`, so signing in again
 * during the same pass never pays twice; a renewed pass (new expires_at) pays again.
 */
import type { Client } from "@libsql/client";
import type { CoinpayPass } from "@profullstack/coinpay-onboard/pass";
import { CREDIT_PACKAGES, creditFromSource } from "./ledger.ts";

/** The smallest purchasable package: what one pass is worth here. */
export const PASS_CREDITS = [...CREDIT_PACKAGES].sort((a, b) => a.usd - b.usd)[0]!.credits;

export const passGrantKey = (sub: string, expiresAt: Date) => `coinpay-pass:${sub}:${expiresAt.toISOString()}`;

/** Pay the pass's credits once. Returns true only when this call paid. */
export async function grantPassCredits(
  db: Client,
  userId: string,
  sub: string,
  pass: CoinpayPass,
  now: Date = new Date(),
): Promise<boolean> {
  if (!pass.active || !pass.expiresAt || pass.expiresAt.getTime() <= now.getTime()) return false;
  return creditFromSource(
    db,
    userId,
    PASS_CREDITS,
    "coinpay_pass",
    passGrantKey(sub, pass.expiresAt),
    `Profullstack Pass: ${PASS_CREDITS} free credits`,
    now,
  );
}

/** Remember the pass on the identity (the claim is only seen at sign-in), then pay it. */
export async function applyPass(
  db: Client,
  userId: string,
  sub: string,
  pass: CoinpayPass,
  now: Date = new Date(),
): Promise<boolean> {
  const until = pass.active && pass.expiresAt ? pass.expiresAt.toISOString() : null;
  await db.execute({ sql: "UPDATE coinpay_identities SET pass_until = ? WHERE sub = ?", args: [until, sub] });
  return grantPassCredits(db, userId, sub, pass, now);
}
