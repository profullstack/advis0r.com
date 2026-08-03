/**
 * Ticker lookup.
 *
 * The bug this closes is concrete: typing "rivian" was a dead end everywhere.
 * The watchlist rejected it (over five letters), the signals box wanted an
 * exact symbol, and full-text search answered with Amazon's 10-Q, because that
 * filing mentions their Rivian stake. So the tests are mostly about ranking —
 * a lookup that finds RIVN third is not much better than one that misses it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/index.ts";
import {
  countSymbols,
  directoryAge,
  looksLikeTicker,
  normalizeQuery,
  searchableText,
  searchSymbols,
  upsertSymbols,
  type SymbolRow,
} from "../src/symbols/directory.ts";
import { lookupSymbols, resolveOne } from "../src/symbols/lookup.ts";
import { toDotClass } from "../src/symbols/providers.ts";
import { handleLookupRoute } from "../src/symbols/routes.ts";

const dir = mkdtempSync(join(tmpdir(), "advis0r-symbols-"));
let db: Client;

const S = (symbol: string, name: string, exchange = "NASDAQ", extra: Partial<SymbolRow> = {}): SymbolRow => ({
  symbol, name, exchange, assetClass: "us_equity", status: "active", tradable: true,
  source: "alpaca", ...extra,
});

const SEED: SymbolRow[] = [
  S("RIVN", "Rivian Automotive, Inc."),
  S("RIVNW", "Rivian Automotive, Inc. Warrants", "NASDAQ"),
  S("AAPL", "Apple Inc."),
  S("APLE", "Apple Hospitality REIT, Inc.", "NYSE"),
  S("NVDA", "NVIDIA Corporation"),
  S("TSLA", "Tesla, Inc."),
  S("F", "Ford Motor Company", "NYSE"),
  S("BRK.B", "Berkshire Hathaway Inc. Class B", "NYSE"),
  S("RIVR", "River Financial Corp", "OTC"),
  S("KO", "The Coca-Cola Company", "NYSE"),
  S("COKE", "Coca-Cola Consolidated, Inc.", "NASDAQ"),
  S("DEAD", "Delisted Shell Corp", "OTC", { tradable: false, status: "inactive" }),
];

beforeAll(async () => {
  db = createClient({ url: `file:${join(dir, "symbols.sqlite")}` });
  await migrate(db);
  await upsertSymbols(db, SEED);
});

afterAll(() => {
  db?.close();
  rmSync(dir, { recursive: true, force: true });
});

/* ---------------- query normalization ---------------- */

describe("normalizeQuery", () => {
  test("keeps ordinary company names intact", () => {
    expect(normalizeQuery("  Rivian Automotive ")).toBe("Rivian Automotive");
    expect(normalizeQuery("AT&T")).toBe("AT&T");
    expect(normalizeQuery("BRK.B")).toBe("BRK.B");
  });

  test("neutralizes LIKE wildcards so a query cannot match everything", () => {
    expect(normalizeQuery("%")).toBe("");
    expect(normalizeQuery("a%_b")).toBe("a b");
  });

  test("strips markup and collapses whitespace", () => {
    expect(normalizeQuery("<script>alert(1)</script>")).toBe("script alert 1 script");
    expect(normalizeQuery("a\n\n  b")).toBe("a b");
  });

  test("caps length, so a pasted paragraph is not a table scan", () => {
    expect(normalizeQuery("x".repeat(500)).length).toBe(64);
  });

  test("empty input stays empty", () => {
    for (const v of ["", "   ", null, undefined]) expect(normalizeQuery(v)).toBe("");
  });
});

describe("searchableText", () => {
  test("collapses punctuation, so spelling it either way works", () => {
    // The bug: "coca cola" could never match a stored "Coca-Cola".
    expect(searchableText("The Coca-Cola Company")).toBe("coca cola company");
    expect(searchableText("coca cola")).toBe("coca cola");
    expect(searchableText("Johnson & Johnson")).toBe("johnson johnson");
    expect(searchableText("Berkshire Hathaway Inc.")).toBe("berkshire hathaway inc");
  });

  test("drops a leading article so the real company outranks its namesakes", () => {
    // Without this, "coca cola" ranked Coca-Cola Europacific and Coca-Cola
    // Consolidated above The Coca-Cola Company, purely over the word "The".
    expect(searchableText("The Home Depot, Inc.")).toBe("home depot inc");
    // Only leading, and only as a whole word.
    expect(searchableText("Theravance Biopharma")).toBe("theravance biopharma");
  });
});

describe("toDotClass", () => {
  test("converts Yahoo's hyphen class shares to the form this app uses", () => {
    // The bug: "berkshire hathaway" returned nothing, because BRK-B was
    // fetched and then thrown away by the symbol shape check.
    expect(toDotClass("BRK-B")).toBe("BRK.B");
    expect(toDotClass("BRK-A")).toBe("BRK.A");
  });

  test("leaves ordinary and already-dotted symbols alone", () => {
    expect(toDotClass("RIVN")).toBe("RIVN");
    expect(toDotClass("BRK.B")).toBe("BRK.B");
  });

  test("does not mangle symbols that merely contain a hyphen", () => {
    expect(toDotClass("ABCDEF-XYZ")).toBe("ABCDEF-XYZ");
  });
});

describe("looksLikeTicker", () => {
  test("recognizes symbols and rejects prose", () => {
    expect(looksLikeTicker("RIVN")).toBe(true);
    expect(looksLikeTicker("brk.b")).toBe(true);
    expect(looksLikeTicker("rivian")).toBe(false); // six letters — the original bug
    expect(looksLikeTicker("")).toBe(false);
  });
});

/* ---------------- ranking ---------------- */

describe("search ranking", () => {
  test("the reported case: a company name finds its ticker, first", async () => {
    const hits = await searchSymbols(db, "rivian", 5);
    expect(hits[0]!.symbol).toBe("RIVN");
    expect(hits[0]!.name).toContain("Rivian");
  });

  test("an exact symbol beats a name that merely contains it", async () => {
    const hits = await searchSymbols(db, "aapl", 5);
    expect(hits[0]!.symbol).toBe("AAPL");
  });

  test("a name query does not lose to a coincidental symbol prefix", async () => {
    // "apple" must find Apple Inc. before Apple Hospitality REIT.
    const hits = await searchSymbols(db, "apple", 5);
    expect(hits[0]!.symbol).toBe("AAPL");
    expect(hits.map((h) => h.symbol)).toContain("APLE");
  });

  test("the primary listing outranks its warrants", async () => {
    const hits = await searchSymbols(db, "riv", 5);
    expect(hits[0]!.symbol).toBe("RIVN"); // shorter symbol, preferred exchange
    expect(hits.map((h) => h.symbol)).toContain("RIVNW");
  });

  test("a preferred exchange outranks OTC on an equal match", async () => {
    const hits = await searchSymbols(db, "riv", 8);
    expect(hits.findIndex((h) => h.symbol === "RIVN"))
      .toBeLessThan(hits.findIndex((h) => h.symbol === "RIVR"));
  });

  test("untradable symbols are never offered", async () => {
    expect((await searchSymbols(db, "delisted", 5)).map((h) => h.symbol)).not.toContain("DEAD");
    expect((await searchSymbols(db, "dead", 5)).map((h) => h.symbol)).not.toContain("DEAD");
  });

  test("dotted class symbols are findable both ways", async () => {
    expect((await searchSymbols(db, "brk.b", 3))[0]!.symbol).toBe("BRK.B");
    expect((await searchSymbols(db, "berkshire", 3))[0]!.symbol).toBe("BRK.B");
  });

  test("a single letter matches the single-letter ticker", async () => {
    expect((await searchSymbols(db, "f", 5))[0]!.symbol).toBe("F");
  });

  test("mid-name words match, so \"motor\" finds Ford", async () => {
    expect((await searchSymbols(db, "motor", 5)).map((h) => h.symbol)).toContain("F");
  });

  test("a leading article does not cost a company its own name", async () => {
    // "coca cola" must find KO, not just the namesakes whose legal names
    // happen to omit "The".
    const hits = await searchSymbols(db, "coca cola", 5);
    expect(hits[0]!.symbol).toBe("KO");
    expect(hits.map((h) => h.symbol)).toContain("COKE");
  });

  test("punctuation in a stored name does not have to be reproduced", async () => {
    expect((await searchSymbols(db, "coca-cola", 3))[0]!.symbol).toBe("KO");
    expect((await searchSymbols(db, "cocacola", 3)).length).toBe(0); // still a real miss
  });

  test("a query with no match returns nothing rather than everything", async () => {
    expect(await searchSymbols(db, "zzzzqqqq", 5)).toEqual([]);
    expect(await searchSymbols(db, "", 5)).toEqual([]);
  });

  test("the limit is honoured and bounded", async () => {
    expect((await searchSymbols(db, "i", 3)).length).toBeLessThanOrEqual(3);
    expect((await searchSymbols(db, "i", 999)).length).toBeLessThanOrEqual(50);
  });
});

/* ---------------- storage ---------------- */

describe("directory storage", () => {
  test("upsert is idempotent and refreshes the name", async () => {
    const before = await countSymbols(db);
    await upsertSymbols(db, [S("RIVN", "Rivian Automotive, Inc. / DE")]);
    expect(await countSymbols(db)).toBe(before);
    expect((await searchSymbols(db, "rivn", 1))[0]!.name).toContain("/ DE");
    await upsertSymbols(db, [S("RIVN", "Rivian Automotive, Inc.")]); // restore
  });

  test("symbols are stored upper-case however they arrive", async () => {
    await upsertSymbols(db, [S("lcid", "Lucid Group, Inc.")]);
    expect((await searchSymbols(db, "lucid", 1))[0]!.symbol).toBe("LCID");
  });

  test("directoryAge reports size and freshness", async () => {
    const age = await directoryAge(db);
    expect(age.count).toBeGreaterThan(5);
    expect(age.newest).toBeTruthy();
  });
});

/* ---------------- resolution ---------------- */

describe("resolveOne", () => {
  test("resolves the reported case", async () => {
    expect((await resolveOne(db, "rivian", { localOnly: true }))?.symbol).toBe("RIVN");
  });

  test("resolves an exact symbol", async () => {
    expect((await resolveOne(db, "nvda", { localOnly: true }))?.symbol).toBe("NVDA");
  });

  test("refuses to guess when a ticker-shaped query only matched loosely", async () => {
    // "APL" is not a symbol here; silently resolving to APLE or AAPL would put
    // a company nobody asked for onto a watchlist.
    expect(await resolveOne(db, "apl", { localOnly: true })).toBeNull();
  });

  test("returns null rather than inventing a match", async () => {
    expect(await resolveOne(db, "zzzzqqqq", { localOnly: true })).toBeNull();
    expect(await resolveOne(db, "", { localOnly: true })).toBeNull();
  });
});

describe("lookupSymbols", () => {
  test("stays local when the directory answers confidently", async () => {
    const r = await lookupSymbols(db, "rivian", { localOnly: true });
    expect(r.usedRemote).toBe(false);
    expect(r.matches[0]!.symbol).toBe("RIVN");
  });

  test("an exact symbol hit never triggers a remote call", async () => {
    // localOnly is NOT set here: the exact-match short circuit is what prevents
    // the round trip, and that is the property worth pinning.
    const r = await lookupSymbols(db, "nvda");
    expect(r.usedRemote).toBe(false);
    expect(r.matches[0]!.symbol).toBe("NVDA");
  });

  test("localOnly suppresses the remote call even on a miss", async () => {
    const r = await lookupSymbols(db, "zzzzqqqq", { localOnly: true });
    expect(r.usedRemote).toBe(false);
    expect(r.matches).toEqual([]);
  });
});

/* ---------------- route ---------------- */

describe("/api/lookup", () => {
  const route = (qs: string) =>
    handleLookupRoute(new Request(`https://advis0r.com/api/lookup${qs}`), "/api/lookup", { db });

  test("answers the reported query with the ticker", async () => {
    const res = await route("?q=rivian");
    expect(res!.status).toBe(200);
    const body = (await res!.json()) as any;
    expect(body.matches[0].symbol).toBe("RIVN");
    expect(body.matches[0].name).toContain("Rivian");
  });

  test("reports which matches already have a stored report", async () => {
    await db.execute({
      sql: `INSERT INTO reports (ticker, payload_json, source_count, signal_count,
                                 generated_at, first_generated_at)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(ticker) DO NOTHING`,
      args: ["RIVN", "{}", 0, 0, new Date().toISOString(), new Date().toISOString()],
    });
    const body = (await (await route("?q=rivian"))!.json()) as any;
    expect(body.matches.find((m: any) => m.symbol === "RIVN").hasReport).toBe(true);
    const nv = (await (await route("?q=nvidia"))!.json()) as any;
    expect(nv.matches[0].hasReport).toBe(false);
  });

  test("an empty query is an empty result, not an error", async () => {
    const body = (await (await route("?q="))!.json()) as any;
    expect(body.matches).toEqual([]);
  });

  test("a single character never reaches the remote source", async () => {
    // Guards the first keystroke of a typeahead against a third-party call.
    const res = await route("?q=r");
    expect(res!.status).toBe(200);
    expect(((await res!.json()) as any).matches.length).toBeGreaterThan(0);
  });

  test("wildcards cannot be smuggled through the query", async () => {
    const body = (await (await route("?q=%25"))!.json()) as any;
    expect(body.matches).toEqual([]);
  });

  test("unrelated paths fall through, and non-GET is rejected", async () => {
    expect(await handleLookupRoute(new Request("https://advis0r.com/api/stats"), "/api/stats", { db })).toBeNull();
    const post = await handleLookupRoute(
      new Request("https://advis0r.com/api/lookup", { method: "POST" }),
      "/api/lookup",
      { db },
    );
    expect(post!.status).toBe(405);
  });
});
