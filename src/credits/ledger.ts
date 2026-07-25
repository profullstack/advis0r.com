/**
 * Credit ledger (PRD v3 §8).
 *
 * Every account gets a free monthly allowance; metered AI analysis spends from
 * it, and more can be bought with crypto via CoinPayPortal.
 *
 * Three invariants make this safe to run with real money attached:
 *
 *   1. **Append-only.** The balance is always `SUM(delta)` over the ledger,
 *      never a stored number that can drift from its own history. Every change
 *      leaves an auditable row saying who, how much and why.
 *   2. **No overdraft, even concurrently.** Spending is a single conditional
 *      INSERT whose WHERE clause re-checks the balance, so two simultaneous
 *      requests cannot both pass a "do you have enough?" test and then both
 *      debit. SQLite evaluates it atomically; a losing request inserts nothing.
 *   3. **Idempotent credits.** `UNIQUE(user_id, reason, idem)` means a repeated
 *      monthly grant or a webhook delivered twice can never credit twice —
 *      which is the failure that would actually cost money.
 */
import type { Client } from "@libsql/client";
import { newId } from "../auth/crypto.ts";

/** Credits granted free to every account, each calendar month. */
export const FREE_MONTHLY_CREDITS = 100;

/** Cost of one metered operation. */
export const COST_PER_ANALYSIS = 1;

export interface CreditPackage {
  id: string;
  credits: number;
  usd: number;
  label: string;
}

/** Purchasable packages. Larger bundles carry a discount per credit. */
export const CREDIT_PACKAGES: CreditPackage[] = [
  { id: "starter", credits: 250, usd: 5, label: "250 credits" },
  { id: "standard", credits: 600, usd: 10, label: "600 credits" },
  { id: "pro", credits: 2000, usd: 25, label: "2,000 credits" },
];

export function findPackage(id: string): CreditPackage | undefined {
  return CREDIT_PACKAGES.find((p) => p.id === id);
}

/** Current UTC billing period, e.g. "2026-07". */
export function currentPeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

export interface CreditBalance {
  balance: number;
  freeMonthlyCredits: number;
  period: string;
  spentThisPeriod: number;
}

/**
 * Grant this period's free allowance if it has not been granted yet.
 *
 * Lazy rather than scheduled: there is no cron to miss, and the UNIQUE
 * constraint makes a concurrent double-call harmless.
 */
export async function ensureMonthlyGrant(
  db: Client,
  userId: string,
  now: Date = new Date(),
): Promise<void> {
  const period = currentPeriod(now);
  await db.execute({
    sql: `INSERT OR IGNORE INTO credits_ledger (id, user_id, delta, reason, idem, note, created_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [
      newId("cr"),
      userId,
      FREE_MONTHLY_CREDITS,
      "monthly_grant",
      period,
      `Free monthly allowance for ${period}`,
      now.toISOString(),
    ],
  });
}

export async function getBalance(
  db: Client,
  userId: string,
  now: Date = new Date(),
): Promise<CreditBalance> {
  await ensureMonthlyGrant(db, userId, now);
  const period = currentPeriod(now);
  const rs = await db.execute({
    sql: `SELECT
            COALESCE(SUM(delta), 0) AS balance,
            COALESCE(-SUM(CASE WHEN delta < 0 AND created_at >= ? THEN delta ELSE 0 END), 0) AS spent
          FROM credits_ledger WHERE user_id = ?`,
    args: [`${period}-01T00:00:00.000Z`, userId],
  });
  const row = rs.rows[0];
  return {
    balance: Number(row?.balance ?? 0),
    freeMonthlyCredits: FREE_MONTHLY_CREDITS,
    period,
    spentThisPeriod: Number(row?.spent ?? 0),
  };
}

export interface SpendResult {
  ok: boolean;
  balance: number;
  error?: string;
}

/**
 * Spend credits for an operation.
 *
 * The conditional INSERT is the whole safety story: the balance is re-checked
 * inside the same statement that writes the debit, so there is no window
 * between "check" and "charge" for a concurrent request to slip through.
 */
export async function spendCredits(
  db: Client,
  userId: string,
  amount: number,
  operation: string,
  now: Date = new Date(),
): Promise<SpendResult> {
  if (amount <= 0) return { ok: true, balance: (await getBalance(db, userId, now)).balance };
  await ensureMonthlyGrant(db, userId, now);

  const result = await db.execute({
    sql: `INSERT INTO credits_ledger (id, user_id, delta, reason, idem, note, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ?
          WHERE (SELECT COALESCE(SUM(delta), 0) FROM credits_ledger WHERE user_id = ?) >= ?`,
    args: [
      newId("cr"), userId, -amount, `spend:${operation}`,
      // Unique per debit: idem is only an idempotency key for credits, and two
      // legitimate spends of the same operation must both be recorded.
      newId("op"), operation, now.toISOString(),
      userId, amount,
    ],
  });

  const balance = (await getBalance(db, userId, now)).balance;
  if (Number(result.rowsAffected ?? 0) === 0) {
    return {
      ok: false,
      balance,
      error: `Not enough credits (${balance} left, ${amount} needed). Buy more to keep going.`,
    };
  }
  return { ok: true, balance };
}

/** Refund a spend — used when an operation fails after being charged. */
export async function refundCredits(
  db: Client,
  userId: string,
  amount: number,
  operation: string,
  now: Date = new Date(),
): Promise<void> {
  if (amount <= 0) return;
  await db.execute({
    sql: `INSERT INTO credits_ledger (id, user_id, delta, reason, idem, note, created_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [
      newId("cr"), userId, amount, `refund:${operation}`, newId("op"),
      `Refund for failed ${operation}`, now.toISOString(),
    ],
  });
}

/**
 * Credit a confirmed purchase. Keyed on the payment id, so a webhook delivered
 * twice (which providers do) credits exactly once.
 */
export async function creditPurchase(
  db: Client,
  userId: string,
  paymentId: string,
  credits: number,
  now: Date = new Date(),
): Promise<{ credited: boolean; balance: number }> {
  const result = await db.execute({
    sql: `INSERT OR IGNORE INTO credits_ledger (id, user_id, delta, reason, idem, note, created_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [
      newId("cr"), userId, credits, "purchase", paymentId,
      `Purchased ${credits} credits`, now.toISOString(),
    ],
  });
  return {
    credited: Number(result.rowsAffected ?? 0) > 0,
    balance: (await getBalance(db, userId, now)).balance,
  };
}

export interface LedgerEntry {
  delta: number;
  reason: string;
  note?: string;
  createdAt: string;
}

export async function recentLedger(
  db: Client,
  userId: string,
  limit = 25,
): Promise<LedgerEntry[]> {
  const rs = await db.execute({
    sql: `SELECT delta, reason, note, created_at FROM credits_ledger
          WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`,
    args: [userId, limit],
  });
  return rs.rows.map((r) => ({
    delta: Number(r.delta),
    reason: String(r.reason),
    note: r.note ? String(r.note) : undefined,
    createdAt: String(r.created_at),
  }));
}
