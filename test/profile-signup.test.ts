/**
 * Signup with the shared @profullstack/profile fields, against a real database:
 * names are required on signup, the fields land in user_profiles for the new
 * account, and /api/v1/me/profile is the signed-in owner's only.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createClient, type Client } from "@libsql/client";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/index.ts";
import type { Mailer, MailMessage, MailResult } from "../src/auth/email.ts";
import { handleAuthRoute, handleProfileRoute, profileStore } from "../src/auth/routes.ts";

const dir = mkdtempSync(join(tmpdir(), "advis0r-profile-"));
let db: Client;

class FakeMailer {
  sent: MailMessage[] = [];
  get transport() { return "resend" as const; }
  get configured() { return true; }
  async send(msg: MailMessage): Promise<MailResult> {
    this.sent.push(msg);
    return { ok: true, transport: "resend", id: `m_${this.sent.length}` };
  }
}

const deps = () => ({ db, mailer: new FakeMailer() as unknown as Mailer, appUrl: "http://local", secureCookies: false });
const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://local${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": `10.0.0.${Math.floor(Math.random() * 250)}`, ...headers },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  db = createClient({ url: `file:${join(dir, "test.db")}` });
  await migrate(db);
});
afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("signup profile fields", () => {
  test("the signup form gets the five fields from the server-rendered template", () => {
    const html = readFileSync(join(import.meta.dir, "../public/index.html"), "utf8");
    expect(html).toContain('<template id="pfs-signup-fields"><!--pfs-profile--></template>');
  });

  test("a signup without a last name is refused before any account exists", async () => {
    const res = await handleAuthRoute(
      post("/api/auth/signup", { email: "nolast@acme.com", password: "a-long-enough-passphrase", first_name: "No" }),
      "/api/auth/signup",
      deps(),
    );
    expect(res!.status).toBe(400);
    const body = await res!.json();
    expect(body.errors.last_name).toBeTruthy();
    const rs = await db.execute({ sql: "SELECT id FROM users WHERE email = ?", args: ["nolast@acme.com"] });
    expect(rs.rows.length).toBe(0);
  });

  test("a signup with the fields stores them, normalized, in user_profiles", async () => {
    const res = await handleAuthRoute(
      post("/api/auth/signup", {
        email: "Ada@Acme.com",
        password: "a-long-enough-passphrase",
        first_name: "Ada",
        last_name: "Lovelace",
        company_domain: "https://www.acme.com/about",
        job_title: "VP Engineering",
        linkedin_url: "in/ada-lovelace",
      }),
      "/api/auth/signup",
      deps(),
    );
    expect(res!.status).toBe(200);
    const user = (await db.execute({ sql: "SELECT id, display_name FROM users WHERE email = ?", args: ["ada@acme.com"] })).rows[0]!;
    expect(user.display_name).toBe("Ada Lovelace");
    const profile = await profileStore(db).get(String(user.id));
    expect(profile).toMatchObject({
      email: "ada@acme.com",
      first_name: "Ada",
      last_name: "Lovelace",
      company_domain: "acme.com",
      job_title: "VP Engineering",
      linkedin_url: "https://www.linkedin.com/in/ada-lovelace",
    });

    // A second signup for the same address must not rewrite that profile.
    await handleAuthRoute(
      post("/api/auth/signup", {
        email: "ada@acme.com",
        password: "a-long-enough-passphrase",
        first_name: "Mallory",
        last_name: "Intruder",
      }),
      "/api/auth/signup",
      deps(),
    );
    expect((await profileStore(db).get(String(user.id)))?.first_name).toBe("Ada");
  });

  test("the profile API needs a session", async () => {
    const res = await handleProfileRoute(new Request("http://local/api/v1/me/profile"), "/api/v1/me/profile", db);
    expect(res!.status).toBe(401);
    expect(await handleProfileRoute(new Request("http://local/api/other"), "/api/other", db)).toBeNull();
  });
});
