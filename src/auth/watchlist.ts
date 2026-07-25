/**
 * Per-user saved watchlist (PRD v3 §7.1).
 *
 * This is the first authenticated feature in the app: every route here requires
 * a valid session, and every query is scoped by `user_id`. Two rules are
 * enforced rather than assumed, because a mistake in either leaks one user's
 * data to another:
 *
 *   - the user id always comes from the **session cookie**, never from the
 *     request body or a query parameter;
 *   - every read and write carries `WHERE user_id = ?`, so a guessed ticker or
 *     item id cannot reach another account's rows.
 */
import type { Client } from "@libsql/client";
import { newId } from "./crypto.ts";
import { SESSION_COOKIE, readCookie } from "./routes.ts";
import { userForSession, type PublicUser } from "./service.ts";

/** Tickers per user. Generous, but bounded so one account cannot fill the table. */
export const MAX_WATCHLIST_ITEMS = 200;

export interface WatchlistItem {
  ticker: string;
  note?: string;
  createdAt: string;
}

/** Tickers are 1-5 letters, optionally with a class suffix (e.g. BRK.B). */
export function normalizeTicker(raw: string): string | null {
  const t = String(raw ?? "").trim().toUpperCase();
  return /^[A-Z]{1,5}(\.[A-Z]{1,2})?$/.test(t) ? t : null;
}

export async function listWatchlist(db: Client, userId: string): Promise<WatchlistItem[]> {
  const rs = await db.execute({
    sql: `SELECT ticker, note, created_at FROM watchlist_items
          WHERE user_id = ? ORDER BY created_at DESC`,
    args: [userId],
  });
  return rs.rows.map((r) => ({
    ticker: String(r.ticker),
    note: r.note ? String(r.note) : undefined,
    createdAt: String(r.created_at),
  }));
}

export async function addToWatchlist(
  db: Client,
  userId: string,
  rawTicker: string,
  note?: string,
): Promise<{ ok: boolean; ticker?: string; error?: string }> {
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) return { ok: false, error: "Enter a valid ticker symbol." };

  const count = await db.execute({
    sql: "SELECT COUNT(*) AS n FROM watchlist_items WHERE user_id = ?",
    args: [userId],
  });
  if (Number(count.rows[0]?.n ?? 0) >= MAX_WATCHLIST_ITEMS) {
    return { ok: false, error: `Watchlist is limited to ${MAX_WATCHLIST_ITEMS} tickers.` };
  }

  // INSERT OR IGNORE against the UNIQUE(user_id, ticker) constraint makes
  // adding an existing ticker a no-op instead of an error — the user's intent
  // ("this should be on my list") is satisfied either way.
  await db.execute({
    sql: `INSERT OR IGNORE INTO watchlist_items (id, user_id, ticker, note, created_at)
          VALUES (?,?,?,?,?)`,
    args: [newId("wl"), userId, ticker, note?.slice(0, 500) ?? null, new Date().toISOString()],
  });
  return { ok: true, ticker };
}

export async function removeFromWatchlist(
  db: Client,
  userId: string,
  rawTicker: string,
): Promise<{ ok: boolean; error?: string }> {
  const ticker = normalizeTicker(rawTicker);
  if (!ticker) return { ok: false, error: "Enter a valid ticker symbol." };
  await db.execute({
    // Scoped by user_id: one account cannot delete another's row.
    sql: "DELETE FROM watchlist_items WHERE user_id = ? AND ticker = ?",
    args: [userId, ticker],
  });
  return { ok: true };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

/**
 * Handle a /api/watchlist request. Returns null when the path does not match,
 * so the caller can continue routing.
 *
 * Unlike the rest of the API this requires authentication — an anonymous
 * request gets 401 with a machine-readable marker the UI uses to prompt sign-in.
 */
export async function handleWatchlistRoute(
  req: Request,
  path: string,
  db: Client,
): Promise<Response | null> {
  if (path !== "/api/watchlist") return null;

  const user: PublicUser | null = await userForSession(db, readCookie(req, SESSION_COOKIE));
  if (!user) {
    return json({ error: "Sign in to use your watchlist.", authRequired: true }, 401);
  }

  if (req.method === "GET") {
    return json({ items: await listWatchlist(db, user.id) });
  }

  let body: Record<string, unknown> = {};
  try {
    body = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const ticker = typeof body.ticker === "string" ? body.ticker : "";

  if (req.method === "POST") {
    const note = typeof body.note === "string" ? body.note : undefined;
    const result = await addToWatchlist(db, user.id, ticker, note);
    if (!result.ok) return json({ error: result.error }, 400);
    return json({ ok: true, ticker: result.ticker, items: await listWatchlist(db, user.id) });
  }

  if (req.method === "DELETE") {
    const result = await removeFromWatchlist(db, user.id, ticker);
    if (!result.ok) return json({ error: result.error }, 400);
    return json({ ok: true, items: await listWatchlist(db, user.id) });
  }

  return json({ error: "method not allowed" }, 405);
}
