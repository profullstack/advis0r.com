/**
 * Digest subscription state: per-user frequency, unsubscribe tokens, and the
 * send ledger that makes delivery at-most-once.
 *
 * Three rules hold everywhere in this file, because breaking any of them means
 * emailing someone who did not ask for it:
 *
 *   - Only **verified**, non-disabled accounts with a **non-empty watchlist**
 *     are recipients. A digest of nothing is spam, and an unverified address may
 *     not belong to whoever typed it.
 *   - A send is **claimed before it is attempted**. The UNIQUE(user_id,
 *     period_key) constraint is the interlock: two concurrent runs, or a cron
 *     firing twice, cannot both win the claim.
 *   - Every message carries a working unsubscribe path that needs no sign-in.
 */
import type { Client } from "@libsql/client";
import { generateToken, newId } from "../auth/crypto.ts";
import {
  type DigestFrequency,
  type DigestWindow,
  nextSendAt,
  parseFrequency,
} from "./schedule.ts";

export interface DigestPreference {
  frequency: DigestFrequency;
  lastSentAt?: string;
  /** ISO instant of the next expected delivery; null when unsubscribed. */
  nextSendAt: string | null;
}

export interface DigestRecipient {
  userId: string;
  email: string;
  displayName?: string;
  frequency: Exclude<DigestFrequency, "off">;
  unsubscribeToken: string;
  tickers: string[];
}

const iso = () => new Date().toISOString();

/* ---------------- preferences ---------------- */

export async function getPreference(
  db: Client,
  userId: string,
  now = new Date(),
): Promise<DigestPreference> {
  const rs = await db.execute({
    sql: "SELECT digest_frequency, digest_last_sent_at FROM users WHERE id = ?",
    args: [userId],
  });
  const row = rs.rows[0];
  const frequency = parseFrequency(row?.digest_frequency);
  const next = nextSendAt(frequency, now);
  return {
    frequency,
    lastSentAt: row?.digest_last_sent_at ? String(row.digest_last_sent_at) : undefined,
    nextSendAt: next ? next.toISOString() : null,
  };
}

export async function setPreference(
  db: Client,
  userId: string,
  raw: unknown,
  now = new Date(),
): Promise<{ ok: boolean; preference?: DigestPreference; error?: string }> {
  const requested = String(raw ?? "").trim().toLowerCase();
  // An unrecognized value must not silently become "daily" — a UI bug would
  // then subscribe someone who was trying to unsubscribe.
  const frequency = parseFrequency(requested, "daily");
  if (frequency !== requested) {
    return { ok: false, error: "Choose daily, weekly, or off." };
  }
  await db.execute({
    sql: "UPDATE users SET digest_frequency = ?, updated_at = ? WHERE id = ?",
    args: [frequency, iso(), userId],
  });
  return { ok: true, preference: await getPreference(db, userId, now) };
}

/**
 * The user's unsubscribe token, minted on first use.
 *
 * Stored in the clear, unlike session and reset tokens: the link has to be
 * reconstructable to be printed in every email, and the only capability it
 * grants is turning mail off. Nothing about the account can be read or changed
 * with it.
 */
export async function unsubscribeToken(db: Client, userId: string): Promise<string> {
  const rs = await db.execute({
    sql: "SELECT digest_unsub_token FROM users WHERE id = ?",
    args: [userId],
  });
  const existing = rs.rows[0]?.digest_unsub_token;
  if (existing) return String(existing);
  const token = generateToken();
  await db.execute({
    sql: "UPDATE users SET digest_unsub_token = ? WHERE id = ? AND digest_unsub_token IS NULL",
    args: [token, userId],
  });
  // Re-read: a concurrent request may have minted one first, and both emails
  // must contain a token that actually works.
  const after = await db.execute({
    sql: "SELECT digest_unsub_token FROM users WHERE id = ?",
    args: [userId],
  });
  return String(after.rows[0]?.digest_unsub_token ?? token);
}

/** Honour an unsubscribe link. Unknown tokens report success — see below. */
export async function unsubscribeByToken(
  db: Client,
  token: string,
): Promise<{ ok: boolean; email?: string }> {
  if (!token) return { ok: false };
  const rs = await db.execute({
    sql: "SELECT id, email FROM users WHERE digest_unsub_token = ?",
    args: [token],
  });
  const row = rs.rows[0];
  if (!row) return { ok: false };
  await db.execute({
    sql: "UPDATE users SET digest_frequency = 'off', updated_at = ? WHERE id = ?",
    args: [iso(), String(row.id)],
  });
  return { ok: true, email: String(row.email) };
}

/* ---------------- recipients ---------------- */

/**
 * Everyone due to receive this window's digest.
 *
 * The watchlist join is an inner join on purpose: an account with an empty
 * watchlist has nothing to summarize and is not mailed at all.
 *
 * `includeAlreadySent` exists for the targeted `digest send --email` path, where
 * the operator is deliberately re-sending a message that already went out. It
 * relaxes only the period filter — an unverified, disabled, or unsubscribed
 * account is still never mailed.
 */
export async function recipientsFor(
  db: Client,
  window: DigestWindow,
  opts: { includeAlreadySent?: boolean } = {},
): Promise<DigestRecipient[]> {
  const rs = await db.execute({
    sql: `SELECT u.id AS id, u.email AS email, u.display_name AS display_name,
                 w.ticker AS ticker
          FROM users u
          JOIN watchlist_items w ON w.user_id = u.id
          WHERE COALESCE(u.digest_frequency, 'daily') = ?
            AND u.email_verified_at IS NOT NULL
            AND COALESCE(u.disabled, 0) = 0
            ${opts.includeAlreadySent ? "" : "AND u.id NOT IN (SELECT user_id FROM digest_sends WHERE period_key = ?)"}
          ORDER BY u.id, w.created_at DESC`,
    args: opts.includeAlreadySent
      ? [window.frequency]
      : [window.frequency, window.periodKey],
  });

  const byUser = new Map<string, DigestRecipient>();
  for (const row of rs.rows) {
    const id = String(row.id);
    let entry = byUser.get(id);
    if (!entry) {
      entry = {
        userId: id,
        email: String(row.email),
        displayName: row.display_name ? String(row.display_name) : undefined,
        frequency: window.frequency,
        unsubscribeToken: "",
        tickers: [],
      };
      byUser.set(id, entry);
    }
    entry.tickers.push(String(row.ticker));
  }

  const out = [...byUser.values()];
  for (const r of out) r.unsubscribeToken = await unsubscribeToken(db, r.userId);
  return out;
}

/* ---------------- send ledger ---------------- */

export type SendStatus = "sending" | "sent" | "failed";

/**
 * Claim the right to send one digest.
 *
 * Returns false when another run already holds the claim. `INSERT OR IGNORE`
 * against UNIQUE(user_id, period_key) makes this atomic without a transaction,
 * which matters because libSQL may be talking to a remote Turso instance.
 */
export async function claimSend(
  db: Client,
  userId: string,
  window: DigestWindow,
  tickerCount: number,
): Promise<boolean> {
  const rs = await db.execute({
    sql: `INSERT OR IGNORE INTO digest_sends
            (id, user_id, frequency, period_key, covering, tickers, status, created_at)
          VALUES (?,?,?,?,?,?,?,?)`,
    args: [
      newId("dig"),
      userId,
      window.frequency,
      window.periodKey,
      describeSessions(window),
      tickerCount,
      "sending" satisfies SendStatus,
      iso(),
    ],
  });
  return Number(rs.rowsAffected ?? 0) > 0;
}

export async function markSent(
  db: Client,
  userId: string,
  window: DigestWindow,
  transport: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE digest_sends SET status = 'sent', transport = ?, sent_at = ?
          WHERE user_id = ? AND period_key = ?`,
    args: [transport, iso(), userId, window.periodKey],
  });
  await db.execute({
    sql: "UPDATE users SET digest_last_sent_at = ? WHERE id = ?",
    args: [iso(), userId],
  });
}

/**
 * Record a failure and release the claim, so the next run inside the catch-up
 * window retries. A transport outage should cost a delay, not the whole day's
 * digest.
 */
export async function releaseFailedSend(
  db: Client,
  userId: string,
  window: DigestWindow,
  error: string,
): Promise<void> {
  await db.execute({
    sql: "DELETE FROM digest_sends WHERE user_id = ? AND period_key = ? AND status = 'sending'",
    args: [userId, window.periodKey],
  });
  await db.execute({
    sql: `INSERT OR IGNORE INTO digest_sends
            (id, user_id, frequency, period_key, covering, tickers, status, error, created_at)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    args: [
      newId("dig"),
      userId,
      window.frequency,
      `${window.periodKey}#failed:${Date.now()}`,
      describeSessions(window),
      0,
      "failed" satisfies SendStatus,
      error.slice(0, 400),
      iso(),
    ],
  });
}

function describeSessions(window: DigestWindow): string {
  const first = window.sessions[0];
  const last = window.sessions.at(-1);
  return first === last ? String(first) : `${first}..${last}`;
}
