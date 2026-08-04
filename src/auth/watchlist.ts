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
import { reportPrices } from "../reports/store.ts";
import { WATCHLIST_CSV_FILENAME, formatWatchlistCsv, parseWatchlistCsv } from "./watchlist-csv.ts";

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

export interface BulkAddResult {
  /** Tickers newly saved. */
  added: string[];
  /** Valid tickers that were already on the list. */
  skipped: string[];
  /** Tokens that were not plausible tickers. */
  invalid: string[];
  /** Set when the per-user cap cut the import short. */
  capped?: boolean;
}

/**
 * Add many tickers in one pass — the import path.
 *
 * The cap is checked once up front and then counted down locally rather than
 * re-queried per row, so a large file is one COUNT plus one INSERT per new
 * ticker. Rows past the cap are reported instead of silently dropped: an import
 * that quietly loses half a file is worse than one that says it did.
 */
export async function addManyToWatchlist(
  db: Client,
  userId: string,
  entries: Array<{ ticker: string; note?: string }>,
): Promise<BulkAddResult> {
  const result: BulkAddResult = { added: [], skipped: [], invalid: [] };

  const existing = await listWatchlist(db, userId);
  const have = new Set(existing.map((i) => i.ticker));
  let room = MAX_WATCHLIST_ITEMS - have.size;

  for (const entry of entries) {
    const ticker = normalizeTicker(entry.ticker);
    if (!ticker) {
      result.invalid.push(String(entry.ticker ?? ""));
      continue;
    }
    if (have.has(ticker)) {
      result.skipped.push(ticker);
      continue;
    }
    if (room <= 0) {
      result.capped = true;
      break;
    }
    await db.execute({
      sql: `INSERT OR IGNORE INTO watchlist_items (id, user_id, ticker, note, created_at)
            VALUES (?,?,?,?,?)`,
      args: [newId("wl"), userId, ticker, entry.note?.slice(0, 500) ?? null, new Date().toISOString()],
    });
    have.add(ticker);
    room -= 1;
    result.added.push(ticker);
  }

  return result;
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
    const items = await listWatchlist(db, user.id);
    // ?format=csv is a download, not an API shape — the browser gets a file.
    if (new URL(req.url).searchParams.get("format") === "csv") {
      const prices = await reportPrices(db, items.map((i) => i.ticker));
      return new Response(`${formatWatchlistCsv(items, prices)}\n`, {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${WATCHLIST_CSV_FILENAME}"`,
          "cache-control": "no-store",
        },
      });
    }
    return json({ items });
  }

  let body: Record<string, unknown> = {};
  try {
    body = ((await req.json()) ?? {}) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const ticker = typeof body.ticker === "string" ? body.ticker : "";

  if (req.method === "POST") {
    // Import: the whole file is sent as text and parsed here, so the server
    // decides what a valid ticker is for both the single-add and bulk paths.
    if (typeof body.csv === "string") {
      const { entries, invalid } = parseWatchlistCsv(body.csv);
      if (entries.length === 0) {
        return json({ error: "No valid tickers in that file.", invalid }, 400);
      }
      const result = await addManyToWatchlist(db, user.id, entries);
      return json({
        ok: true,
        ...result,
        invalid: [...invalid, ...result.invalid],
        items: await listWatchlist(db, user.id),
      });
    }

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
