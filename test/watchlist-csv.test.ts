/**
 * Watchlist CSV import / export.
 *
 * The pure format helpers are covered directly; the bulk import is covered
 * against a real database, because the parts that break there — the per-user
 * cap, re-importing a file you already have, one account's file reaching
 * another's rows — only exist once SQL is involved.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/index.ts";
import { newId } from "../src/auth/crypto.ts";
import {
  MAX_WATCHLIST_ITEMS,
  addManyToWatchlist,
  addToWatchlist,
  listWatchlist,
} from "../src/auth/watchlist.ts";
import {
  WATCHLIST_CSV_COLUMNS,
  formatWatchlistCsv,
  parseWatchlistCsv,
} from "../src/auth/watchlist-csv.ts";

describe("formatWatchlistCsv", () => {
  const header = WATCHLIST_CSV_COLUMNS.join(",");

  test("puts the ticker leftmost, one row per stock, alphabetical", () => {
    const csv = formatWatchlistCsv([
      { ticker: "NVDA", createdAt: "2026-07-01T12:00:00.000Z" },
      { ticker: "AAPL", createdAt: "2026-06-02T12:00:00.000Z" },
    ]);
    expect(csv.split("\n")[0]).toBe(header);
    expect(csv.split("\n").slice(1).map((r) => r.split(",")[0])).toEqual(["AAPL", "NVDA"]);
  });

  test("carries the last known price and the day it was captured", () => {
    const csv = formatWatchlistCsv(
      [{ ticker: "AAPL", note: "core holding", createdAt: "2026-06-02T12:00:00.000Z" }],
      { AAPL: { lastPrice: 123.456, generatedAt: "2026-08-01T14:30:00.000Z" } },
    );
    expect(csv.split("\n")[1]).toBe("AAPL,core holding,123.46,2026-08-01,2026-06-02");
  });

  test("leaves price cells blank when there is no stored report", () => {
    expect(formatWatchlistCsv([{ ticker: "AAPL" }]).split("\n")[1]).toBe("AAPL,,,,");
  });

  test("quotes notes containing commas or quotes", () => {
    const csv = formatWatchlistCsv([{ ticker: "AAPL", note: 'buy, then "hold"' }]);
    expect(csv).toContain('AAPL,"buy, then ""hold"""');
  });
});

describe("parseWatchlistCsv", () => {
  test("round-trips an exported file", () => {
    const csv = formatWatchlistCsv([
      { ticker: "AAPL", note: 'buy, then "hold"' },
      { ticker: "NVDA" },
    ]);
    expect(parseWatchlistCsv(csv).entries).toEqual([
      { ticker: "AAPL", note: 'buy, then "hold"' },
      { ticker: "NVDA" },
    ]);
  });

  test("ignores price columns and tolerates extra ones", () => {
    const csv = "Symbol,Note,Price,Whatever\nAAPL,keep,123.45,x\nNVDA,,98.10,y\n";
    expect(parseWatchlistCsv(csv).entries).toEqual([{ ticker: "AAPL", note: "keep" }, { ticker: "NVDA" }]);
  });

  test("accepts a plain pasted ticker list", () => {
    expect(parseWatchlistCsv("nvda, AAPL\nTSLA;MSFT").entries).toEqual([
      { ticker: "NVDA" },
      { ticker: "AAPL" },
      { ticker: "TSLA" },
      { ticker: "MSFT" },
    ]);
  });

  test("de-dupes and reports what it refused", () => {
    const parsed = parseWatchlistCsv("AAPL aapl $$$ 12345678");
    expect(parsed.entries).toEqual([{ ticker: "AAPL" }]);
    expect(parsed.invalid).toEqual(["$$$", "12345678"]);
  });

  test("returns nothing for an empty file", () => {
    expect(parseWatchlistCsv("   ")).toEqual({ entries: [], invalid: [] });
  });
});

describe("addManyToWatchlist", () => {
  const dir = mkdtempSync(join(tmpdir(), "advis0r-wlcsv-"));
  let db: Client;
  let userId = "";
  let otherId = "";

  /** watchlist_items.user_id is a real foreign key, so rows need real users. */
  async function createUser(email: string): Promise<string> {
    const id = newId("usr");
    const now = new Date().toISOString();
    await db.execute({
      sql: "INSERT INTO users (id, email, password_hash, email_verified_at, created_at) VALUES (?,?,?,?,?)",
      args: [id, email, "x", now, now],
    });
    return id;
  }

  beforeAll(async () => {
    db = createClient({ url: `file:${join(dir, "test.db")}` });
    await migrate(db);
    userId = await createUser("mine@example.com");
    otherId = await createUser("other@example.com");
  });

  afterAll(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("adds valid tickers and reports the rest", async () => {
    const result = await addManyToWatchlist(db, userId, [
      { ticker: "AAPL", note: "core" },
      { ticker: "nvda" },
      { ticker: "$$$" },
    ]);
    expect(result.added).toEqual(["AAPL", "NVDA"]);
    expect(result.invalid).toEqual(["$$$"]);
    const saved = await listWatchlist(db, userId);
    expect(saved.map((i) => i.ticker).sort()).toEqual(["AAPL", "NVDA"]);
    expect(saved.find((i) => i.ticker === "AAPL")?.note).toBe("core");
  });

  test("re-importing the same file adds nothing twice", async () => {
    const result = await addManyToWatchlist(db, userId, [{ ticker: "AAPL" }, { ticker: "NVDA" }]);
    expect(result.added).toEqual([]);
    expect(result.skipped).toEqual(["AAPL", "NVDA"]);
    expect((await listWatchlist(db, userId)).length).toBe(2);
  });

  test("stops at the per-user cap and says so", async () => {
    const filler = Array.from({ length: MAX_WATCHLIST_ITEMS + 5 }, (_, i) => ({
      // AAA…, four letters, distinct per row and within the ticker grammar.
      ticker: `Q${String.fromCharCode(65 + Math.floor(i / 26))}${String.fromCharCode(65 + (i % 26))}`,
    }));
    const result = await addManyToWatchlist(db, otherId, filler);
    expect(result.capped).toBe(true);
    expect(result.added.length).toBe(MAX_WATCHLIST_ITEMS);
    expect((await listWatchlist(db, otherId)).length).toBe(MAX_WATCHLIST_ITEMS);
  });

  test("one account's import never touches another's rows", async () => {
    const mine = await listWatchlist(db, userId);
    expect(mine.map((i) => i.ticker).sort()).toEqual(["AAPL", "NVDA"]);
  });

  test("agrees with the single-add path on what a ticker is", async () => {
    const third = await createUser("third@example.com");
    await addToWatchlist(db, third, "brk.b");
    const bulk = await addManyToWatchlist(db, third, [{ ticker: "brk.b" }, { ticker: "BRK.B" }]);
    expect(bulk.added).toEqual([]);
    expect((await listWatchlist(db, third)).map((i) => i.ticker)).toEqual(["BRK.B"]);
  });
});
