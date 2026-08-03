/**
 * Digest delivery against a real database.
 *
 * The unit tests cover calendars and rendering; these cover the parts that only
 * break once SQL is involved — who is eligible, whether a second run can send
 * the same digest twice, and whether an unsubscribe link actually stops the mail.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/index.ts";
import { newId } from "../src/auth/crypto.ts";
import type { Mailer, MailMessage, MailResult } from "../src/auth/email.ts";
import type { AlpacaMarketDataClient } from "../src/providers/interfaces.ts";
import type { MarketBar } from "../src/types.ts";
import { getPreference, setPreference, unsubscribeByToken, unsubscribeToken } from "../src/digest/preferences.ts";
import { handleDigestRoute } from "../src/digest/routes.ts";
import { runDigests } from "../src/digest/run.ts";
import { digestsDue, premarketOpen, tradingDaysBetween } from "../src/digest/schedule.ts";

const dir = mkdtempSync(join(tmpdir(), "advis0r-digest-"));
let db: Client;

/** Tuesday 2026-08-04, 04:05 ET — just after the pre-market bell. */
const RUN_AT = new Date(premarketOpen("2026-08-04").getTime() + 5 * 60_000);

/** Collects what would have been sent instead of talking to a provider. */
class FakeMailer {
  sent: MailMessage[] = [];
  failNext = false;
  get transport() { return "resend" as const; }
  get configured() { return true; }
  async send(msg: MailMessage): Promise<MailResult> {
    if (this.failNext) {
      this.failNext = false;
      return { ok: false, transport: "resend", error: "provider down" };
    }
    this.sent.push(msg);
    return { ok: true, transport: "resend", id: `m_${this.sent.length}` };
  }
}

/** Base price per symbol; anything else has no market data at all. */
const PRICED: Record<string, number> = { AAA: 10, BBB: 20, SPY: 500 };

/**
 * Deterministic daily bars for every trading session in the requested range —
 * so a run on any date finds real data, the way it would in production.
 */
function bars(symbol: string, start: string, end: string): MarketBar[] {
  return tradingDaysBetween(start, end).map((date, i) => {
    const close = Number((PRICED[symbol]! * (1 + ((i % 7) - 3) / 100)).toFixed(4));
    return {
      symbol, timestamp: `${date}T04:00:00Z`, open: close, high: close, low: close,
      close, volume: 1_000_000, timeframe: "1Day" as const, adjustment: "all" as const,
    };
  });
}

const market: AlpacaMarketDataClient = {
  async getBars(request) {
    return request.symbols
      .filter((s) => s in PRICED)
      .flatMap((s) => bars(s, request.start ?? "2026-07-01", request.end ?? "2026-09-01"));
  },
  async getSnapshots() { return []; },
  async getLatestTrades() { return []; },
  async getLatestQuotes() { return []; },
  async getAssets() { return []; },
  async getCalendar() { return []; },
};

async function createUser(
  email: string,
  opts: { verified?: boolean; frequency?: string; disabled?: boolean; tickers?: string[] } = {},
): Promise<string> {
  const id = newId("usr");
  const now = new Date().toISOString();
  await db.execute({
    sql: `INSERT INTO users (id, email, password_hash, email_verified_at, created_at, disabled, digest_frequency)
          VALUES (?,?,?,?,?,?,?)`,
    args: [id, email, "x", opts.verified === false ? null : now, now, opts.disabled ? 1 : 0, opts.frequency ?? "daily"],
  });
  for (const ticker of opts.tickers ?? []) {
    await db.execute({
      sql: "INSERT INTO watchlist_items (id, user_id, ticker, created_at) VALUES (?,?,?,?)",
      args: [newId("wl"), id, ticker, now],
    });
  }
  return id;
}

function deps(mailer: FakeMailer) {
  return { db, mailer: mailer as unknown as Mailer, market, appUrl: "https://advis0r.com" };
}

beforeAll(async () => {
  db = createClient({ url: `file:${join(dir, "test.sqlite")}` });
  await migrate(db);
});

afterAll(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migration", () => {
  test("adds the digest columns and the send ledger", async () => {
    const cols = await db.execute("PRAGMA table_info(users)");
    const names = cols.rows.map((r) => String(r.name));
    expect(names).toContain("digest_frequency");
    expect(names).toContain("digest_last_sent_at");
    expect(names).toContain("digest_unsub_token");
    await expect(db.execute("SELECT COUNT(*) FROM digest_sends")).resolves.toBeDefined();
  });

  test("an account created without a frequency defaults to daily", async () => {
    const id = newId("usr");
    await db.execute({
      sql: "INSERT INTO users (id, email, password_hash, created_at) VALUES (?,?,?,?)",
      args: [id, "default@example.com", "x", new Date().toISOString()],
    });
    expect((await getPreference(db, id)).frequency).toBe("daily");
  });
});

describe("eligibility", () => {
  test("mails verified subscribers with a watchlist, and nobody else", async () => {
    const wanted = await createUser("sub@example.com", { tickers: ["AAA", "BBB"] });
    await createUser("unverified@example.com", { verified: false, tickers: ["AAA"] });
    await createUser("empty@example.com", { tickers: [] });
    await createUser("off@example.com", { frequency: "off", tickers: ["AAA"] });
    await createUser("weekly@example.com", { frequency: "weekly", tickers: ["AAA"] });
    await createUser("disabled@example.com", { disabled: true, tickers: ["AAA"] });

    const mailer = new FakeMailer();
    const result = await runDigests(deps(mailer), { now: RUN_AT });

    expect(result.ran).toBe(true);
    expect(mailer.sent.map((m) => m.to)).toEqual(["sub@example.com"]);
    // Tuesday: the weekly window is not open, so the weekly subscriber waits.
    expect(result.windows.map((w) => w.frequency)).toEqual(["daily"]);

    const pref = await getPreference(db, wanted);
    expect(pref.lastSentAt).toBeDefined();
  });

});

describe("at-most-once delivery", () => {
  test("a second run in the same period sends nothing", async () => {
    const mailer = new FakeMailer();
    const again = await runDigests(deps(mailer), { now: RUN_AT });
    expect(mailer.sent).toHaveLength(0);
    expect(again.windows[0]!.recipients).toBe(0);
  });

  test("concurrent runs cannot both mail the same user", async () => {
    await createUser("race@example.com", { tickers: ["AAA"] });
    const a = new FakeMailer();
    const b = new FakeMailer();
    const later = new Date(RUN_AT.getTime() + 60_000);
    await Promise.all([
      runDigests(deps(a), { now: later }),
      runDigests(deps(b), { now: later }),
    ]);
    const total = [...a.sent, ...b.sent].filter((m) => m.to === "race@example.com");
    expect(total).toHaveLength(1);
  });

  test("a failed send releases the claim so the next run retries", async () => {
    const userId = await createUser("retry@example.com", { tickers: ["AAA"] });
    const failing = new FakeMailer();
    failing.failNext = true;
    const first = await runDigests(deps(failing), { now: RUN_AT, onlyEmail: undefined });
    const failed = first.windows[0]!.failed;
    expect(failed).toBeGreaterThanOrEqual(1);
    expect(failing.sent.some((m) => m.to === "retry@example.com")).toBe(false);

    const retry = new FakeMailer();
    await runDigests(deps(retry), { now: RUN_AT });
    expect(retry.sent.some((m) => m.to === "retry@example.com")).toBe(true);

    const ledger = await db.execute({
      sql: "SELECT status FROM digest_sends WHERE user_id = ? ORDER BY created_at",
      args: [userId],
    });
    expect(ledger.rows.map((r) => String(r.status)).sort()).toEqual(["failed", "sent"]);
  });

  test("a dry run neither sends nor consumes the period", async () => {
    await createUser("dry@example.com", { tickers: ["AAA"] });
    const mailer = new FakeMailer();
    const dry = await runDigests(deps(mailer), { now: RUN_AT, dryRun: true });
    expect(mailer.sent).toHaveLength(0);
    expect(dry.windows[0]!.sent).toBeGreaterThanOrEqual(1);

    const real = new FakeMailer();
    await runDigests(deps(real), { now: RUN_AT });
    expect(real.sent.some((m) => m.to === "dry@example.com")).toBe(true);
  });
});

describe("timing gates", () => {
  test("a run before the bell sends nothing", async () => {
    await createUser("early@example.com", { tickers: ["AAA"] });
    const mailer = new FakeMailer();
    const result = await runDigests(deps(mailer), {
      now: new Date(premarketOpen("2026-08-05").getTime() - 60_000),
    });
    expect(result.ran).toBe(false);
    expect(mailer.sent).toHaveLength(0);
  });

  test("weekly subscribers are mailed on the week's first session", async () => {
    const mailer = new FakeMailer();
    // Monday 2026-08-10, just after the bell.
    const monday = new Date(premarketOpen("2026-08-10").getTime() + 60_000);
    const result = await runDigests(deps(mailer), { now: monday });
    expect(result.windows.map((w) => w.frequency)).toEqual(["daily", "weekly"]);
    const weekly = mailer.sent.find((m) => m.to === "weekly@example.com");
    expect(weekly).toBeDefined();
    expect(weekly!.subject).toContain("Weekly watchlist");
    // Daily subscribers get their own message on the same morning.
    expect(mailer.sent.some((m) => m.to === "sub@example.com" && m.subject.includes("Daily"))).toBe(true);
  });
});

describe("message content", () => {
  test("each recipient sees only their own tickers", async () => {
    await createUser("solo@example.com", { tickers: ["BBB"] });
    const mailer = new FakeMailer();
    // A fresh trading day so the period key is unused.
    await runDigests(deps(mailer), {
      now: new Date(premarketOpen("2026-08-11").getTime() + 60_000),
    });
    const msg = mailer.sent.find((m) => m.to === "solo@example.com")!;
    expect(msg.text).toContain("BBB");
    expect(msg.text).not.toContain("AAA");
    expect(msg.headers?.["List-Unsubscribe"]).toMatch(/^<https:\/\/advis0r\.com\/unsubscribe\?token=/);
  });
});

describe("preferences and unsubscribe", () => {
  test("frequency can be changed and rejects nonsense", async () => {
    const id = await createUser("prefs@example.com", { tickers: ["AAA"] });
    expect((await setPreference(db, id, "weekly")).preference!.frequency).toBe("weekly");
    const bad = await setPreference(db, id, "hourly");
    expect(bad.ok).toBe(false);
    expect((await getPreference(db, id)).frequency).toBe("weekly"); // unchanged
  });

  test("the unsubscribe token is stable and stops the mail", async () => {
    const id = await createUser("bye@example.com", { tickers: ["AAA"] });
    const token = await unsubscribeToken(db, id);
    expect(await unsubscribeToken(db, id)).toBe(token); // minted once, then reused

    const result = await unsubscribeByToken(db, token);
    expect(result.ok).toBe(true);
    expect(result.email).toBe("bye@example.com");
    expect((await getPreference(db, id)).frequency).toBe("off");
    expect((await getPreference(db, id)).nextSendAt).toBeNull();

    const mailer = new FakeMailer();
    await runDigests(deps(mailer), {
      now: new Date(premarketOpen("2026-08-12").getTime() + 60_000),
    });
    expect(mailer.sent.some((m) => m.to === "bye@example.com")).toBe(false);
  });

  test("an unknown unsubscribe token is a no-op, not an error", async () => {
    expect(await unsubscribeByToken(db, "not-a-real-token")).toEqual({ ok: false });
    expect(await unsubscribeByToken(db, "")).toEqual({ ok: false });
  });
});

describe("unsubscribe endpoint", () => {
  const routeDeps = () => ({ db, appUrl: "https://advis0r.com" });
  const get = (url: string, headers?: Record<string, string>) =>
    handleDigestRoute(new Request(url, { headers }), "/unsubscribe", routeDeps());

  test("a GET changes nothing — link scanners must not unsubscribe anyone", async () => {
    const id = await createUser("scanned@example.com", { tickers: ["AAA"] });
    const token = await unsubscribeToken(db, id);
    const res = await get(`https://advis0r.com/unsubscribe?token=${token}`);
    expect(res!.status).toBe(200);
    expect(await res!.text()).toContain("Turn off watchlist emails?");
    // The subscription is untouched until the confirmation is posted.
    expect((await getPreference(db, id)).frequency).toBe("daily");
  });

  test("the POST it renders actually unsubscribes", async () => {
    const id = await createUser("confirmed@example.com", { tickers: ["AAA"] });
    const token = await unsubscribeToken(db, id);
    const body = new FormData();
    body.set("token", token);
    const res = await handleDigestRoute(
      new Request("https://advis0r.com/unsubscribe", {
        method: "POST",
        body,
        headers: { accept: "text/html" },
      }),
      "/unsubscribe",
      routeDeps(),
    );
    expect(await res!.text()).toContain("Email updates are off");
    expect((await getPreference(db, id)).frequency).toBe("off");
  });

  test("a one-click POST carries the token in the query string", async () => {
    const id = await createUser("oneclick@example.com", { tickers: ["AAA"] });
    const token = await unsubscribeToken(db, id);
    const res = await handleDigestRoute(
      new Request(`https://advis0r.com/unsubscribe?token=${token}`, {
        method: "POST",
        body: "List-Unsubscribe=One-Click",
        headers: { "content-type": "application/x-www-form-urlencoded" },
      }),
      "/unsubscribe",
      routeDeps(),
    );
    expect(res!.status).toBe(200);
    expect((await getPreference(db, id)).frequency).toBe("off");
  });

  test("an unknown token is not an existence oracle", async () => {
    const res = await get("https://advis0r.com/unsubscribe?token=nope", { accept: "text/html" });
    // GET is always the same confirmation page, real token or not.
    expect(await res!.text()).toContain("Turn off watchlist emails?");
    const posted = await handleDigestRoute(
      new Request("https://advis0r.com/unsubscribe?token=nope", {
        method: "POST",
        headers: { accept: "text/html" },
      }),
      "/unsubscribe",
      routeDeps(),
    );
    expect(posted!.status).toBe(200);
    expect(await posted!.text()).toContain("Nothing to do");
  });

  test("the preferences API refuses anonymous callers", async () => {
    const res = await handleDigestRoute(
      new Request("https://advis0r.com/api/digest"),
      "/api/digest",
      routeDeps(),
    );
    expect(res!.status).toBe(401);
    expect(await res!.json()).toMatchObject({ authRequired: true });
  });

  test("unrelated paths fall through to the rest of the router", async () => {
    expect(await handleDigestRoute(new Request("https://advis0r.com/api/stats"), "/api/stats", routeDeps())).toBeNull();
  });
});

describe("targeted resend", () => {
  test("--email sends to one subscriber without touching the ledger", async () => {
    await createUser("target@example.com", { tickers: ["AAA"] });
    const mailer = new FakeMailer();
    const window = digestsDue(RUN_AT).windows[0]!;
    await runDigests(deps(mailer), { now: RUN_AT, onlyEmail: "target@example.com" });
    expect(mailer.sent.map((m) => m.to)).toEqual(["target@example.com"]);

    const claimed = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM digest_sends WHERE period_key = ?",
      args: [window.periodKey],
    });
    // The scheduled run for this period is still free to happen normally.
    const before = Number(claimed.rows[0]?.n ?? 0);
    const second = new FakeMailer();
    await runDigests(deps(second), { now: RUN_AT, onlyEmail: "target@example.com" });
    expect(second.sent).toHaveLength(1);
    const after = await db.execute({
      sql: "SELECT COUNT(*) AS n FROM digest_sends WHERE period_key = ?",
      args: [window.periodKey],
    });
    expect(Number(after.rows[0]?.n ?? 0)).toBe(before);
  });

  test("re-sends to someone who already received this period's digest", async () => {
    await createUser("resend@example.com", { tickers: ["AAA"] });
    const scheduled = new FakeMailer();
    await runDigests(deps(scheduled), { now: RUN_AT });
    expect(scheduled.sent.some((m) => m.to === "resend@example.com")).toBe(true);

    const manual = new FakeMailer();
    await runDigests(deps(manual), { now: RUN_AT, onlyEmail: "resend@example.com" });
    expect(manual.sent.map((m) => m.to)).toEqual(["resend@example.com"]);
  });

  test("a targeted send still refuses an unsubscribed address", async () => {
    const id = await createUser("gone@example.com", { tickers: ["AAA"] });
    await setPreference(db, id, "off");
    const mailer = new FakeMailer();
    await runDigests(deps(mailer), { now: RUN_AT, onlyEmail: "gone@example.com" });
    expect(mailer.sent).toHaveLength(0);
  });
});
