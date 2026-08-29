/**
 * Search-tab research tests: phrase/niche extraction, SERP parsing, and the
 * pasted-URL path.
 *
 * The three things worth pinning down are the three that would fail quietly:
 * a phrase list that reports one loud document as a trend, a SERP parser that
 * silently returns nothing when a field is renamed, and a URL guard that lets
 * an anonymous caller aim the server at a private address.
 */
import { describe, expect, test } from "bun:test";
import { deriveNiches, tokenize, topPhrases } from "../src/research/phrases.ts";
import {
  creditsFrom,
  newsHits,
  parseQuestions,
  parseRelatedSearches,
  webHits,
} from "../src/research/serp.ts";
import {
  assertFetchableUrl,
  extractPageMeta,
  extractTickerMentions,
  isPrivateAddress,
  looksLikeUrl,
  normalizeUrlInput,
  UnfetchableUrlError,
} from "../src/research/page.ts";

describe("phrase extraction", () => {
  test("tokenize drops numbers and punctuation but keeps hyphenated words", () => {
    expect(tokenize("Q3 2026: AI-infrastructure spend, up 40%!")).toEqual([
      "q3",
      "ai-infrastructure",
      "spend",
      "up",
    ]);
  });

  test("scores by document frequency, so one repetitive document is not a trend", () => {
    const shouty = "data centers data centers data centers data centers data centers";
    const others = ["quarterly guidance raised", "quarterly guidance raised again"];
    const phrases = topPhrases([shouty, ...others, "margin pressure"]);
    const dc = phrases.find((p) => p.phrase === "data centers");
    const guidance = phrases.find((p) => p.phrase === "quarterly guidance raised");
    // Five mentions inside one document still count once.
    expect(dc).toBeUndefined();
    expect(guidance?.count).toBe(2);
  });

  test("keeps the specific phrase and drops the generic one it contains", () => {
    const docs = [
      "ai infrastructure spending is up",
      "ai infrastructure spending accelerates",
      "ai infrastructure spending in 2026",
    ];
    const phrases = topPhrases(docs, { maxWords: 3 });
    expect(phrases[0]!.phrase).toBe("ai infrastructure spending");
    expect(phrases.map((p) => p.phrase)).not.toContain("ai");
    expect(phrases.map((p) => p.phrase)).not.toContain("infrastructure spending");
  });

  test("a phrase cannot begin or end on a stopword", () => {
    const docs = [
      "the future of solid state batteries",
      "the future of solid state batteries explained",
    ];
    for (const { phrase } of topPhrases(docs)) {
      expect(phrase.startsWith("the ")).toBe(false);
      expect(phrase.endsWith(" of")).toBe(false);
    }
  });

  test("a single document still yields phrases (minCount falls to 1)", () => {
    expect(topPhrases(["rivian delivery guidance for the fourth quarter"]).length).toBeGreaterThan(0);
  });

  test("empty input is empty output, not a crash", () => {
    expect(topPhrases([])).toEqual([]);
    expect(topPhrases(["", "   "])).toEqual([]);
  });
});

describe("niches", () => {
  const items = [
    { title: "Data center buildout accelerates", host: "reuters.com" },
    { title: "Inside the data center buildout", host: "cnbc.com" },
    { title: "Data center buildout hits power limits", host: "reuters.com" },
    { title: "A lone story about tractors", host: "example.com" },
  ];

  test("clusters results by the phrase they share and names the publishers", () => {
    const niches = deriveNiches(items);
    const cluster = niches.find((n) => n.label.includes("data center buildout"));
    expect(cluster?.count).toBe(3);
    expect(cluster?.hosts[0]).toBe("reuters.com"); // two of the three
    expect(cluster?.members).toEqual([0, 1, 2]);
  });

  test("a niche of one is not a niche", () => {
    expect(deriveNiches(items).some((n) => n.label.includes("tractors"))).toBe(false);
  });
});

describe("SERP parsing", () => {
  const body = {
    request_info: { success: true, credits_remaining: 24_113 },
    organic_results: [
      {
        position: 1,
        title: "Nvidia earnings beat",
        link: "https://www.reuters.com/tech/nvidia-earnings",
        domain: "reuters.com",
        snippet: "Revenue rose on data center demand.",
        date: "2 days ago",
      },
      { position: 2, title: "No link here" },
    ],
    related_searches: [{ query: "nvidia stock forecast" }, { q: "nvidia competitors" }],
    related_questions: [{ question: "Is Nvidia overvalued?", answer: "…" }],
  };

  test("organic results carry publisher, tier and a resolved date", () => {
    const asOf = new Date("2026-08-29T00:00:00Z");
    const hits = webHits(body, asOf);
    expect(hits).toHaveLength(1); // the row without a link is dropped
    expect(hits[0]!.host).toBe("reuters.com");
    expect(hits[0]!.tier).toBe(1);
    expect(hits[0]!.tierLabel).toBe("reputable press");
    expect(hits[0]!.publishedAt).toBe("2026-08-27");
  });

  test("related searches read both field spellings the API has used", () => {
    expect(parseRelatedSearches(body)).toEqual(["nvidia stock forecast", "nvidia competitors"]);
  });

  test("people-also-ask questions are extracted", () => {
    expect(parseQuestions(body)).toEqual(["Is Nvidia overvalued?"]);
  });

  test("credits are read off the response, so no extra account call is needed", () => {
    expect(creditsFrom(body)).toBe(24_113);
    expect(creditsFrom({})).toBeUndefined();
  });

  test("news results reuse the ingest parser and tier identically", () => {
    const hits = newsHits(
      { news_results: [{ title: "Promo alert", link: "https://stocktwits.com/x", source: "Stocktwits" }] },
      new Date(),
    );
    expect(hits[0]!.publisher).toBe("Stocktwits");
    expect(hits[0]!.tierLabel).toBe("excluded");
  });

  test("a response with no results is empty, not an exception", () => {
    expect(webHits({}, new Date())).toEqual([]);
    expect(parseRelatedSearches(null)).toEqual([]);
  });
});

describe("URL detection", () => {
  test("links are recognised with or without a scheme", () => {
    expect(looksLikeUrl("https://reuters.com/tech/story")).toBe(true);
    expect(looksLikeUrl("reuters.com/tech/story")).toBe(true);
    expect(looksLikeUrl("www.reuters.com")).toBe(true);
  });

  test("ordinary searches are not mistaken for links", () => {
    expect(looksLikeUrl("rivian earnings")).toBe(false);
    expect(looksLikeUrl("3.5")).toBe(false);
    expect(looksLikeUrl("")).toBe(false);
    // Other schemes are refused outright rather than parsed.
    expect(looksLikeUrl("javascript:alert(1)")).toBe(false);
    expect(looksLikeUrl("file:///etc/passwd")).toBe(false);
  });

  test("a missing scheme is filled in as https", () => {
    expect(normalizeUrlInput("reuters.com/x")).toBe("https://reuters.com/x");
    expect(normalizeUrlInput("http://reuters.com/x")).toBe("http://reuters.com/x");
  });
});

describe("SSRF guard", () => {
  test("private and reserved ranges are recognised", () => {
    for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.169.254",
                      "100.64.0.1", "0.0.0.0", "224.0.0.1"]) {
      expect(isPrivateAddress(ip, 4)).toBe(true);
    }
    for (const ip of ["8.8.8.8", "1.1.1.1", "104.18.32.7", "172.32.0.1"]) {
      expect(isPrivateAddress(ip, 4)).toBe(false);
    }
  });

  test("IPv6 loopback, unique-local, link-local and v4-mapped are recognised", () => {
    expect(isPrivateAddress("::1", 6)).toBe(true);
    expect(isPrivateAddress("fd00::1", 6)).toBe(true);
    expect(isPrivateAddress("fe80::1", 6)).toBe(true);
    expect(isPrivateAddress("::ffff:10.0.0.1", 6)).toBe(true);
    expect(isPrivateAddress("2606:4700::1111", 6)).toBe(false);
  });

  test("loopback and internal names are refused before any fetch", async () => {
    for (const target of [
      "http://localhost/admin",
      "http://foo.local/",
      "http://service.internal/",
      "http://127.0.0.1/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]/",
      "http://10.0.0.5/",
    ]) {
      expect(assertFetchableUrl(target)).rejects.toThrow(UnfetchableUrlError);
    }
  });

  test("non-web schemes and non-standard ports are refused", async () => {
    expect(assertFetchableUrl("ftp://example.com/x")).rejects.toThrow(/http and https/);
    expect(assertFetchableUrl("http://example.com:8080/x")).rejects.toThrow(/standard web ports/);
    expect(assertFetchableUrl("not a url at all")).rejects.toThrow(UnfetchableUrlError);
  });
});

describe("page metadata", () => {
  const html = `<!doctype html><html lang="en"><head>
    <title>Story — Section | The Publisher</title>
    <meta property="og:title" content="Nvidia&#39;s data center quarter" />
    <meta property="og:site_name" content="The Publisher" />
    <meta name="description" content="What the numbers showed." />
    <meta name="author" content="A Reporter" />
    <meta property="article:published_time" content="2026-08-20T11:00:00Z" />
    <meta name="keywords" content="nvidia, data centers, earnings" />
    <link rel="canonical" href="https://example.com/story" />
    <link rel="alternate" type="application/rss+xml" href="https://example.com/feed.xml" />
    <script type="application/ld+json">{"@type":"NewsArticle","author":{"name":"Ignored"}}</script>
    </head><body><h1>On-page headline</h1><h2>The buildout</h2></body></html>`;

  test("publisher-declared metadata beats the decorated title tag", () => {
    const meta = extractPageMeta(html);
    expect(meta.title).toBe("Nvidia's data center quarter");
    expect(meta.siteName).toBe("The Publisher");
    expect(meta.description).toBe("What the numbers showed.");
    expect(meta.author).toBe("A Reporter");
    expect(meta.publishedAt).toBe("2026-08-20T11:00:00.000Z");
    expect(meta.canonical).toBe("https://example.com/story");
    expect(meta.lang).toBe("en");
    expect(meta.keywords).toEqual(["nvidia", "data centers", "earnings"]);
    expect(meta.headings).toEqual(["On-page headline", "The buildout"]);
    expect(meta.feeds).toEqual(["https://example.com/feed.xml"]);
  });

  test("the title tag is the fallback when nothing is declared", () => {
    const meta = extractPageMeta("<html><head><title>Just a title</title></head><body></body></html>");
    expect(meta.title).toBe("Just a title");
    expect(meta.description).toBeUndefined();
    expect(meta.keywords).toEqual([]);
  });

  test("JSON-LD supplies the author when no meta tag does", () => {
    const meta = extractPageMeta(
      `<html><head><script type="application/ld+json">
         {"@graph":[{"@type":"NewsArticle","headline":"Graph headline","author":{"name":"LD Reporter"}}]}
       </script></head><body></body></html>`,
    );
    expect(meta.author).toBe("LD Reporter");
    expect(meta.title).toBe("Graph headline");
  });

  test("a malformed JSON-LD block does not lose the page", () => {
    const meta = extractPageMeta(
      `<html><head><title>Fine</title><script type="application/ld+json">{ not json </script></head><body></body></html>`,
    );
    expect(meta.title).toBe("Fine");
  });
});

describe("ticker mentions", () => {
  test("cashtags and exchange-qualified mentions are read", () => {
    const tickers = extractTickerMentions(
      "Shares of $NVDA rose after (NASDAQ: SOUN) reported. NYSE American: XYZ also moved. $BRK.B held.",
    );
    expect(tickers).toContain("NVDA");
    expect(tickers).toContain("SOUN");
    expect(tickers).toContain("XYZ");
    expect(tickers).toContain("BRK.B");
  });

  test("bare capitals are not tickers", () => {
    // The whole point: a confidently wrong ticker is worse than none.
    expect(extractTickerMentions("The CEO said AI and EV demand in the US was strong")).toEqual([]);
  });

  test("the most-repeated ticker leads", () => {
    expect(extractTickerMentions("$AAPL $MSFT $AAPL")[0]).toBe("AAPL");
  });
});
