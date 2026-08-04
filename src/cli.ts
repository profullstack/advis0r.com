#!/usr/bin/env bun
/**
 * transcript-search CLI (PRD §5, §24). Binary name: `transcripts`.
 */
import { Command } from "commander";
import { loadConfig, configPath, type AppConfig } from "./config.ts";
import { getDb, migrate, closeDb } from "./db/index.ts";
import { buildRegistry } from "./registry.ts";
import { analyzeTicker } from "./pipeline/analyze.ts";
import { renderTerminal, renderMarkdown, renderJson } from "./ranking/report.ts";
import { applyFilters, type Candidate, type ScreenCriteria } from "./screen/filters.ts";
import { calculateIndicators, scoreTechnicalSetup } from "./technical/indicators.ts";
import { DISCLAIMER } from "./compliance.ts";
import { parseAbbrevNumber, parseList, todayIso } from "./util/parse.ts";
import type { RankedCandidate } from "./types.ts";

const program = new Command();
program
  .name("transcripts")
  .description(
    "Discover, index, and analyze executive communications into an evidence-backed stock watchlist.",
  )
  .version("2.0.0");

function screenCriteriaFromOpts(opts: any, config: AppConfig): ScreenCriteria {
  return {
    priceMin: parseAbbrevNumber(opts.priceMin) ?? config.screen.priceMin,
    priceMax: parseAbbrevNumber(opts.priceMax) ?? config.screen.priceMax,
    marketCapMin: parseAbbrevNumber(opts.marketCapMin) ?? config.screen.marketCapMin,
    marketCapMax: parseAbbrevNumber(opts.marketCapMax) ?? config.screen.marketCapMax,
    avgVolumeMin: parseAbbrevNumber(opts.avgVolumeMin) ?? config.screen.avgVolumeMin,
    avgDollarVolumeMin:
      parseAbbrevNumber(opts.avgDollarVolumeMin) ?? config.screen.avgDollarVolumeMin,
    maxSpreadPercent: parseAbbrevNumber(opts.maxSpreadPercent) ?? config.risk.maxBidAskSpreadPercent,
    exchanges: parseList(opts.exchange),
    excludeOtc: opts.excludeOtc ?? config.screen.excludeOtc,
    excludeBankrupt: opts.excludeBankrupt ?? config.screen.excludeBankrupt,
    excludeGoingConcern: opts.excludeGoingConcern ?? config.screen.excludeGoingConcern,
    rsiMin: parseAbbrevNumber(opts.rsiMin),
    rsiMax: parseAbbrevNumber(opts.rsiMax),
    aboveSma20: opts.aboveSma_20 ?? opts.aboveSma20,
    aboveSma50: opts.aboveSma_50 ?? opts.aboveSma50,
    aboveSma200: opts.aboveSma_200 ?? opts.aboveSma200,
    goldenCross: opts.goldenCross,
    relativeVolumeMin: parseAbbrevNumber(opts.relativeVolumeMin),
    momentum20dMin: parseAbbrevNumber(opts.momentum_20dMin ?? opts.momentum20dMin),
    momentum60dMin: parseAbbrevNumber(opts.momentum_60dMin ?? opts.momentum60dMin),
    trend: opts.trend,
  };
}

/** Shared discover/analyze option set. */
function addScreenOptions(cmd: Command): Command {
  return cmd
    .option("--from <date>", "start date (ISO)")
    .option("--to <date>", "end date (ISO)")
    .option("--as-of <date>", "point-in-time as-of date (ISO)")
    .option("--price-min <n>")
    .option("--price-max <n>")
    .option("--market-cap-min <n>", "e.g. 25m")
    .option("--market-cap-max <n>", "e.g. 5b")
    .option("--avg-volume-min <n>")
    .option("--avg-dollar-volume-min <n>")
    .option("--max-spread-percent <n>")
    .option("--exchange <list>", "NASDAQ,NYSE,AMEX")
    .option("--exclude-otc")
    .option("--exclude-bankrupt")
    .option("--exclude-going-concern")
    .option("--above-sma-50")
    .option("--above-sma-200")
    .option("--relative-volume-min <n>")
    .option("--momentum-60d-min <n>")
    .option("--trend <trend>", "bullish|neutral|bearish")
    .option("--horizon-quarters <n>", "1 or 2", "2")
    .option("--provider <id>", "openai|anthropic")
    .option("--model <id>", "explicit id or alias fast|balanced|deep|latest")
    .option("--tickers <list>", "explicit candidate tickers (comma-separated)")
    .option("--limit <n>", "max candidates", "25")
    .option("--json", "emit JSON")
    .option("--markdown", "emit Markdown")
    .option("--include-evidence")
    .option("--include-score-breakdown");
}

async function withApp<T>(fn: (ctx: {
  config: AppConfig;
  db: ReturnType<typeof getDb>;
  registry: ReturnType<typeof buildRegistry>;
}) => Promise<T>): Promise<T> {
  const config = loadConfig();
  const db = getDb(config);
  await migrate(db);
  const registry = buildRegistry(config);
  try {
    return await fn({ config, db, registry });
  } finally {
    closeDb();
  }
}

// --- init -----------------------------------------------------------------
program
  .command("init")
  .description("Create/upgrade the database schema (FTS5).")
  .action(async () => {
    await withApp(async ({ config }) => {
      console.log(`Database ready: ${config.databaseUrl}`);
      console.log(`Config: ${configPath()}`);
    });
  });

// --- search ---------------------------------------------------------------
program
  .command("search <query>")
  .description("Full-text search indexed transcript segments (FTS5).")
  .option("--from <date>")
  .option("--to <date>")
  .option("--limit <n>", "max results", "20")
  .action(async (query: string, opts) => {
    await withApp(async ({ db }) => {
      const limit = Number(opts.limit) || 20;
      try {
        const rs = await db.execute({
          sql: `SELECT text, speaker, ticker, event_date
                FROM segments_fts
                WHERE segments_fts MATCH ?
                  AND (? IS NULL OR event_date >= ?)
                  AND (? IS NULL OR event_date <= ?)
                LIMIT ?`,
          args: [query, opts.from ?? null, opts.from ?? null, opts.to ?? null, opts.to ?? null, limit],
        });
        if (rs.rows.length === 0) {
          console.log("No matches. (Ingest transcripts with `transcripts sync` first.)");
          return;
        }
        for (const row of rs.rows) {
          console.log(`[${row.event_date}] ${row.ticker ?? "?"} ${row.speaker ?? ""}`);
          console.log(`  ${String(row.text).slice(0, 240)}`);
        }
      } catch (err) {
        console.error(`Search failed: ${String(err)}`);
      }
    });
  });

// --- sync (ingestion) -----------------------------------------------------
program
  .command("sync <topic>")
  .description("Crawl & index transcripts/exhibits from providers (SEC EDGAR live).")
  .option("--from <date>", "start date (ISO)")
  .option("--to <date>", "end date (ISO)")
  .option("--limit <n>", "max documents per provider", "40")
  .option("--seeds <list>", "generic-html seeds as TICKER=URL,TICKER=URL")
  .action(async (topic: string, opts) => {
    await withApp(async ({ config, db, registry }) => {
      const { ingest } = await import("./pipeline/ingest.ts");
      const seeds = opts.seeds ? String(opts.seeds).split(",") : undefined;
      const result = await ingest(
        db,
        config,
        registry.transcripts,
        {
          topic,
          from: opts.from,
          to: opts.to,
          limit: Number(opts.limit) || 40,
          tickers: seeds,
        },
        (msg) => console.error(`  ${msg}`),
      );
      console.log(
        `Indexed ${result.documents} document(s), ${result.segments} segment(s), ${result.signals} signal(s).`,
      );
      if (result.boilerplateSuppressed) {
        console.log(
          `Suppressed ${result.boilerplateSuppressed} boilerplate match(es) (PRD v3 §4.1).`,
        );
      }
      if (result.errors.length) {
        console.error(`${result.errors.length} error(s):`);
        for (const e of result.errors.slice(0, 5)) console.error(`  - ${e}`);
      }
    });
  });

// --- news -----------------------------------------------------------------
program
  .command("news <tickers...>")
  .description(
    "Ingest reputable news coverage for tickers: RSS + ValueSERP discovery, self-fetched article bodies, reputation-tiered (PRD v3 §3).",
  )
  .option("--from <date>", "only articles on/after this ISO date")
  .option("--to <date>", "anchor date for relative article dates (ISO)")
  .option("--per-ticker <n>", "max articles per ticker", "12")
  .option("--exclude-tier3", "skip excluded/promo sources entirely", false)
  .option("--wires", "also scan newswire firehose feeds", false)
  .action(async (tickers: string[], opts) => {
    await withApp(async ({ config, db, registry }) => {
      const { ingest } = await import("./pipeline/ingest.ts");
      const { NewsProvider } = await import("./providers/news/index.ts");
      const symbols = tickers.map((t) => t.toUpperCase());

      const provider = new NewsProvider({
        downloadsDir: config.downloadsDir,
        valueSerpKey: config.secrets.valueSerpApiKey,
        perTicker: Number(opts.perTicker) || 12,
        excludeTier3: Boolean(opts.excludeTier3),
        includeWires: Boolean(opts.wires),
      });
      provider.setCompanyNames(await loadCompanyNames(db, symbols));

      console.error(
        `Discovery: RSS (keyless)${provider.serpConfigured ? " + ValueSERP" : " — ValueSERP key not set"}`,
      );

      const result = await ingest(
        db,
        config,
        [provider],
        { topic: "news", from: opts.from, to: opts.to, tickers: symbols },
        (msg) => console.error(`  ${msg}`),
      );
      console.log(
        `Indexed ${result.documents} article(s), ${result.segments} segment(s), ${result.signals} signal(s).`,
      );
      if (result.boilerplateSuppressed) {
        console.log(`Suppressed ${result.boilerplateSuppressed} boilerplate match(es).`);
      }
      const tierRs = await db.execute(
        `SELECT source_tier, COUNT(*) n FROM documents WHERE provider_id = 'news' GROUP BY 1 ORDER BY 1`,
      );
      if (tierRs.rows.length) {
        console.log("News corpus by tier:");
        for (const r of tierRs.rows) console.log(`  tier ${r.source_tier}: ${r.n}`);
      }
      if (result.errors.length) {
        console.error(`${result.errors.length} error(s):`);
        for (const e of result.errors.slice(0, 5)) console.error(`  - ${e}`);
      }
      void registry;
    });
  });

/** Company names already known from indexed SEC filings, for better queries. */
async function loadCompanyNames(
  db: ReturnType<typeof getDb>,
  tickers: string[],
): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  if (tickers.length === 0) return names;
  const rs = await db.execute(
    `SELECT DISTINCT t.primary_ticker AS ticker, d.meta_json AS meta
     FROM transcripts t JOIN documents d ON d.id = t.document_id
     WHERE t.primary_ticker IS NOT NULL AND d.meta_json IS NOT NULL`,
  );
  const wanted = new Set(tickers);
  for (const row of rs.rows) {
    const ticker = String(row.ticker ?? "").toUpperCase();
    if (!wanted.has(ticker) || names.has(ticker)) continue;
    try {
      const meta = JSON.parse(String(row.meta ?? "{}"));
      if (meta.companyName) names.set(ticker, String(meta.companyName));
    } catch {
      /* malformed meta is not fatal */
    }
  }
  return names;
}

// --- media ----------------------------------------------------------------
program
  .command("media <tickers...>")
  .description(
    "Ingest audio/video appearances — earnings calls, keynotes, conferences, podcasts (PRD v3 §2).",
  )
  .option("--from <date>", "only media published on/after this ISO date")
  .option("--per-ticker <n>", "max media items per ticker", "4")
  .option("--no-asr", "captions only; never spend on speech-to-text")
  .option("--channels <urls>", "extra YouTube channel/playlist URLs (comma-separated)")
  .action(async (tickers: string[], opts) => {
    await withApp(async ({ config, db }) => {
      const { ingest } = await import("./pipeline/ingest.ts");
      const { MediaProvider } = await import("./providers/media/index.ts");
      const symbols = tickers.map((t) => t.toUpperCase());

      const provider = new MediaProvider({
        downloadsDir: config.downloadsDir,
        elevenLabsApiKey: config.secrets.elevenLabsApiKey,
        groqApiKey: config.secrets.groqApiKey,
        openaiApiKey: config.secrets.openaiApiKey,
        perTicker: Number(opts.perTicker) || 4,
        allowAsr: opts.asr !== false,
        channels: opts.channels ? String(opts.channels).split(",").map((s) => s.trim()) : undefined,
      });
      provider.setCompanyNames(await loadCompanyNames(db, symbols));

      console.error(
        `Transcript sources: captions (keyless)${
          provider.asrConfigured && opts.asr !== false
            ? ` + ASR via ${provider.asrBackend}`
            : " — ASR disabled or no ASR key set (ELEVENLABS_API_KEY / GROQ_API_KEY / OPENAI_API_KEY)"
        }`,
      );

      const result = await ingest(
        db,
        config,
        [provider],
        { topic: "media", from: opts.from, tickers: symbols },
        (msg) => console.error(`  ${msg}`),
      );
      console.log(
        `Indexed ${result.documents} media transcript(s), ${result.segments} segment(s), ${result.signals} signal(s).`,
      );
      if (result.boilerplateSuppressed) {
        console.log(`Suppressed ${result.boilerplateSuppressed} boilerplate match(es).`);
      }
      const rs = await db.execute(
        `SELECT event_type, provenance, COUNT(*) n FROM documents
         WHERE provider_id = 'media' GROUP BY 1, 2 ORDER BY n DESC`,
      );
      if (rs.rows.length) {
        console.log("Media corpus:");
        for (const r of rs.rows) {
          console.log(`  ${r.event_type} (${r.provenance ?? "?"}): ${r.n}`);
        }
      }
      if (result.errors.length) {
        console.error(`${result.errors.length} note(s)/error(s):`);
        for (const e of result.errors.slice(0, 6)) console.error(`  - ${e}`);
      }
    });
  });

// --- corroborate ----------------------------------------------------------
program
  .command("corroborate [tickers...]")
  .description(
    "Link primary claims to independent confirmation across sources; flag promotional coverage (PRD v3 §3.4, §3.5).",
  )
  .option("--min-overlap <n>", "fraction of claim terms that must match", "0.35")
  .action(async (tickers: string[], opts) => {
    await withApp(async ({ db }) => {
      const { corroborate } = await import("./corroborate/engine.ts");
      const result = await corroborate(
        db,
        {
          tickers: tickers?.length ? tickers : undefined,
          minOverlap: Number(opts.minOverlap) || 0.35,
        },
        (msg) => console.error(`  ${msg}`),
      );
      console.log(
        `Scanned ${result.tickersScanned} ticker(s), ${result.claimsScanned} claim(s).`,
      );
      console.log(
        `Confirms: ${result.confirms}  Contradicts: ${result.contradicts}  Amplifies-only: ${result.amplifiesOnly}`,
      );
      if (result.promotionFlags.length) {
        console.log(
          `Promotional coverage flagged: ${result.promotionFlags.join(", ")}`,
        );
      }
    });
  });

// --- credits --------------------------------------------------------------
const credits = program
  .command("credits")
  .description("Inspect and manage user credits (PRD v3 §8).");

credits
  .command("balance <email>")
  .description("Show a user's credit balance and recent ledger entries.")
  .action(async (email: string) => {
    await withApp(async ({ db }) => {
      const { getBalance, recentLedger } = await import("./credits/ledger.ts");
      const user = await findUserByEmail(db, email);
      if (!user) return console.error(`No account for ${email}`);
      const b = await getBalance(db, user.id);
      console.log(`${email}`);
      console.log(`  balance:            ${b.balance} credits`);
      console.log(`  free monthly grant: ${b.freeMonthlyCredits} (period ${b.period})`);
      console.log(`  spent this period:  ${b.spentThisPeriod}`);
      const ledger = await recentLedger(db, user.id, 15);
      if (ledger.length) {
        console.log("  recent:");
        for (const e of ledger) {
          const sign = e.delta > 0 ? "+" : "";
          console.log(`    ${e.createdAt.slice(0, 19)}  ${(sign + e.delta).padStart(6)}  ${e.reason}`);
        }
      }
    });
  });

credits
  .command("grant <email> <amount>")
  .description("Manually add (or subtract, with a negative amount) credits.")
  .option("--note <text>", "reason recorded in the ledger", "manual adjustment")
  .action(async (email: string, amount: string, opts) => {
    await withApp(async ({ db }) => {
      const { getBalance } = await import("./credits/ledger.ts");
      const { newId } = await import("./auth/crypto.ts");
      const user = await findUserByEmail(db, email);
      if (!user) return console.error(`No account for ${email}`);
      const delta = Number(amount);
      if (!Number.isInteger(delta) || delta === 0) return console.error("Amount must be a non-zero integer.");
      await db.execute({
        sql: `INSERT INTO credits_ledger (id, user_id, delta, reason, idem, note, created_at)
              VALUES (?,?,?,?,?,?,?)`,
        args: [newId("cr"), user.id, delta, "adjustment", newId("adj"), String(opts.note), new Date().toISOString()],
      });
      console.log(`${delta > 0 ? "Granted" : "Deducted"} ${Math.abs(delta)} credits. New balance: ${(await getBalance(db, user.id)).balance}`);
    });
  });

credits
  .command("packages")
  .description("List purchasable credit packages.")
  .action(async () => {
    const { CREDIT_PACKAGES, FREE_MONTHLY_CREDITS } = await import("./credits/ledger.ts");
    console.log(`Free plan: ${FREE_MONTHLY_CREDITS} credits per month.`);
    for (const p of CREDIT_PACKAGES) {
      console.log(`  ${p.id.padEnd(9)} ${String(p.credits).padStart(5)} credits  $${p.usd}  (${(p.usd / p.credits * 100).toFixed(2)}¢/credit)`);
    }
  });

credits
  .command("buy <email> <packageId>")
  .description("Create a CoinPayPortal payment for a credit package and print the payment URL.")
  .option("--blockchain <chain>", "chain code, e.g. USDC_POL / ETH / BTC", "USDC_POL")
  .action(async (email: string, packageId: string, opts) => {
    await withApp(async ({ config, db }) => {
      const { CoinPayClient } = await import("./credits/coinpay.ts");
      const { findPackage } = await import("./credits/ledger.ts");
      const { newId } = await import("./auth/crypto.ts");
      const user = await findUserByEmail(db, email);
      if (!user) return console.error(`No account for ${email}`);
      const pkg = findPackage(packageId);
      if (!pkg) return console.error(`Unknown package "${packageId}". Try: transcripts credits packages`);

      const client = new CoinPayClient({
        apiKey: config.secrets.coinpayApiKey,
        businessId: config.secrets.coinpayBusinessId,
        webhookSecret: config.secrets.coinpayWebhookSecret,
      });
      if (!client.configured) {
        return console.error("CoinPayPortal is not configured (COINPAYPORTAL_API_KEY / COINPAYPORTAL_WEBHOOK_SECRET).");
      }
      const payment = await client.createPayment({
        amountUsd: pkg.usd,
        blockchain: String(opts.blockchain),
        description: `advis0r.com — ${pkg.label}`,
        metadata: { user_id: user.id, package_id: pkg.id, credits: String(pkg.credits) },
        webhookUrl: `${config.appUrl.replace(/\/$/, "")}/api/webhook/coinpay`,
      });
      await db.execute({
        sql: `INSERT INTO credit_purchases
              (id, user_id, payment_id, package_id, credits, amount_usd, blockchain, status, payment_url, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?)`,
        args: [newId("pur"), user.id, payment.paymentId, pkg.id, pkg.credits, pkg.usd,
               String(opts.blockchain), "pending", payment.paymentUrl, new Date().toISOString()],
      });
      console.log(`Payment created for ${email}: ${pkg.label} ($${pkg.usd})`);
      console.log(`  payment id: ${payment.paymentId}`);
      console.log(`  pay here:   ${payment.paymentUrl}`);
      console.log("Credits are added automatically once the payment confirms (webhook).");
    });
  });

/** Look up a user by email for the CLI's admin commands. */
async function findUserByEmail(
  db: ReturnType<typeof getDb>,
  email: string,
): Promise<{ id: string; email: string } | null> {
  const rs = await db.execute({
    sql: "SELECT id, email FROM users WHERE email = ?",
    args: [email.trim().toLowerCase()],
  });
  const row = rs.rows[0];
  return row ? { id: String(row.id), email: String(row.email) } : null;
}

// --- symbols --------------------------------------------------------------
// The name -> ticker directory behind /api/lookup. Syncing is optional: lookup
// falls back to a keyless Yahoo search and caches what it finds. Syncing just
// makes the common case local, and therefore fast enough for a typeahead.
const symbols = program
  .command("symbols")
  .description("Ticker lookup directory: sync, search, inspect.");

symbols
  .command("sync")
  .description("Load the full tradable-asset list into the local lookup directory.")
  .action(async () => {
    await withApp(async ({ db, registry }) => {
      const { fetchAlpacaDirectory } = await import("./symbols/providers.ts");
      const { upsertSymbols, directoryAge } = await import("./symbols/directory.ts");
      const before = await directoryAge(db);
      console.log(`Directory before: ${before.count} symbol(s)`);

      let rows: Awaited<ReturnType<typeof fetchAlpacaDirectory>> = [];
      try {
        rows = await fetchAlpacaDirectory(registry.alpaca);
      } catch (err) {
        console.error(`Asset list unavailable: ${String(err).slice(0, 200)}`);
      }
      if (!rows.length) {
        console.error(
          "No bulk asset list available (Alpaca credentials required).\n" +
          "Lookup still works — it falls back to a keyless Yahoo search and caches results.",
        );
        return;
      }
      const written = await upsertSymbols(db, rows);
      const after = await directoryAge(db);
      console.log(`Wrote ${written} symbol(s). Directory now: ${after.count}.`);
    });
  });

symbols
  .command("find <query...>")
  .description('Look up a ticker by name or symbol (e.g. "rivian").')
  .option("--limit <n>", "max results", "10")
  .option("--local", "do not fall back to the remote search", false)
  .action(async (query: string[], opts) => {
    await withApp(async ({ db }) => {
      const { lookupSymbols } = await import("./symbols/lookup.ts");
      const result = await lookupSymbols(db, query.join(" "), {
        limit: Number(opts.limit) || 10,
        localOnly: Boolean(opts.local),
      });
      if (!result.matches.length) {
        console.log(`No match for "${result.query}".`);
        return;
      }
      for (const m of result.matches) {
        console.log(`  ${m.symbol.padEnd(8)} ${String(m.exchange ?? "").padEnd(8)} ${m.name}`);
      }
      if (result.usedRemote) console.log("(remote search was consulted; results cached locally)");
    });
  });

symbols
  .command("status")
  .description("Size and freshness of the lookup directory.")
  .action(async () => {
    await withApp(async ({ db }) => {
      const { directoryAge } = await import("./symbols/directory.ts");
      const { count, newest } = await directoryAge(db);
      console.log(`symbols:     ${count}`);
      console.log(`last update: ${newest ?? "never"}`);
      if (!count) console.log("Run `transcripts symbols sync` to load the full asset list.");
    });
  });

// --- digest ---------------------------------------------------------------
// Watchlist email digests. The server runs these on its own schedule; these
// commands exist for cron-based deployments (DIGEST_SCHEDULER=0), for previewing
// what a subscriber would receive, and for answering "did it go out?".
const digest = program
  .command("digest")
  .description("Watchlist email digests: send, preview, and inspect subscriptions.");

digest
  .command("send")
  .description("Send any digest that is due now. Safe to run repeatedly (at-most-once per period).")
  .option("--daily", "restrict to the daily digest")
  .option("--weekly", "restrict to the weekly digest")
  .option("--force", "ignore the trading-day and pre-market-open gates", false)
  .option("--dry-run", "build and report, but send nothing", false)
  .option("--email <address>", "send only to this subscriber (ignores the send ledger)")
  .action(async (opts) => {
    await withApp(async ({ config, db, registry }) => {
      const { Mailer } = await import("./auth/email.ts");
      const { runDigests } = await import("./digest/run.ts");
      const mailer = new Mailer({
        resendApiKey: config.secrets.resendApiKey,
        mailgunApiKey: config.secrets.mailgunApiKey,
        mailgunDomain: config.secrets.mailgunDomain,
        from: config.secrets.mailFrom || undefined,
      });
      if (!mailer.configured && !opts.dryRun) {
        console.error("No email transport configured — set RESEND_API_KEY or MAILGUN_API_KEY.");
      }
      const result = await runDigests(
        { db, mailer, market: registry.alpaca, appUrl: config.appUrl, marketSource: registry.marketSource },
        {
          force: Boolean(opts.force),
          dryRun: Boolean(opts.dryRun),
          onlyEmail: opts.email,
          only: opts.daily ? "daily" : opts.weekly ? "weekly" : undefined,
          onProgress: (m) => console.log(m),
        },
      );
      if (!result.ran) return console.log(`Nothing due: ${result.skipped}`);
      for (const w of result.windows) {
        console.log(
          `${w.frequency.padEnd(6)} ${w.periodKey.padEnd(22)} covering ${w.sessions.join(", ")}\n` +
          `  recipients ${w.recipients}  sent ${w.sent}  failed ${w.failed}  skipped ${w.skipped}`,
        );
      }
      if (opts.dryRun) console.log("(dry run — no mail was sent and no period was consumed)");
    });
  });

digest
  .command("preview <email>")
  .description("Print the digest this account would receive, without sending it.")
  .option("--weekly", "render the weekly digest instead of the daily one", false)
  .option("--html", "print the HTML body instead of the plain-text one", false)
  .action(async (email: string, opts) => {
    await withApp(async ({ config, db, registry }) => {
      const { digestsDue } = await import("./digest/schedule.ts");
      const { listWatchlist } = await import("./auth/watchlist.ts");
      const { unsubscribeToken } = await import("./digest/preferences.ts");
      const { buildMarketSummary, summaryForTickers } = await import("./digest/summary.ts");
      const { renderDigest } = await import("./digest/render.ts");

      const user = await findUserByEmail(db, email);
      if (!user) return console.error(`No account for ${email}`);
      const tickers = (await listWatchlist(db, user.id)).map((i) => i.ticker);
      if (!tickers.length) return console.error(`${email} has an empty watchlist — nothing to send.`);

      const wanted = opts.weekly ? "weekly" : "daily";
      const window = digestsDue(new Date(), { force: true }).windows.find((w) => w.frequency === wanted);
      if (!window) return console.error(`Could not build a ${wanted} window.`);

      const summary = await buildMarketSummary(
        { db, market: registry.alpaca, marketSource: registry.marketSource },
        window,
        tickers,
      );
      const message = renderDigest(summary, summaryForTickers(summary, tickers), {
        appUrl: config.appUrl,
        unsubscribeToken: await unsubscribeToken(db, user.id),
      });
      if (!message) return console.error("No market data for any watched ticker — nothing would be sent.");
      console.log(`Subject: ${message.subject}\n`);
      console.log(opts.html ? message.html : message.text);
    });
  });

digest
  .command("status [email]")
  .description("Show digest subscriptions, or one account's frequency and recent sends.")
  .action(async (email?: string) => {
    await withApp(async ({ db }) => {
      const { getPreference } = await import("./digest/preferences.ts");
      if (!email) {
        const rs = await db.execute(
          `SELECT COALESCE(digest_frequency, 'daily') AS f, COUNT(*) AS n
           FROM users WHERE email_verified_at IS NOT NULL AND COALESCE(disabled, 0) = 0
           GROUP BY f ORDER BY n DESC`,
        );
        console.log("Verified accounts by digest frequency:");
        for (const r of rs.rows) console.log(`  ${String(r.f).padEnd(7)} ${r.n}`);
        const due = await db.execute(
          `SELECT COUNT(DISTINCT u.id) AS n FROM users u JOIN watchlist_items w ON w.user_id = u.id
           WHERE COALESCE(u.digest_frequency, 'daily') != 'off'
             AND u.email_verified_at IS NOT NULL AND COALESCE(u.disabled, 0) = 0`,
        );
        console.log(`Mailable (verified, subscribed, non-empty watchlist): ${due.rows[0]?.n ?? 0}`);
        return;
      }
      const user = await findUserByEmail(db, email);
      if (!user) return console.error(`No account for ${email}`);
      const pref = await getPreference(db, user.id);
      console.log(`${email}`);
      console.log(`  frequency:  ${pref.frequency}`);
      console.log(`  last sent:  ${pref.lastSentAt ?? "never"}`);
      console.log(`  next send:  ${pref.nextSendAt ?? "— (unsubscribed)"}`);
      const rs = await db.execute({
        sql: `SELECT period_key, covering, tickers, status, transport, error, created_at
              FROM digest_sends WHERE user_id = ? ORDER BY created_at DESC LIMIT 10`,
        args: [user.id],
      });
      if (rs.rows.length) {
        console.log("  recent:");
        for (const r of rs.rows) {
          console.log(
            `    ${String(r.created_at).slice(0, 19)}  ${String(r.period_key).padEnd(22)}` +
            ` ${String(r.status).padEnd(7)} ${r.tickers} ticker(s)${r.error ? ` — ${r.error}` : ""}`,
          );
        }
      }
    });
  });

digest
  .command("set <email> <frequency>")
  .description("Set an account's digest frequency: daily | weekly | off.")
  .action(async (email: string, frequency: string) => {
    await withApp(async ({ db }) => {
      const { setPreference } = await import("./digest/preferences.ts");
      const user = await findUserByEmail(db, email);
      if (!user) return console.error(`No account for ${email}`);
      const result = await setPreference(db, user.id, frequency);
      if (!result.ok) return console.error(result.error);
      console.log(`${email}: digest frequency is now ${result.preference!.frequency}.`);
      console.log(`  next send: ${result.preference!.nextSendAt ?? "— (unsubscribed)"}`);
    });
  });

// --- reclassify -----------------------------------------------------------
program
  .command("reclassify")
  .description(
    "Rebuild the corpus boilerplate model and re-flag stored signals in place (PRD v3 §4.1).",
  )
  .option("--min-issuers <n>", "shingle must appear under >= n distinct tickers", "3")
  .option("--no-rebuild-corpus", "reuse the stored shingle model")
  .action(async (opts) => {
    await withApp(async ({ db }) => {
      const { reclassifySignals } = await import("./pipeline/reclassify.ts");
      const result = await reclassifySignals(
        db,
        {
          rebuildCorpus: opts.rebuildCorpus !== false,
          minIssuers: Number(opts.minIssuers) || 3,
        },
        (msg) => console.error(`  ${msg}`),
      );
      const pct = result.scanned ? ((100 * result.flagged) / result.scanned).toFixed(1) : "0.0";
      console.log(
        `Scanned ${result.scanned} signal(s): ${result.flagged} flagged as boilerplate (${pct}%), ${result.cleared} kept.`,
      );
      console.log(`Corpus model: ${result.corpusShingles} shingle(s).`);
      if (result.misattributed) {
        console.log(
          `Removed ${result.misattributed} misattributed signal(s) from multi-company documents (PRD §8.4).`,
        );
      }
      for (const [reason, n] of Object.entries(result.byReason).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(6)}  ${reason}`);
      }
    });
  });

// --- reextract --------------------------------------------------------------
program
  .command("reextract")
  .description(
    "Re-run signal extraction over stored documents, so a new taxonomy rule applies to what is already indexed.",
  )
  .option("--provider <id>", "restrict to one provider (e.g. news)")
  .option("--ticker <symbols...>", "restrict to these tickers")
  .option("--dry-run", "report what would be written, write nothing", false)
  .action(async (opts) => {
    await withApp(async ({ db }) => {
      const { reextractSignals } = await import("./pipeline/reextract.ts");
      const result = await reextractSignals(
        db,
        {
          providerId: opts.provider,
          tickers: opts.ticker,
          dryRun: Boolean(opts.dryRun),
        },
        (msg) => console.error(`  ${msg}`),
      );
      console.log(
        `${opts.dryRun ? "[dry run] " : ""}Re-extracted ${result.documents} document(s): ` +
          `${result.signalsFound} signal(s) matched, ${result.signalsInserted} new.`,
      );
      for (const [type, n] of Object.entries(result.byType).sort((a, b) => b[1] - a[1])) {
        console.log(`  ${String(n).padStart(6)}  ${type}`);
      }
      if (result.errors.length) {
        console.error(`${result.errors.length} error(s):`);
        for (const e of result.errors.slice(0, 5)) console.error(`  - ${e}`);
      }
    });
  });

// --- discover -------------------------------------------------------------
addScreenOptions(
  program.command("discover <topic>").description("Discover candidate stocks from transcript signals + market data."),
).action(async (topic: string, opts) => {
  await withApp(async ({ config, db, registry }) => {
    const asOf = opts.asOf ?? opts.to ?? todayIso();
    const horizon = (Number(opts.horizonQuarters) === 1 ? 1 : 2) as 1 | 2;
    const criteria = screenCriteriaFromOpts(opts, config);
    const provider = opts.provider ?? config.ai.defaultProvider;
    const model = opts.model ?? config.ai.defaultModelAlias;
    const limit = Number(opts.limit) || 25;

    const tickers = await resolveCandidateTickers(db, topic, opts.tickers, limit);
    if (tickers.length === 0) {
      console.log(
        "No candidate tickers. Provide --tickers, or index transcripts (`sync`) so signals\n" +
          "can be matched to the topic.",
      );
      return;
    }

    const ranked: RankedCandidate[] = [];
    for (const ticker of tickers) {
      try {
        const outcome = await analyzeTicker(db, config, registry, ticker, {
          topic,
          asOf,
          from: opts.from,
          to: opts.to,
          horizonQuarters: horizon,
          provider,
          model,
          criteria,
          persist: true,
        });
        if (outcome.filtered) {
          console.error(`- ${ticker}: filtered (${outcome.filterReasons.join("; ")})`);
        } else if (outcome.candidate) {
          ranked.push(outcome.candidate);
        }
      } catch (err) {
        console.error(`- ${ticker}: error ${String(err)}`);
      }
    }

    ranked.sort((a, b) => b.overallScore - a.overallScore);
    ranked.forEach((c, i) => (c.rank = i + 1));

    const header = {
      topic,
      from: opts.from,
      to: opts.to,
      priceMin: criteria.priceMin,
      priceMax: criteria.priceMax,
      horizonQuarters: horizon,
    };
    if (opts.json) {
      console.log(renderJson(ranked, header, {
        includeEvidence: opts.includeEvidence,
        includeScoreBreakdown: opts.includeScoreBreakdown,
      }));
    } else if (opts.markdown) {
      console.log(renderMarkdown(ranked, header));
    } else {
      console.log(renderTerminal(ranked, header));
    }
  });
});

// --- analyze-company ------------------------------------------------------
addScreenOptions(
  program
    .command("analyze-company <ticker>")
    .description("Deep analysis of one company over the horizon."),
)
  .option("--compare-prior-period")
  .option("--include-competitors")
  .option("--include-suppliers")
  .action(async (ticker: string, opts) => {
    await withApp(async ({ config, db, registry }) => {
      const asOf = opts.asOf ?? opts.to ?? todayIso();
      const horizon = (Number(opts.horizonQuarters) === 1 ? 1 : 2) as 1 | 2;
      const criteria = screenCriteriaFromOpts(opts, config);
      // analyze-company does not exclude on screen filters by default.
      const outcome = await analyzeTicker(db, config, registry, ticker.toUpperCase(), {
        topic: opts.topic ?? ticker,
        asOf,
        from: opts.from,
        to: opts.to,
        horizonQuarters: horizon,
        provider: opts.provider ?? config.ai.defaultProvider,
        model: opts.model ?? config.ai.defaultModelAlias,
        criteria: { ...criteria, priceMin: undefined, priceMax: undefined },
        persist: true,
      });
      if (outcome.candidate) {
        const c = outcome.candidate;
        c.rank = 1;
        console.log(
          opts.json
            ? renderJson([c], { topic: opts.topic ?? ticker, horizonQuarters: horizon }, { includeEvidence: true })
            : renderMarkdown([c], { topic: opts.topic ?? ticker, horizonQuarters: horizon }),
        );
      } else {
        console.log(`No analysis produced for ${ticker}: ${outcome.filterReasons.join("; ")}`);
      }
    });
  });

// --- compare --------------------------------------------------------------
program
  .command("compare <tickers...>")
  .description("Compare companies on a topic.")
  .option("--topic <topic>")
  .option("--from <date>")
  .option("--to <date>")
  .option("--provider <id>")
  .option("--model <id>")
  .action(async (tickers: string[], opts) => {
    await withApp(async ({ config, db, registry }) => {
      const asOf = opts.to ?? todayIso();
      const results: RankedCandidate[] = [];
      for (const t of tickers) {
        const outcome = await analyzeTicker(db, config, registry, t.toUpperCase(), {
          topic: opts.topic ?? "comparison",
          asOf,
          from: opts.from,
          to: opts.to,
          horizonQuarters: 2,
          provider: opts.provider ?? config.ai.defaultProvider,
          model: opts.model ?? config.ai.defaultModelAlias,
          criteria: {},
          persist: true,
        });
        if (outcome.candidate) results.push(outcome.candidate);
      }
      results.sort((a, b) => b.overallScore - a.overallScore);
      results.forEach((c, i) => (c.rank = i + 1));
      console.log(renderTerminal(results, { topic: opts.topic ?? "comparison", horizonQuarters: 2 }));
    });
  });

// --- screen (deterministic only, no LLM) ----------------------------------
addScreenOptions(
  program.command("screen").description("Deterministic screen (no LLM): filters on price/liquidity/technical."),
).action(async (opts) => {
  await withApp(async ({ config, registry }) => {
    const tickers = parseList(opts.tickers);
    if (!tickers?.length) {
      console.log("Provide --tickers to screen (universe crawl is Phase 2).");
      return;
    }
    const criteria = screenCriteriaFromOpts(opts, config);
    const icfg = {
      movingAverages: config.technical.movingAverages,
      emaPeriods: config.technical.emaPeriods,
      rsiPeriod: config.technical.rsiPeriod,
      macd: { fast: config.technical.macdFast, slow: config.technical.macdSlow, signal: config.technical.macdSignal },
      bollinger: { period: config.technical.bollingerPeriod, stdDev: config.technical.bollingerStddev },
      atrPeriod: config.technical.atrPeriod,
      relativeVolumePeriod: config.technical.relativeVolumePeriod,
    };
    for (const ticker of tickers) {
      const bars = await registry.alpaca.getBars({
        symbols: [ticker],
        timeframe: "1Day",
        limit: config.technical.lookbackDays,
        feed: config.alpaca.feed,
      });
      const [snapshot] = await registry.alpaca.getSnapshots([ticker]);
      const [asset] = await registry.alpaca.getAssets([ticker]);
      const facts = await registry.fundamentals.getCompanyFacts(ticker);
      const technical = bars.length ? calculateIndicators(bars, icfg) : undefined;
      const tscore = technical ? scoreTechnicalSetup(technical, 2) : undefined;
      const candidate: Candidate = { symbol: ticker, asset, snapshot, facts, technical };
      const res = applyFilters(candidate, criteria);
      console.log(
        `${ticker}: ${res.passed ? "PASS" : "EXCLUDE"} techScore=${tscore?.score ?? "n/a"}` +
          (res.passed ? "" : ` (${res.reasons.join("; ")})`),
      );
    }
  });
});

// --- models ---------------------------------------------------------------
const models = program.command("models").description("Model discovery (PRD §8.1).");
models
  .command("list")
  .option("--provider <id>", "openai|anthropic")
  .action(async (opts) => {
    await withApp(async ({ registry }) => {
      const ids = opts.provider ? [opts.provider] : [...registry.ai.keys()];
      for (const id of ids) {
        const p = registry.ai.get(id);
        if (!p) continue;
        try {
          const list = await p.listModels();
          console.log(`\n${id} (${list.length} models):`);
          for (const m of list.slice(0, 40)) console.log(`  ${m.id}${m.createdAt ? `  (${m.createdAt.slice(0, 10)})` : ""}`);
        } catch (err) {
          console.error(`  ${id}: ${String(err)}`);
        }
      }
    });
  });
models
  .command("refresh")
  .action(async () => {
    await withApp(async ({ registry }) => {
      for (const [id, p] of registry.ai) {
        try {
          const list = await p.listModels();
          console.log(`${id}: ${list.length} models cached.`);
        } catch (err) {
          console.error(`${id}: ${String(err)}`);
        }
      }
    });
  });
models
  .command("resolve <alias>")
  .option("--provider <id>", "openai|anthropic", "openai")
  .action(async (alias: string, opts) => {
    await withApp(async ({ registry }) => {
      const p = registry.ai.get(opts.provider);
      if (!p) return console.error(`Unknown provider ${opts.provider}`);
      const { resolveModel } = await import("./analysis/aliases.ts");
      const list = await p.listModels();
      const hints =
        opts.provider === "anthropic"
          ? { deep: /opus/, fast: /haiku/, balanced: /sonnet/ }
          : { deep: /^(o[0-9]|gpt-[0-9])/, fast: /mini|nano/, balanced: /gpt-[0-9]/ };
      console.log(resolveModel(alias, list, hints));
    });
  });

// --- providers ------------------------------------------------------------
program
  .command("providers")
  .description("List configured providers.")
  .action(async () => {
    await withApp(async ({ registry }) => {
      console.log("AI:", [...registry.ai.keys()].join(", "));
      console.log("Market data: alpaca");
      console.log("Fundamentals:", registry.fundamentals.id);
      console.log("Transcripts:", registry.transcripts.map((p) => p.id).join(", "));
    });
  });

// --- stats ----------------------------------------------------------------
program
  .command("stats")
  .description("Show database coverage stats.")
  .action(async () => {
    await withApp(async ({ db }) => {
      const tables = ["documents", "transcripts", "signals", "analyses", "market_bars"];
      for (const t of tables) {
        try {
          const rs = await db.execute(`SELECT COUNT(*) AS n FROM ${t}`);
          console.log(`${t}: ${rs.rows[0]?.n ?? 0}`);
        } catch {
          console.log(`${t}: (missing)`);
        }
      }
    });
  });

// --- backtest (Phase 2 scaffold) ------------------------------------------
program
  .command("backtest")
  .description("Point-in-time backtest (Phase 2; scaffolded).")
  .option("--topic <topic>")
  .option("--as-of <date>")
  .option("--price-max <n>")
  .option("--horizon-quarters <n>", "1 or 2", "2")
  .option("--price-min <n>")
  .option("--top <n>", "top-k", "20")
  .option("--json", "emit JSON")
  .action(async (opts) => {
    await withApp(async ({ config, db, registry }) => {
      const { runBacktest } = await import("./pipeline/backtest.ts");
      const metrics = await runBacktest(db, config, registry, {
        topic: opts.topic ?? "",
        asOf: opts.asOf ?? todayIso(),
        horizonQuarters: (Number(opts.horizonQuarters) === 1 ? 1 : 2) as 1 | 2,
        top: Number(opts.top) || 20,
        priceMax: parseAbbrevNumber(opts.priceMax),
        priceMin: parseAbbrevNumber(opts.priceMin),
      });
      if (opts.json) {
        console.log(JSON.stringify({ ...metrics, disclaimer: DISCLAIMER }, null, 2));
        return;
      }
      console.log(`Backtest — ${metrics.topic} as of ${metrics.asOf} (${metrics.horizonQuarters}Q, strategy ${metrics.strategyVersion})`);
      if (metrics.note) console.log(`Note: ${metrics.note}`);
      if (metrics.positions.length) {
        console.log(`\nPositions (${metrics.count}):`);
        for (const p of metrics.positions) {
          console.log(`  ${p.ticker}: ${p.entryPrice} (${p.entryDate}) -> ${p.exitPrice} (${p.exitDate}) = ${p.returnPct}%  [signal ${p.signalScore}]`);
        }
        console.log(
          `\nMean ${metrics.meanReturnPct}%  Median ${metrics.medianReturnPct}%  Win ${metrics.winRatePct}%  ` +
            `MaxDD ${metrics.maxDrawdownPct}%  Hit25 ${metrics.hitRate25Pct}%  Hit50 ${metrics.hitRate50Pct}%  Hit100 ${metrics.hitRate100Pct}%`,
        );
      }
      console.log(`\n${DISCLAIMER}`);
    });
  });

// --- export ---------------------------------------------------------------
program
  .command("export <ticker>")
  .description("Export the latest stored analysis for a ticker as JSON.")
  .action(async (ticker: string) => {
    await withApp(async ({ db }) => {
      const rs = await db.execute({
        sql: `SELECT output_json, provider, model, as_of, overall_score, confidence
              FROM analyses WHERE ticker = ? ORDER BY created_at DESC LIMIT 1`,
        args: [ticker.toUpperCase()],
      });
      if (rs.rows.length === 0) return console.log(`No stored analysis for ${ticker}.`);
      const row = rs.rows[0]!;
      console.log(
        JSON.stringify(
          {
            provider: row.provider,
            model: row.model,
            asOf: row.as_of,
            overallScore: row.overall_score,
            confidence: row.confidence,
            analysis: JSON.parse(String(row.output_json)),
            disclaimer: DISCLAIMER,
          },
          null,
          2,
        ),
      );
    });
  });

async function resolveCandidateTickers(
  db: ReturnType<typeof getDb>,
  topic: string,
  explicit: string | undefined,
  limit: number,
): Promise<string[]> {
  const fromOpt = parseList(explicit);
  if (fromOpt?.length) return fromOpt.slice(0, limit);
  // Otherwise derive from indexed transcript signals via FTS on the topic.
  try {
    const rs = await db.execute({
      sql: `SELECT DISTINCT ticker FROM segments_fts WHERE segments_fts MATCH ? LIMIT ?`,
      args: [topic, limit],
    });
    return rs.rows.map((r) => String(r.ticker)).filter(Boolean);
  } catch {
    return [];
  }
}

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
