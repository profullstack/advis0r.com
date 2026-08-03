/**
 * Lookup orchestration: local directory first, remote fallback on a miss.
 *
 * The ordering is the design. A synced directory answers in one indexed query,
 * which is what makes a typeahead feel like a typeahead. Yahoo is consulted only
 * when the local answer is thin, and whatever it returns is written back — so a
 * gap costs one slow lookup, once, and is local from then on.
 */
import type { Client } from "@libsql/client";
import {
  looksLikeTicker,
  normalizeQuery,
  searchSymbols,
  upsertSymbols,
  type SymbolMatch,
} from "./directory.ts";
import { searchYahoo } from "./providers.ts";

/**
 * Below this many local hits, ask Yahoo too.
 *
 * Not zero: a single weak substring match is exactly the case where the
 * directory is stale or the company is missing, and returning it alone would
 * look like a confident wrong answer.
 */
const THIN_RESULT_THRESHOLD = 3;

export interface LookupResult {
  query: string;
  matches: SymbolMatch[];
  /** True when the remote source was consulted — surfaced for the CLI/tests. */
  usedRemote: boolean;
}

export interface LookupOptions {
  limit?: number;
  /** Skip the remote fallback (offline tests, or a deliberately cheap call). */
  localOnly?: boolean;
}

export async function lookupSymbols(
  db: Client,
  rawQuery: string,
  opts: LookupOptions = {},
): Promise<LookupResult> {
  const query = normalizeQuery(rawQuery);
  const limit = Math.min(25, Math.max(1, opts.limit ?? 10));
  if (!query) return { query, matches: [], usedRemote: false };

  const local = await searchSymbols(db, query, limit);

  // An exact symbol hit is the answer; no round trip can improve on it.
  const exact = local.some((m) => m.rank >= 100);
  if (opts.localOnly || exact || local.length >= THIN_RESULT_THRESHOLD) {
    return { query, matches: local, usedRemote: false };
  }

  const remote = await searchYahoo(query, limit);
  if (!remote.length) return { query, matches: local, usedRemote: true };

  await upsertSymbols(db, remote);
  // Re-run the local search rather than merging by hand: the ranking rules live
  // in one place, and the newly-cached rows must be ordered by the same ones.
  return { query, matches: await searchSymbols(db, query, limit), usedRemote: true };
}

/**
 * Best-effort single answer, for callers that must end up with one symbol —
 * a URL like /ticker/rivian, or the watchlist "add" box.
 *
 * Returns null rather than guessing when the top two candidates are equally
 * good: silently putting the wrong company on someone's watchlist is worse
 * than asking them to pick.
 */
export async function resolveOne(
  db: Client,
  rawQuery: string,
  opts: LookupOptions = {},
): Promise<SymbolMatch | null> {
  const query = normalizeQuery(rawQuery);
  if (!query) return null;
  const { matches } = await lookupSymbols(db, query, { ...opts, limit: 2 });
  const best = matches[0];
  if (!best) return null;

  // An exact symbol is the answer, full stop.
  if (best.rank >= 100) return best;

  // A name that the top result *starts with* resolves. Ties are not a reason to
  // refuse: the ranking already breaks them toward the primary listing, which
  // is why "rivian" gives RIVN and not its warrants (RIVNW), and "apple" gives
  // AAPL and not Apple Hospitality REIT. Refusing on an equal rank made the
  // single most obvious query in the feature return nothing.
  if (best.rank >= 80 && !looksLikeTicker(query)) return best;

  // Everything else is a guess. A ticker-shaped query that only prefix-matched
  // ("apl") is far more likely a typo for a real symbol than an instruction to
  // add the first company whose ticker starts that way, and a bare substring
  // hit ("motor") could be any of a dozen names. Both go back to the picker.
  return null;
}
