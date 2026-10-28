/**
 * Customer webhooks (@profullstack/webhooks).
 *
 * What a customer would notice: a report rebuild reaches everyone watching the
 * ticker and nobody else, the delivery verifies with a Standard Webhooks
 * receiver, the payload is a summary with a link (not the paid report), only
 * genuinely new signals are announced, and the API refuses anyone not signed in.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Webhooks, memoryStore, verifyAndParse } from "@profullstack/webhooks";
import { migrate } from "../src/db/index.ts";
import { generateToken, hashToken, newId } from "../src/auth/crypto.ts";
import { saveReport } from "../src/reports/store.ts";
import { EVENT_TYPES, createHub, setHub, signalExtractedData } from "../src/webhooks/hub.ts";
import { webhooksRoute } from "../src/webhooks/routes.ts";
import { SESSION_COOKIE } from "../src/auth/routes.ts";

const dir = mkdtempSync(join(tmpdir(), "advis0r-webhooks-"));
let db: Client;

interface Received {
  url: string;
  headers: Headers;
  body: string;
}
let received: Received[] = [];

const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  received.push({ url: String(input), headers: new Headers(init?.headers), body: String(init?.body ?? "") });
  return new Response(null, { status: 204 });
}) as typeof fetch;

function hub(): Webhooks {
  return createHub(memoryStore(), "https://advis0r.com/", {
    fetchImpl: fakeFetch,
    // Receivers in tests are fake hostnames; skip DNS, keep https-only.
    guard: { lookup: async () => ["93.184.216.34"] },
    log: () => {},
  });
}

async function createUser(email: string, opts: { verified?: boolean; tickers?: string[] } = {}) {
  const id = newId("usr");
  const now = new Date().toISOString();
  await db.execute({
    sql: "INSERT INTO users (id, email, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?)",
    args: [id, email, "x", opts.verified === false ? null : now, now],
  });
  for (const t of opts.tickers ?? []) {
    await db.execute({
      sql: "INSERT INTO watchlist_items (id, user_id, ticker, created_at) VALUES (?,?,?,?)",
      args: [newId("wl"), id, t, now],
    });
  }
  const token = generateToken();
  await db.execute({
    sql: "INSERT INTO sessions (id, user_id, token_hash, created_at, expires_at) VALUES (?,?,?,?,?)",
    args: [newId("ses"), id, hashToken(token), now, new Date(Date.now() + 86_400_000).toISOString()],
  });
  return { id, cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` };
}

const report = (ticker: string) => ({
  ticker,
  companyName: `${ticker} Corp`,
  lastPrice: 10.5,
  overallScore: 72,
  confidence: 60,
  classification: "speculative",
  analysis: { thesis: "PAID THESIS TEXT" },
  aiAnalysis: { provider: "anthropic", model: "x", thesis: "PAID AI TEXT" },
  signals: [{ quote: "q" }],
  sources: [],
});

beforeAll(async () => {
  db = createClient({ url: `file:${join(dir, "test.db")}` });
  await migrate(db);
});

afterEach(() => {
  setHub(null);
  received = [];
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("events", () => {
  test("the hub knows the four advis0r events", () => {
    expect(hub().eventTypes).toEqual([...EVENT_TYPES]);
  });

  test("report.generated reaches watchers only, signed, summary plus link", async () => {
    const h = hub();
    setHub(h, "https://advis0r.com");
    const watcher = await createUser("w1@example.com", { tickers: ["ACME"] });
    const other = await createUser("w2@example.com", { tickers: ["OTHR"] });
    const { secret } = await h.createEndpoint(watcher.id, { url: "https://hooks.example.com/a", events: ["report.*"] });
    await h.createEndpoint(other.id, { url: "https://hooks.example.com/b" });

    await saveReport(db, "ACME", report("ACME"));
    await h.drain();

    expect(received.length).toBe(1);
    expect(received[0]!.url).toBe("https://hooks.example.com/a");
    const r = verifyAndParse({ headers: received[0]!.headers, body: received[0]!.body, secret });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.event.type).toBe("report.generated");
    expect(r.event.source).toBe("https://advis0r.com");
    expect(r.event.subject).toBe("ticker:ACME");
    expect(r.event.data).toMatchObject({
      ticker: "ACME",
      company_name: "ACME Corp",
      overall_score: 72,
      classification: "speculative",
      signal_count: 1,
      url: "https://advis0r.com/stocks/ACME",
    });
    expect(received[0]!.body).not.toContain("PAID");
  });

  test("an endpoint filtered to other events gets nothing", async () => {
    const h = hub();
    setHub(h);
    const u = await createUser("w3@example.com", { tickers: ["FILT"] });
    await h.createEndpoint(u.id, { url: "https://hooks.example.com/c", events: ["analysis.*"] });
    await saveReport(db, "FILT", report("FILT"));
    await h.drain();
    expect(received.length).toBe(0);
  });

  test("no hub, no webhooks, and saveReport still works", async () => {
    const stored = await saveReport(db, "NOHB", report("NOHB"));
    expect(stored.ticker).toBe("NOHB");
    expect(received.length).toBe(0);
  });

  test("signal.extracted carries kind, score and a link, not the quote", () => {
    const data = signalExtractedData({
      id: "sig1",
      ticker: "ACME",
      signalType: "guidance_raise",
      direction: "positive",
      strength: 0.8,
      eventDate: "2026-10-01",
      eventType: "earnings_call",
      speaker: "CEO",
      sourceUrl: "https://example.com/t",
    });
    expect(data).toEqual({
      signal_id: "sig1",
      ticker: "ACME",
      kind: "guidance_raise",
      direction: "positive",
      score: 0.8,
      event_type: "earnings_call",
      event_date: "2026-10-01",
      speaker: "CEO",
      source_url: "https://example.com/t",
      url: "https://advis0r.com/stocks/ACME",
    });
  });
});

describe("/api/v1/webhooks", () => {
  test("401 without a session, not ours outside the base path", async () => {
    const route = webhooksRoute(hub(), db);
    const res = await route(new Request("https://advis0r.com/api/v1/webhooks"), "/api/v1/webhooks");
    expect(res!.status).toBe(401);
    expect(await route(new Request("https://advis0r.com/api/watchlist"), "/api/watchlist")).toBeNull();
  });

  test("unverified accounts are refused", async () => {
    const u = await createUser("unv@example.com", { verified: false });
    const route = webhooksRoute(hub(), db);
    const res = await route(
      new Request("https://advis0r.com/api/v1/webhooks", { headers: { cookie: u.cookie } }),
      "/api/v1/webhooks",
    );
    expect(res!.status).toBe(401);
  });

  test("a signed-in account creates, lists and tests its own endpoints", async () => {
    const u = await createUser("api@example.com");
    const route = webhooksRoute(hub(), db);
    const call = (path: string, init: RequestInit = {}) =>
      route(
        new Request(`https://advis0r.com${path}`, {
          ...init,
          headers: { cookie: u.cookie, "content-type": "application/json" },
        }),
        path,
      );

    const created = await call("/api/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://hooks.example.com/api", events: ["signal.extracted"] }),
    });
    expect(created!.status).toBe(201);
    const { endpoint, secret } = (await created!.json()) as any;
    expect(secret).toStartWith("whsec_");

    const list = (await (await call("/api/v1/webhooks"))!.json()) as any;
    expect(list.endpoints.map((e: any) => e.id)).toEqual([endpoint.id]);
    expect(list.event_types).toEqual([...EVENT_TYPES]);

    const bad = await call("/api/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://hooks.example.com/x", events: ["nope.never"] }),
    });
    expect(bad!.status).toBe(400);

    const tested = (await (await call(`/api/v1/webhooks/${endpoint.id}/test`, { method: "POST" }))!.json()) as any;
    expect(tested.ok).toBe(true);
    const r = verifyAndParse({ headers: received.at(-1)!.headers, body: received.at(-1)!.body, secret });
    expect(r.ok && r.event.type).toBe("webhook.test");
  });
});
