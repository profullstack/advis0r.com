/**
 * Lookup HTTP surface.
 *
 *   GET /api/lookup?q=rivian&limit=10  -> [{ symbol, name, exchange, hasReport }]
 *
 * Public and unauthenticated, like the rest of the research API. The only thing
 * worth guarding is cost: a miss can reach Yahoo, so single-character queries —
 * the ones a typeahead fires on the first keystroke — are answered from the
 * local directory only.
 */
import type { Client } from "@libsql/client";
import { lookupSymbols } from "./lookup.ts";
import { normalizeQuery } from "./directory.ts";

const json = (body: unknown, status = 200, cacheSeconds = 0) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": cacheSeconds ? `public, max-age=${cacheSeconds}` : "no-store",
    },
  });

/** Queries shorter than this never trigger a remote call. */
const REMOTE_MIN_LENGTH = 2;

export interface LookupRouteDeps {
  db: Client;
}

export async function handleLookupRoute(
  req: Request,
  path: string,
  deps: LookupRouteDeps,
): Promise<Response | null> {
  if (path !== "/api/lookup") return null;
  if (req.method !== "GET") return json({ error: "method not allowed" }, 405);

  const url = new URL(req.url);
  const query = normalizeQuery(url.searchParams.get("q"));
  if (!query) return json({ query: "", matches: [] });

  const limit = Math.min(25, Number(url.searchParams.get("limit") ?? 10) || 10);
  const result = await lookupSymbols(deps.db, query, {
    limit,
    localOnly: query.length < REMOTE_MIN_LENGTH,
  });

  // Flag which matches already have a stored report, so the picker can send
  // people straight to one instead of paying to build it again.
  const withReports = await annotateReports(deps.db, result.matches.map((m) => m.symbol));

  return json(
    {
      query: result.query,
      matches: result.matches.map((m) => ({
        symbol: m.symbol,
        name: m.name,
        exchange: m.exchange,
        hasReport: withReports.has(m.symbol),
      })),
    },
    200,
    // Symbol names are close to static; a short public cache absorbs the
    // repeated keystrokes of a typeahead without hiding a fresh sync for long.
    60,
  );
}

async function annotateReports(db: Client, symbols: string[]): Promise<Set<string>> {
  if (!symbols.length) return new Set();
  try {
    const ph = symbols.map(() => "?").join(",");
    const rs = await db.execute({
      sql: `SELECT ticker FROM reports WHERE ticker IN (${ph})`,
      args: symbols,
    });
    return new Set(rs.rows.map((r) => String(r.ticker)));
  } catch {
    return new Set();
  }
}
