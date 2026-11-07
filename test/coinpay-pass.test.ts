/**
 * Profullstack Pass: an active pass pays the smallest credit package once per
 * pass (keyed on sub + expires_at); an inactive, expired or malformed pass pays
 * nothing; a renewed pass pays again.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Client } from "@libsql/client";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { passFromUserinfo } from "@profullstack/coinpay-onboard/pass";
import { migrate, openClient } from "../src/db/index.ts";
import { getBalance, FREE_MONTHLY_CREDITS } from "../src/credits/ledger.ts";
import { applyPass, grantPassCredits, PASS_CREDITS, passGrantKey } from "../src/credits/pass.ts";

const dir = mkdtempSync(join(tmpdir(), "advis0r-pass-"));
let db: Client;
const now = new Date("2026-11-07T12:00:00Z");
const until = "2026-12-07T12:00:00.000Z";

beforeAll(async () => {
  db = openClient(`file:${join(dir, "t.db")}`);
  await migrate(db);
  for (const id of ["u1", "u2"]) {
    await db.execute({
      sql: "INSERT INTO users (id, email, password_hash, created_at, updated_at) VALUES (?,?,?,?,?)",
      args: [id, `${id}@example.com`, "", now.toISOString(), now.toISOString()],
    });
    await db.execute({
      sql: "INSERT INTO coinpay_identities (sub, user_id, created_at) VALUES (?,?,?)",
      args: [`sub-${id}`, id, now.toISOString()],
    });
  }
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("Profullstack Pass credits", () => {
  test("the pass is worth the smallest package (250 credits)", () => {
    expect(PASS_CREDITS).toBe(250);
    expect(passGrantKey("s", new Date(until))).toBe(`coinpay-pass:s:${until}`);
  });

  test("an active pass pays once, however often the user signs in", async () => {
    const pass = passFromUserinfo({ pass: { active: true, expires_at: until } }, now);
    expect(await applyPass(db, "u1", "sub-u1", pass, now)).toBe(true);
    expect(await applyPass(db, "u1", "sub-u1", pass, now)).toBe(false);
    expect((await getBalance(db, "u1", now)).balance).toBe(FREE_MONTHLY_CREDITS + PASS_CREDITS);
    const rs = await db.execute({ sql: "SELECT pass_until FROM coinpay_identities WHERE sub = ?", args: ["sub-u1"] });
    expect(String(rs.rows[0]!.pass_until)).toBe(until);
  });

  test("a renewed pass (new expires_at) pays again", async () => {
    const renewed = passFromUserinfo({ pass: { active: true, expires_at: "2027-01-07T12:00:00.000Z" } }, now);
    expect(await grantPassCredits(db, "u1", "sub-u1", renewed, now)).toBe(true);
    expect((await getBalance(db, "u1", now)).balance).toBe(FREE_MONTHLY_CREDITS + 2 * PASS_CREDITS);
  });

  test("no pass, an inactive one, an expired one or a malformed one pays nothing", async () => {
    for (const claims of [
      {},
      { pass: { active: false } },
      { pass: { active: true } },
      { pass: { active: true, expires_at: "not a date" } },
      { pass: { active: true, expires_at: "2026-11-01T00:00:00.000Z" } },
      { pass: { active: "true", expires_at: until } },
    ]) {
      expect(await applyPass(db, "u2", "sub-u2", passFromUserinfo(claims, now), now)).toBe(false);
    }
    expect((await getBalance(db, "u2", now)).balance).toBe(FREE_MONTHLY_CREDITS);
    const rs = await db.execute({ sql: "SELECT pass_until FROM coinpay_identities WHERE sub = ?", args: ["sub-u2"] });
    expect(rs.rows[0]!.pass_until).toBeNull();
  });
});
