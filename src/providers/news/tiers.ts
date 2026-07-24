/**
 * Source reputation tiering (PRD v3 §3.3).
 *
 * "Reputable" has to be an operational decision made at ingest, not a vibe:
 * a single news query returns primary wire copy, licensed syndication, paid
 * opinion and a promo aggregator side by side. Tier decides evidentiary weight
 * and whether a document may source facts at all.
 *
 *   0 — Primary: SEC, company IR, company-owned channels, newswires.
 *   1 — Reputable press: wire services and established financial press.
 *   2 — Analysis/opinion: may inform sentiment, never sources a fact.
 *   3 — Excluded/adverse: aggregators, paid-IR, stock-promotion outlets.
 *
 * Pure and deterministic — no network, no LLM.
 */
import type { SourceTier } from "../../types.ts";

/** Hosts whose content is a primary record (issuer or regulator speaking). */
const TIER0: string[] = [
  "sec.gov",
  "businesswire.com",
  "globenewswire.com",
  "prnewswire.com",
  "newsfilecorp.com",
  "accesswire.com",
  "einpresswire.com",
  "nasdaq.com", // company press-release mirrors
  "otcmarkets.com",
];

/** Established financial press. */
const TIER1: string[] = [
  "reuters.com",
  "apnews.com",
  "bloomberg.com",
  "wsj.com",
  "ft.com",
  "cnbc.com",
  "barrons.com",
  "marketwatch.com",
  "finance.yahoo.com",
  "yahoo.com",
  "forbes.com",
  "economist.com",
  "axios.com",
  "theinformation.com",
  "nytimes.com",
  "washingtonpost.com",
  "businessinsider.com",
  "investors.com",
  "morningstar.com",
  "spglobal.com",
  "theregister.com",
  "arstechnica.com",
  "techcrunch.com",
];

/** Analysis and opinion — useful as attention/sentiment, never as fact. */
const TIER2: string[] = [
  "fool.com",
  "seekingalpha.com",
  "benzinga.com",
  "zacks.com",
  "simplywall.st",
  "investorplace.com",
  "thestreet.com",
  "24/7wallst.com",
  "247wallst.com",
  "gurufocus.com",
  "tipranks.com",
  "insidermonkey.com",
  "kiplinger.com",
];

/**
 * Excluded. Aggregators with no editorial layer, message boards, and the paid-
 * promotion ecosystem that targets exactly the microcap universe this tool
 * screens. Presence here is itself a risk signal (PRD v3 §3.5).
 */
const TIER3: string[] = [
  "stocktwits.com",
  "reddit.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "stockhouse.com",
  "investorshub.advfn.com",
  "ihub.advfn.com",
  "pennystocks.com",
  "otcdynamics.com",
  "stockwire.com",
  "smallcapvoice.com",
  "stocktargetadvisor.com",
  "wallstreetpr.com",
  "microcapdaily.com",
  "goldstocknews.com",
];

/** Hosts in TIER3 that specifically indicate paid promotion, not just noise. */
const PROMOTIONAL: string[] = [
  "pennystocks.com",
  "otcdynamics.com",
  "stockwire.com",
  "smallcapvoice.com",
  "wallstreetpr.com",
  "microcapdaily.com",
  "goldstocknews.com",
  "stocktargetadvisor.com",
];

const TABLE: [string[], SourceTier][] = [
  [TIER0, 0],
  [TIER1, 1],
  [TIER2, 2],
  [TIER3, 3],
];

/** Normalize a URL or bare hostname to a comparable host. */
export function normalizeHost(urlOrHost: string): string {
  let host = urlOrHost.trim().toLowerCase();
  if (host.includes("://")) {
    try {
      host = new URL(host).host;
    } catch {
      /* fall through to string handling */
    }
  }
  host = host.replace(/^www\./, "").replace(/\/.*$/, "");
  return host;
}

/**
 * Tier for a URL or host. Unknown outlets default to tier 2 (analysis): they
 * may contribute attention/sentiment context but can never source a fact, which
 * is the safe default for something we have not vetted.
 */
export function tierFor(urlOrHost: string, fallback: SourceTier = 2): SourceTier {
  const host = normalizeHost(urlOrHost);
  if (!host) return fallback;
  for (const [list, tier] of TABLE) {
    for (const entry of list) {
      if (host === entry || host.endsWith(`.${entry}`)) return tier;
    }
  }
  return fallback;
}

/** True when the host belongs to the paid-promotion ecosystem (PRD v3 §3.5). */
export function isPromotionalHost(urlOrHost: string): boolean {
  const host = normalizeHost(urlOrHost);
  return PROMOTIONAL.some((p) => host === p || host.endsWith(`.${p}`));
}

/**
 * Publishers known to block automated fetching. We keep the headline+snippet
 * from search and never attempt to route around the block (PRD v3 §3.7).
 */
const FETCH_BLOCKED: string[] = ["reuters.com", "bloomberg.com", "wsj.com", "ft.com"];

export function isFetchBlocked(urlOrHost: string): boolean {
  const host = normalizeHost(urlOrHost);
  return FETCH_BLOCKED.some((p) => host === p || host.endsWith(`.${p}`));
}

/** Human-readable tier label for UI and reports. */
export function tierLabel(tier: SourceTier): string {
  return (
    { 0: "primary", 1: "reputable press", 2: "analysis/opinion", 3: "excluded" } as const
  )[tier];
}

/**
 * A company's own IR/newsroom host counts as primary for that issuer.
 *
 * Compares the *registrable domain* rather than the full host, so investor
 * subdomains (`investors.example.com`) still match, and tolerates the company
 * name carrying extra tokens the domain omits ("SoundHound AI" vs soundhound.com).
 */
export function isIssuerOwnedHost(host: string, companyName?: string): boolean {
  if (!companyName) return false;
  const labels = normalizeHost(host).split(".").filter(Boolean);
  // Second-level label: "investors.soundhound.com" -> "soundhound".
  const sld = (labels.length >= 2 ? labels[labels.length - 2]! : labels[0] ?? "").replace(
    /[^a-z]/g,
    "",
  );
  if (sld.length < 4) return false;

  const slug = companyName
    .toLowerCase()
    .replace(
      /\b(inc|corp|corporation|company|co|ltd|plc|holdings|group|technologies|technology)\b/g,
      "",
    )
    .replace(/[^a-z]/g, "");
  if (slug.length < 4) return false;
  return slug.includes(sld) || sld.includes(slug);
}
