/**
 * Credit codes and invites.
 *
 * Two house packages, writing into the credit ledger advis0r already has:
 *
 * - @profullstack/redeem-credits mints scarce codes (stored only as sha256
 *   hashes) that grant `credits`, the same unit the free allowance and the
 *   CoinPay packages are counted in. The package is used for minting and
 *   redeeming only (tables `redeem_*`); the credits land in credits_ledger,
 *   keyed on (user, 'code', <codeId>), and its balance()/spend() are never
 *   called. A monthly code is remembered in credit_code_grants and paid each
 *   month by the same lazy top-up as the free allowance (ledger.ts).
 * - @profullstack/affiliates gives every verified account three single-use
 *   invites and one open ?ref= code, and records who brought whom
 *   (tables `aff_*`).
 *
 * An accepted invite pays credits to both people, but only for an account the
 * invite created, once its email is confirmed, when the two are not one
 * mailbox, the new address is not a throwaway one, the inviter is verified and
 * old enough, and the inviter is under a monthly cap. invite_bonuses claims the
 * payment before it is made, so it is paid exactly once.
 */
import type { Client } from "@libsql/client";
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import {
  Affiliates,
  type AffiliateStore,
  memoryStore as affiliateMemoryStore,
  normalizeCode as normalizeInvite,
  postgresStore as affiliatePostgresStore,
  sqliteStore as affiliateSqliteStore,
} from "@profullstack/affiliates";
import {
  Credits,
  type CreditStore,
  type MintedCode,
  memoryStore as creditMemoryStore,
  postgresStore as creditPostgresStore,
  sqliteStore as creditSqliteStore,
} from "@profullstack/redeem-credits";
import { databaseUrlOf } from "../db/index.ts";
import { creditFromSource, currentPeriod, ensureCodeMonthlyGrants, getBalance } from "./ledger.ts";

export { REF_COOKIE } from "@profullstack/affiliates";

/** The unit every code grants: one credit, one AI analysis, as a package buys. */
export const UNIT = "credits";
/** Invites per account. Scarce on purpose: an invite says someone wanted you here. */
export const INVITE_QUOTA = 3;
/** Where an /i/<code> visit is remembered until the account is created. */
export const INVITE_COOKIE = "advis0r_invite";
/** Bonuses one inviter can earn in 30 days, whatever their quota is raised to. */
export const INVITER_MONTHLY_CAP = 10;

const envNumber = (name: string, fallback: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === "" ? fallback : Number(raw);
  return Number.isFinite(n) ? n : fallback;
};
/** Credits each side of an accepted invite gets. 0 turns the bonus off. */
export const inviteBonusCredits = (): number => Math.max(0, Math.floor(envNumber("INVITE_BONUS_CREDITS", 50)));
const inviterMinAgeHours = (): number => envNumber("INVITE_MIN_INVITER_AGE_HOURS", 24);

/* ------------------------------------------------------------- stores -- */

interface Services {
  credits: Credits;
  affiliates: Affiliates;
}

const services = new WeakMap<object, Services>();

/**
 * The package stores for this database. Postgres (production) gets its own
 * small Bun SQL pool on the same DATABASE_URL, in the node-postgres
 * `query(text, params) -> { rows }` shape both packages take; a local file
 * database gets bun:sqlite on the same file. A client the db module did not
 * open (tests) gets in-memory stores unless the test passes its own.
 */
function storesFor(db: Client): { credit: CreditStore; affiliate: AffiliateStore } {
  const url = databaseUrlOf(db);
  if (url && /^postgres(ql)?:\/\//i.test(url)) {
    const sql = new SQL(url, { max: 3 });
    const pool = {
      async query(text: string, params: unknown[] = []) {
        return { rows: (await sql.unsafe(text, params as never[])) as Record<string, unknown>[] };
      },
    };
    // prefix redeem_: the package default credit_ would sit next to our own
    // credits_ledger / credit_purchases and invite confusion.
    return { credit: creditPostgresStore(pool, { prefix: "redeem_" }), affiliate: affiliatePostgresStore(pool) };
  }
  if (url?.startsWith("file:")) {
    const file = new Database(url.slice("file:".length).split("?")[0]!);
    file.exec("PRAGMA busy_timeout = 5000");
    return { credit: creditSqliteStore(file, { prefix: "redeem_" }), affiliate: affiliateSqliteStore(file) };
  }
  return { credit: creditMemoryStore(), affiliate: affiliateMemoryStore() };
}

function svc(db: Client): Services {
  let s = services.get(db);
  if (!s) {
    const stores = storesFor(db);
    s = {
      credits: new Credits(stores.credit),
      affiliates: new Affiliates(stores.affiliate, { defaultQuota: INVITE_QUOTA }),
    };
    services.set(db, s);
  }
  return s;
}

/** Tests: run against given stores instead of the ones storesFor() picks. */
export function useStoresForTesting(db: Client, credit: CreditStore, affiliate: AffiliateStore): void {
  services.set(db, {
    credits: new Credits(credit),
    affiliates: new Affiliates(affiliate, { defaultQuota: INVITE_QUOTA }),
  });
}

/* -------------------------------------------------------------- input -- */

/** A code as typed, or null. The packages forgive case, spaces and dashes;
 *  this only keeps junk (and anything long enough to abuse a log line) out. */
export function cleanCode(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.length > 48) return null;
  return /^[A-Za-z0-9 _-]+$/.test(trimmed) ? trimmed : null;
}

/** An affiliate code from ?ref= or the cookie: short, letters and digits. */
export function cleanRef(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return /^[A-Za-z0-9]{4,32}$/.test(trimmed) ? trimmed.toUpperCase() : null;
}

/** The canonical spelling of an invite, for a cookie and a URL. Null when it cannot be one. */
export function canonicalInvite(value: unknown): string | null {
  const cleaned = cleanCode(value);
  if (!cleaned) return null;
  const normal = normalizeInvite(cleaned);
  return /^INV-[0-9A-Z]{4}-[0-9A-Z]{4}-[0-9A-Z]{4}$/.test(normal) ? normal : null;
}

/* ------------------------------------------------------------- credit -- */

export const REDEEM_MESSAGES: Record<string, string> = {
  invalid: "That code does not exist. Check it and try again.",
  expired: "That code has expired.",
  used_up: "That code has already been used.",
  already_redeemed: "You have already redeemed that code.",
  revoked: "That code has been withdrawn.",
};

export type RedeemOutcome =
  | { ok: true; credits: number; monthly: boolean; months: number | null; balance: number }
  | { ok: false; reason: string; message: string };

/**
 * Redeem a code for this account. On success the credits are in
 * credits_ledger before this returns. `already_redeemed` also re-runs the
 * ledger write, so a redemption whose write was lost to a crash is paid on the
 * next try instead of being stuck.
 */
export async function redeemCode(
  db: Client,
  userId: string,
  code: unknown,
  now: Date = new Date(),
): Promise<RedeemOutcome> {
  const cleaned = cleanCode(code);
  if (!cleaned) return { ok: false, reason: "invalid", message: REDEEM_MESSAGES.invalid! };
  const { credits } = svc(db);
  const r = await credits.redeem(cleaned, userId);
  if (!r.ok) {
    if (r.reason === "already_redeemed") await reconcileCodeGrants(db, userId, now).catch(() => 0);
    return { ok: false, reason: r.reason, message: REDEEM_MESSAGES[r.reason] ?? "That code cannot be used." };
  }
  if (r.grant.unit !== UNIT) {
    // Minted for another unit (by hand, outside the CLI): spent, but worth nothing here.
    console.error(`[codes] ${r.codeId} grants unit "${r.grant.unit}", not ${UNIT}; nothing credited`);
    return { ok: true, credits: 0, monthly: false, months: null, balance: (await getBalance(db, userId, now)).balance };
  }
  const amount = Math.round(r.grant.amount);
  const monthly = r.grant.every === "month";
  await recordCodeGrant(db, userId, r.codeId, amount, monthly ? "month" : null, r.grant.months ?? null, now);
  return {
    ok: true,
    credits: amount,
    monthly,
    months: r.grant.months ?? null,
    balance: (await getBalance(db, userId, now)).balance,
  };
}

/** Remember what a code owes this account and pay what is due now. Idempotent. */
async function recordCodeGrant(
  db: Client,
  userId: string,
  codeId: string,
  amount: number,
  every: "month" | null,
  months: number | null,
  now: Date,
): Promise<void> {
  await db.execute({
    sql: `INSERT OR IGNORE INTO credit_code_grants
          (user_id, code_id, amount, every, months, start_period, created_at)
          VALUES (?,?,?,?,?,?,?)`,
    args: [userId, codeId, amount, every, months, currentPeriod(now), now.toISOString()],
  });
  if (every === "month") await ensureCodeMonthlyGrants(db, userId, now);
  else await creditFromSource(db, userId, amount, "code", codeId, "Credit code", now);
}

/** Re-apply every code grant the package recorded for this user. Returns how many it saw. */
export async function reconcileCodeGrants(db: Client, userId: string, now: Date = new Date()): Promise<number> {
  const history = (await svc(db).credits.history(userId, UNIT)).filter(
    (e) => e.kind === "grant" && e.source.startsWith("code:"),
  );
  if (history.length === 0) return 0;
  const codes = new Map((await svc(db).credits.list()).map((c) => [c.id, c]));
  let seen = 0;
  for (const entry of history) {
    const codeId = entry.source.slice("code:".length);
    const code = codes.get(codeId);
    const monthly = code?.grant.every === "month";
    // The redemption month, not this one: a monthly code redeemed in July still ends when it would have.
    await recordCodeGrant(
      db, userId, codeId, Math.round(entry.amount), monthly ? "month" : null,
      monthly ? (code?.grant.months ?? null) : null, new Date(entry.at),
    );
    seen++;
  }
  if (seen) await ensureCodeMonthlyGrants(db, userId, now);
  return seen;
}

export interface MintInput {
  credits: number;
  label?: string;
  monthly?: boolean;
  months?: number | null;
  maxRedemptions?: number;
  expiresInDays?: number | null;
  createdBy?: string;
}

/** An operator mints a code. The plaintext is in the result and nowhere else. */
export async function mintCode(db: Client, input: MintInput): Promise<MintedCode> {
  const { credits, monthly = false, months = null, maxRedemptions = 1, expiresInDays = null } = input;
  if (!Number.isInteger(credits) || credits <= 0 || credits > 1_000_000) {
    throw new Error("credits must be a whole number from 1 to 1000000");
  }
  if (!Number.isInteger(maxRedemptions) || maxRedemptions < 1 || maxRedemptions > 10_000) {
    throw new Error("max redemptions must be a whole number from 1 to 10000");
  }
  if (months !== null && (!monthly || !Number.isInteger(months) || months < 1 || months > 120)) {
    throw new Error("months applies to a monthly code and must be a whole number from 1 to 120");
  }
  return svc(db).credits.mint({
    grant: { unit: UNIT, amount: credits, ...(monthly ? { every: "month" as const, months } : {}) },
    label: String(input.label ?? "").trim().slice(0, 120) || "advis0r credits",
    maxRedemptions,
    expiresAt: expiresInDays ? Date.now() + expiresInDays * 86_400_000 : null,
    prefix: "ADV",
    ...(input.createdBy ? { createdBy: input.createdBy } : {}),
  });
}

export const listCodes = (db: Client) => svc(db).credits.list();
export const revokeCode = (db: Client, id: string) => svc(db).credits.revoke(id);

/* ------------------------------------------------------------ invites -- */

/** Links are built from APP_URL, or from the request when APP_URL was left at localhost. */
export function originFor(appUrl: string, requestUrl: string): string {
  if (appUrl && !/\/\/(localhost|127\.0\.0\.1)(:|$)/.test(appUrl)) return appUrl.replace(/\/$/, "");
  try {
    return new URL(requestUrl).origin;
  } catch {
    return appUrl.replace(/\/$/, "");
  }
}

const iso = (ms: number | null | undefined) => (ms == null ? null : new Date(Number(ms)).toISOString());

interface InviteLike {
  id: string;
  note: string;
  createdAt: number;
  expiresAt: number | null;
  usedBy: string | null;
  usedAt: number | null;
  revokedAt?: number | null;
}

function inviteView(invite: InviteLike) {
  return {
    id: invite.id,
    note: invite.note,
    createdAt: iso(invite.createdAt),
    expiresAt: iso(invite.expiresAt),
    used: invite.usedBy !== null,
    usedAt: iso(invite.usedAt),
    revoked: (invite.revokedAt ?? null) !== null,
  };
}

export async function inviteSummary(db: Client, userId: string, origin: string) {
  const { affiliates } = svc(db);
  const [quota, invites, affiliateCode, invitees] = await Promise.all([
    affiliates.quota(userId),
    affiliates.invites(userId),
    affiliates.affiliateCode(userId),
    affiliates.invitees(userId),
  ]);
  return {
    quota,
    bonusCredits: inviteBonusCredits(),
    invites: invites.map(inviteView),
    affiliateCode,
    affiliateUrl: `${origin}/?ref=${affiliateCode}`,
    joined: invitees.length,
  };
}

export async function createInvite(db: Client, userId: string, note: unknown, origin: string) {
  const { affiliates } = svc(db);
  try {
    const invite = await affiliates.createInvite(userId, String(note ?? "").trim().slice(0, 120));
    return {
      ok: true as const,
      code: invite.code,
      url: `${origin}/i/${encodeURIComponent(invite.code)}`,
      invite: inviteView(invite),
      quota: await affiliates.quota(userId),
    };
  } catch (err) {
    if (/no invites left/i.test(String((err as Error)?.message))) return { ok: false as const, reason: "no_invites_left" };
    throw err;
  }
}

/** Admin: set a user's invite allowance (a total, not an increment). */
export const setInviteQuota = (db: Client, userId: string, total: number) =>
  svc(db).affiliates.setQuota(userId, total);

/**
 * One mailbox under two spellings: case, a +tag, and Gmail's dots. Inviting
 * yourself to collect both halves of the bonus is what this catches; a second
 * domain is what the throwaway list and the monthly cap are for.
 */
export function sameMailbox(a: string, b: string): boolean {
  const canonical = (email: string) => {
    const [rawLocal = "", rawDomain = ""] = String(email).trim().toLowerCase().split("@");
    let domain = rawDomain;
    let local = rawLocal.split("+")[0] ?? "";
    if (domain === "googlemail.com") domain = "gmail.com";
    if (domain === "gmail.com") local = local.replaceAll(".", "");
    return `${local}@${domain}`;
  };
  return canonical(a) === canonical(b);
}

/** Disposable-mail services: an account made on one earns its inviter nothing. */
const THROWAWAY = new Set([
  "10minutemail.com", "10minutemail.net", "20minutemail.com", "anonaddy.me", "burnermail.io", "byom.de",
  "discard.email", "dispostable.com", "dropmail.me", "emailondeck.com", "fakeinbox.com", "getairmail.com",
  "getnada.com", "guerrillamail.com", "guerrillamail.net", "guerrillamail.org", "guerrillamailblock.com",
  "grr.la", "harakirimail.com", "inboxbear.com", "incognitomail.org", "mail.tm", "mailcatch.com",
  "maildrop.cc", "mailinator.com", "mailinator.net", "mailnesia.com", "mailpoof.com", "mintemail.com",
  "moakt.com", "mohmal.com", "mytemp.email", "nada.email", "sharklasers.com", "spam4.me", "spamgourmet.com",
  "temp-mail.io", "temp-mail.org", "tempail.com", "tempmail.com", "tempmail.net", "tempmailo.com",
  "tempr.email", "throwawaymail.com", "trashmail.com", "trashmail.de", "trashmail.net", "yopmail.com",
  "yopmail.fr", "yopmail.net",
]);

export function isThrowaway(email: string): boolean {
  const domain = String(email).trim().toLowerCase().split("@")[1] ?? "";
  return THROWAWAY.has(domain) || [...THROWAWAY].some((d) => domain.endsWith(`.${d}`));
}

/**
 * Remember the invite and ?ref= a brand-new account signed up with, until its
 * email is confirmed. Stored against the account, not only in a cookie, so the
 * verification link still counts when it is opened on another device.
 */
export async function rememberSignupInvite(
  db: Client,
  userId: string,
  invite: unknown,
  ref: unknown,
  now: Date = new Date(),
): Promise<boolean> {
  const code = canonicalInvite(invite);
  const refCode = cleanRef(ref);
  if (!code && !refCode) return false;
  await db.execute({
    sql: `INSERT OR IGNORE INTO pending_invites (user_id, invite_code, ref_code, created_at) VALUES (?,?,?,?)`,
    args: [userId, code, refCode, now.toISOString()],
  });
  return true;
}

export interface AcceptResult {
  invite: Awaited<ReturnType<Affiliates["redeemInvite"]>> | null;
  bonus: string | null;
  credits: number;
  ref: { ok: boolean; affiliateId?: string; external?: boolean } | null;
}

/**
 * The account's email was just confirmed: accept the invite (and the ?ref=)
 * it signed up with. Runs once: the pending row is claimed by deleting it.
 */
export async function settleSignupInvite(db: Client, userId: string, now: Date = new Date()): Promise<AcceptResult | null> {
  const rs = await db.execute({
    sql: "SELECT invite_code, ref_code FROM pending_invites WHERE user_id = ?",
    args: [userId],
  });
  const row = rs.rows[0];
  if (!row) return null;
  const claim = await db.execute({ sql: "DELETE FROM pending_invites WHERE user_id = ?", args: [userId] });
  if (Number(claim.rowsAffected ?? 0) === 0) return null; // a concurrent verify got it

  const userRs = await db.execute({ sql: "SELECT id, email FROM users WHERE id = ?", args: [userId] });
  const email = String(userRs.rows[0]?.email ?? "");
  const out: AcceptResult = { invite: null, bonus: null, credits: 0, ref: null };
  if (row.invite_code) Object.assign(out, await acceptInvite(db, String(row.invite_code), { id: userId, email }, now));
  if (row.ref_code) out.ref = await svc(db).affiliates.attribute(String(row.ref_code), userId).catch(() => ({ ok: false }));
  return out;
}

/**
 * Accept an invite for an account created with it, whose address is now
 * confirmed. The invite is spent whatever the bonus decides: who invited whom
 * is recorded even when nothing is paid for it.
 */
export async function acceptInvite(
  db: Client,
  code: string,
  invitee: { id: string; email: string },
  now: Date = new Date(),
): Promise<Omit<AcceptResult, "ref">> {
  const invite = await svc(db).affiliates.redeemInvite(code, invitee.id);
  if (!invite.ok) return { invite, bonus: null, credits: 0 };

  const bonus = inviteBonusCredits();
  const since = new Date(now.getTime() - 30 * 86_400_000).toISOString();
  const inviterRs = await db.execute({
    sql: `SELECT u.id, u.email, u.created_at, u.email_verified_at, COALESCE(u.disabled, 0) AS disabled,
            (SELECT COUNT(*) FROM invite_bonuses b
              WHERE b.user_id = u.id AND b.role = 'inviter' AND b.status = 'granted'
                AND b.created_at > ?) AS recent
          FROM users u WHERE u.id = ?`,
    args: [since, invite.inviterId],
  });
  const inviter = inviterRs.rows[0];
  const ageHours = inviter ? (now.getTime() - Date.parse(String(inviter.created_at))) / 3_600_000 : 0;

  let status = "granted";
  if (bonus <= 0 || !inviter) status = "disabled";
  else if (Number(inviter.disabled) === 1 || !inviter.email_verified_at) status = "inviter_unverified";
  else if (sameMailbox(String(inviter.email), invitee.email)) status = "same_mailbox";
  else if (isThrowaway(invitee.email)) status = "throwaway_address";
  else if (!(ageHours >= inviterMinAgeHours())) status = "inviter_too_new";
  else if (Number(inviter.recent) >= INVITER_MONTHLY_CAP) status = "inviter_cap";

  const credits = status === "granted" ? bonus : 0;
  const pairs: [string, "invitee" | "inviter"][] = [[invitee.id, "invitee"]];
  if (inviter) pairs.push([String(inviter.id), "inviter"]);
  let paid = 0;
  for (const [userId, role] of pairs) {
    // Claimed first, so a retry never pays twice.
    const claimed = await db.execute({
      sql: `INSERT OR IGNORE INTO invite_bonuses (invite_id, user_id, role, credits, status, created_at)
            VALUES (?,?,?,?,?,?)`,
      args: [invite.inviteId, userId, role, credits, status === "granted" ? "pending" : status, now.toISOString()],
    });
    if (Number(claimed.rowsAffected ?? 0) === 0 || status !== "granted") continue;
    await creditFromSource(
      db, userId, credits, "invite_bonus", invite.inviteId,
      role === "invitee" ? "Invite bonus (joined)" : "Invite bonus (invited a friend)", now,
    );
    await db.execute({
      sql: "UPDATE invite_bonuses SET status = 'granted' WHERE invite_id = ? AND user_id = ?",
      args: [invite.inviteId, userId],
    });
    if (role === "invitee") paid = credits;
  }
  return { invite, bonus: status, credits: paid };
}
