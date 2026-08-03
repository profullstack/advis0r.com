/**
 * Executes a digest run: decide what is due, build the summary once, send each
 * recipient their slice.
 *
 * The whole run is designed to be safe to invoke repeatedly — by the in-process
 * scheduler, by cron, and by hand — because "did the 4am job actually fire?" is
 * a question you only get to answer after the fact. Idempotency lives in
 * `digest_sends`, not in whoever calls this.
 */
import type { Client } from "@libsql/client";
import { Mailer } from "../auth/email.ts";
import type { AlpacaMarketDataClient } from "../providers/interfaces.ts";
import {
  claimSend,
  markSent,
  recipientsFor,
  releaseFailedSend,
  type DigestRecipient,
} from "./preferences.ts";
import { renderDigest } from "./render.ts";
import { buildMarketSummary, summaryForTickers } from "./summary.ts";
import { digestsDue, type DigestWindow, type DueOptions } from "./schedule.ts";

export interface DigestDeps {
  db: Client;
  mailer: Mailer;
  market: AlpacaMarketDataClient;
  appUrl: string;
  marketSource?: string;
}

export interface DigestRunOptions extends DueOptions {
  now?: Date;
  /** Restrict the run to one cadence. */
  only?: "daily" | "weekly";
  /** Build and report, but send nothing and claim nothing. */
  dryRun?: boolean;
  /** Send to just this address (must already be a subscriber). Ignores claims. */
  onlyEmail?: string;
  onProgress?: (message: string) => void;
}

export interface WindowResult {
  frequency: string;
  periodKey: string;
  sessions: string[];
  recipients: number;
  sent: number;
  failed: number;
  skipped: number;
}

export interface DigestRunResult {
  ran: boolean;
  skipped?: string;
  windows: WindowResult[];
  sent: number;
  failed: number;
}

export async function runDigests(
  deps: DigestDeps,
  opts: DigestRunOptions = {},
): Promise<DigestRunResult> {
  const now = opts.now ?? new Date();
  const log = opts.onProgress ?? (() => {});
  const decision = digestsDue(now, opts);

  if (!decision.windows.length) {
    return { ran: false, skipped: decision.skipped, windows: [], sent: 0, failed: 0 };
  }

  const windows = opts.only
    ? decision.windows.filter((w) => w.frequency === opts.only)
    : decision.windows;

  const results: WindowResult[] = [];
  let sent = 0;
  let failed = 0;

  for (const window of windows) {
    const result = await runWindow(deps, window, opts, log);
    results.push(result);
    sent += result.sent;
    failed += result.failed;
  }

  return { ran: true, windows: results, sent, failed };
}

async function runWindow(
  deps: DigestDeps,
  window: DigestWindow,
  opts: DigestRunOptions,
  log: (message: string) => void,
): Promise<WindowResult> {
  const result: WindowResult = {
    frequency: window.frequency,
    periodKey: window.periodKey,
    sessions: window.sessions,
    recipients: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
  };

  // A targeted send is an explicit re-send, so it ignores the period filter —
  // otherwise the one case it exists for ("that email looked wrong, send it
  // again") is the one case it cannot do.
  let recipients = await recipientsFor(deps.db, window, {
    includeAlreadySent: Boolean(opts.onlyEmail),
  });
  if (opts.onlyEmail) {
    const wanted = opts.onlyEmail.trim().toLowerCase();
    recipients = recipients.filter((r) => r.email.toLowerCase() === wanted);
  }
  result.recipients = recipients.length;
  if (!recipients.length) {
    log(`${window.frequency}: nobody due for ${window.periodKey}`);
    return result;
  }

  // One market fetch for the union of every subscriber's watchlist.
  const tickers = [...new Set(recipients.flatMap((r) => r.tickers))];
  log(`${window.frequency}: ${recipients.length} recipient(s), ${tickers.length} ticker(s)`);
  const summary = await buildMarketSummary(
    { db: deps.db, market: deps.market, marketSource: deps.marketSource },
    window,
    tickers,
  );
  if (summary.marketError) log(`market data warning: ${summary.marketError}`);

  for (const recipient of recipients) {
    const outcome = await sendOne(deps, window, recipient, summary, opts);
    result[outcome] += 1;
    if (outcome === "failed") log(`${recipient.email}: send failed`);
  }
  return result;
}

async function sendOne(
  deps: DigestDeps,
  window: DigestWindow,
  recipient: DigestRecipient,
  summary: Awaited<ReturnType<typeof buildMarketSummary>>,
  opts: DigestRunOptions,
): Promise<"sent" | "failed" | "skipped"> {
  const user = summaryForTickers(summary, recipient.tickers);
  const message = renderDigest(summary, user, {
    appUrl: deps.appUrl,
    unsubscribeToken: recipient.unsubscribeToken,
    displayName: recipient.displayName,
  });
  // Nothing to report (every ticker missing data) — do not burn the period key
  // on an empty email; a later run inside the catch-up window may do better.
  if (!message) return "skipped";
  if (opts.dryRun) return "sent";

  // Claim first: the email is only attempted by whoever wins the row.
  if (!opts.onlyEmail && !(await claimSend(deps.db, recipient.userId, window, user.rows.length))) {
    return "skipped";
  }

  const result = await deps.mailer.send({ to: recipient.email, ...message });
  if (!result.ok) {
    if (!opts.onlyEmail) {
      await releaseFailedSend(deps.db, recipient.userId, window, result.error ?? "unknown error");
    }
    return "failed";
  }
  if (!opts.onlyEmail) await markSent(deps.db, recipient.userId, window, result.transport);
  return "sent";
}

/* ---------------- in-process scheduler ---------------- */

/** How often the server re-checks whether a digest is due. */
export const SCHEDULER_INTERVAL_MS = 5 * 60_000;

/**
 * Start the background scheduler.
 *
 * A five-minute tick plus the catch-up window in `digestsDue` means a digest
 * goes out within minutes of the pre-market bell, and a server that was asleep
 * at 04:00 still delivers when it wakes — while `digest_sends` guarantees the
 * repeated ticks never send twice.
 *
 * Returns a stop function; a no-op when the scheduler is disabled.
 */
export function startDigestScheduler(
  deps: DigestDeps,
  opts: { enabled?: boolean; intervalMs?: number } = {},
): () => void {
  if (opts.enabled === false) return () => {};

  let running = false;
  const tick = async () => {
    if (running) return; // a slow run must not overlap the next tick
    running = true;
    try {
      const result = await runDigests(deps, {
        onProgress: (m) => console.log(`[digest] ${m}`),
      });
      if (result.ran && (result.sent || result.failed)) {
        console.log(`[digest] sent ${result.sent}, failed ${result.failed}`);
      }
    } catch (err) {
      console.error(`[digest] run failed: ${String(err).slice(0, 300)}`);
    } finally {
      running = false;
    }
  };

  const timer = setInterval(tick, opts.intervalMs ?? SCHEDULER_INTERVAL_MS);
  // Do not hold the process open for the sake of the timer.
  (timer as unknown as { unref?: () => void }).unref?.();
  void tick();
  return () => clearInterval(timer);
}
