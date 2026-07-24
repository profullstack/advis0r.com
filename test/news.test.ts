/**
 * News ingestion tests (PRD v3 §3).
 *
 * Covers the three things that decide whether news helps or hurts the ranking:
 * correct reputation tiering, correct date handling, and body extraction that
 * refuses to invent text when a publisher blocks us.
 */
import { describe, expect, test } from "bun:test";
import {
  isFetchBlocked,
  isIssuerOwnedHost,
  isPromotionalHost,
  normalizeHost,
  tierFor,
  tierLabel,
} from "../src/providers/news/tiers.ts";
import { parseNewsResults, resolveDate } from "../src/providers/news/valueserp.ts";
import { parseRss, googleNewsFeed, yahooTickerFeed } from "../src/providers/news/rss.ts";
import {
  extractArticleText,
  isAllowedByRobots,
  parseRobots,
} from "../src/providers/news/article.ts";
import { mentionsTicker } from "../src/providers/news/index.ts";
import {
  isMultiCompany,
  makeSubjectMentionTest,
  subjectTerms,
} from "../src/signals/subject.ts";
import { TIER_WEIGHTS, weightedIssuerCount } from "../src/evidence/builder.ts";

describe("source tiering", () => {
  test("primary sources are tier 0", () => {
    expect(tierFor("https://www.sec.gov/Archives/edgar/data/1/x.htm")).toBe(0);
    expect(tierFor("https://www.businesswire.com/news/home/123")).toBe(0);
    expect(tierFor("globenewswire.com")).toBe(0);
  });

  test("established press is tier 1", () => {
    expect(tierFor("https://apnews.com/article/x")).toBe(1);
    expect(tierFor("https://finance.yahoo.com/news/x.html")).toBe(1);
    expect(tierFor("https://www.reuters.com/x")).toBe(1);
  });

  test("opinion and analysis is tier 2", () => {
    expect(tierFor("https://www.fool.com/investing/x")).toBe(2);
    expect(tierFor("https://seekingalpha.com/article/x")).toBe(2);
  });

  test("aggregators and promo outlets are tier 3", () => {
    expect(tierFor("https://stocktwits.com/symbol/SOUN")).toBe(3);
    expect(tierFor("https://microcapdaily.com/x")).toBe(3);
  });

  test("unknown outlets default to tier 2 — context only, never a fact source", () => {
    expect(tierFor("https://some-blog-we-have-never-seen.example/post")).toBe(2);
  });

  test("subdomains inherit their parent's tier", () => {
    expect(tierFor("https://markets.cnbc.com/x")).toBe(1);
  });

  test("host normalization strips scheme, www and path", () => {
    expect(normalizeHost("https://www.Fool.com/investing/x")).toBe("fool.com");
    expect(normalizeHost("CNBC.com")).toBe("cnbc.com");
  });

  test("promotional hosts are identified for the risk signal", () => {
    expect(isPromotionalHost("https://microcapdaily.com/x")).toBe(true);
    expect(isPromotionalHost("https://apnews.com/x")).toBe(false);
  });

  test("publishers known to block us are flagged, not retried", () => {
    expect(isFetchBlocked("https://www.reuters.com/x")).toBe(true);
    expect(isFetchBlocked("https://apnews.com/x")).toBe(false);
  });

  test("tier labels are stable for UI", () => {
    expect(tierLabel(0)).toBe("primary");
    expect(tierLabel(3)).toBe("excluded");
  });

  test("an issuer's own domain is recognised", () => {
    expect(isIssuerOwnedHost("investors.soundhound.com", "SoundHound AI, Inc.")).toBe(true);
    expect(isIssuerOwnedHost("fool.com", "SoundHound AI, Inc.")).toBe(false);
  });
});

describe("tier-weighted corroboration", () => {
  test("tier 3 contributes nothing", () => {
    expect(TIER_WEIGHTS[3]).toBe(0);
    expect(weightedIssuerCount(new Map([["stocktwits.com", 3]]))).toBe(0);
  });

  test("primary sources outweigh opinion", () => {
    const primary = weightedIssuerCount(new Map([["sec.gov", 0]]));
    const opinion = weightedIssuerCount(new Map([["fool.com", 2]]));
    expect(primary).toBeGreaterThan(opinion);
  });

  test("ten opinion blogs do not equal three primary sources", () => {
    const blogs = new Map<string, number>();
    for (let i = 0; i < 10; i++) blogs.set(`blog${i}.example`, 2);
    const threePrimary = new Map([
      ["sec.gov", 0],
      ["businesswire.com", 0],
      ["apnews.com", 1],
    ]);
    expect(weightedIssuerCount(blogs)).toBeLessThan(weightedIssuerCount(threePrimary) + 0.01);
    expect(weightedIssuerCount(threePrimary)).toBe(2.75);
  });
});

describe("ValueSERP result parsing", () => {
  test("maps hits to tiered documents", () => {
    const body = {
      news_results: [
        { title: "A", link: "https://apnews.com/a", source: "AP News", date: "2 days ago" },
        { title: "B", link: "https://stocktwits.com/b", source: "Stocktwits", date: "1 day ago" },
      ],
    };
    const asOf = new Date("2026-07-24T00:00:00Z");
    const hits = parseNewsResults(body, asOf);
    expect(hits).toHaveLength(2);
    expect(hits[0]!.tier).toBe(1);
    expect(hits[0]!.publishedAt).toBe("2026-07-22");
    expect(hits[1]!.tier).toBe(3);
  });

  test("hits without a link are discarded", () => {
    expect(parseNewsResults({ news_results: [{ title: "x" }] }, new Date())).toHaveLength(0);
  });

  test("relative dates resolve against the anchor, not wall-clock", () => {
    const asOf = new Date("2026-07-24T00:00:00Z");
    expect(resolveDate("1 week ago", asOf)).toBe("2026-07-17");
    expect(resolveDate("3 hours ago", asOf)).toBe("2026-07-23");
  });

  test("absolute dates parse", () => {
    expect(resolveDate("Jul 14, 2026", new Date())).toBe("2026-07-14");
  });

  test("unparseable dates yield undefined rather than a wrong date", () => {
    expect(resolveDate("sometime recently", new Date())).toBeUndefined();
    expect(resolveDate(null, new Date())).toBeUndefined();
  });
});

describe("RSS parsing", () => {
  test("parses RSS items with source attribution", () => {
    const xml = `<rss><channel>
      <item>
        <title>D-Wave beats estimates</title>
        <link>https://finance.yahoo.com/news/dwave.html</link>
        <pubDate>Wed, 22 Jul 2026 13:00:00 GMT</pubDate>
        <source url="x">Yahoo Finance</source>
        <description><![CDATA[<p>Revenue rose sharply.</p>]]></description>
      </item>
    </channel></rss>`;
    const items = parseRss(xml);
    expect(items).toHaveLength(1);
    expect(items[0]!.url).toBe("https://finance.yahoo.com/news/dwave.html");
    expect(items[0]!.publishedAt).toBe("2026-07-22");
    expect(items[0]!.tier).toBe(1);
    expect(items[0]!.snippet).toBe("Revenue rose sharply.");
  });

  test("parses Atom entries with href links", () => {
    const xml = `<feed><entry>
      <title>Something happened</title>
      <link href="https://apnews.com/article/xyz"/>
      <published>2026-07-20T10:00:00Z</published>
    </entry></feed>`;
    const items = parseRss(xml);
    expect(items[0]!.url).toBe("https://apnews.com/article/xyz");
    expect(items[0]!.tier).toBe(1);
  });

  test("items without a usable link are skipped", () => {
    expect(parseRss("<rss><channel><item><title>no link</title></item></channel></rss>")).toHaveLength(0);
  });

  test("feed URLs are well-formed", () => {
    expect(yahooTickerFeed("QBTS")).toContain("s=QBTS");
    expect(googleNewsFeed("Vistra Corp", "7d")).toContain("when%3A7d");
  });
});

describe("article body extraction", () => {
  test("prefers publisher-declared JSON-LD articleBody", () => {
    const body = "Vistra reported record generation volumes for the quarter. ".repeat(12);
    const html = `<html><head><script type="application/ld+json">
      ${JSON.stringify({ "@type": "NewsArticle", headline: "x", articleBody: body })}
    </script></head><body><p>nav junk</p></body></html>`;
    expect(extractArticleText(html)).toContain("record generation volumes");
  });

  test("falls back to <article> paragraphs", () => {
    const para = "<p>" + "The company raised full-year guidance to a new range today. ".repeat(4) + "</p>";
    const html = `<html><body><nav><p>menu</p></nav><article>${para.repeat(3)}</article></body></html>`;
    const text = extractArticleText(html);
    expect(text).toContain("raised full-year guidance");
    expect(text).not.toContain("menu");
  });

  test("short navigation fragments are not mistaken for a body", () => {
    const html = "<html><body><p>Home</p><p>About</p><p>Contact</p></body></html>";
    expect(extractArticleText(html)).toBe("");
  });

  test("entities are decoded", () => {
    const para = "<p>" + "Q2 revenue &amp; margins rose; guidance was &quot;raised&quot; again this quarter. ".repeat(3) + "</p>";
    const text = extractArticleText(`<html><body><article>${para.repeat(3)}</article></body></html>`);
    expect(text).toContain("revenue & margins");
    expect(text).toContain('"raised"');
  });
});

describe("robots.txt handling", () => {
  test("wildcard disallow rules are applied", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /premium/\nCrawl-delay: 2");
    expect(rules.disallow).toContain("/premium/");
    expect(isAllowedByRobots(rules, "/premium/article")).toBe(false);
    expect(isAllowedByRobots(rules, "/news/article")).toBe(true);
  });

  test("rules for other agents are ignored", () => {
    const rules = parseRobots("User-agent: BadBot\nDisallow: /\n");
    expect(isAllowedByRobots(rules, "/anything")).toBe(true);
  });

  test("a site-wide disallow blocks everything", () => {
    const rules = parseRobots("User-agent: *\nDisallow: /");
    expect(isAllowedByRobots(rules, "/news")).toBe(false);
  });

  test("comments and blank lines are tolerated", () => {
    const rules = parseRobots("# comment\n\nUser-agent: *\nDisallow: /x/ # trailing\n");
    expect(rules.disallow).toEqual(["/x/"]);
  });
});

describe("wire headline matching", () => {
  test("matches on ticker symbol", () => {
    expect(mentionsTicker("VST announces Q2 results", "VST")).toBe(true);
  });

  test("matches on company name", () => {
    expect(mentionsTicker("Vistra reports record quarter", "VST", "Vistra Corp.")).toBe(true);
  });

  test("does not match unrelated headlines", () => {
    expect(mentionsTicker("Acme announces layoffs", "VST", "Vistra Corp.")).toBe(false);
  });
});

describe("multi-company subject guard (PRD §8.4)", () => {
  const known = new Set(["QBTS", "IONQ", "RGTI", "VST"]);

  test("a comparison article is detected as multi-company", () => {
    const text =
      "IONQ or QBTS: Which Quantum Stock Should You Buy Ahead of Q2 Earnings? Both names have run hard.";
    expect(isMultiCompany(text, "QBTS", known)).toBe(true);
  });

  test("a single-company article is not", () => {
    const text = "QBTS reported record bookings and raised full-year guidance this morning.";
    expect(isMultiCompany(text, "QBTS", known)).toBe(false);
  });

  test("common acronyms do not make a document look multi-company", () => {
    const text = "QBTS discussed its AI and GPU roadmap with the CEO and CFO, citing RPO and EBITDA.";
    expect(isMultiCompany(text, "QBTS", known)).toBe(false);
  });

  test("the guard blocks a rival's figures from being attributed to the subject", () => {
    // The exact production defect: IonQ's $470M RPO recorded as a QBTS signal.
    const mentions = makeSubjectMentionTest(subjectTerms("QBTS", "D-Wave Quantum Inc."));
    expect(
      mentions("IonQ also remains fundamentally strong, supported by a $470 million RPO."),
    ).toBe(false);
    expect(mentions("D-Wave reported remaining performance obligations of $42.4 million.")).toBe(true);
    expect(mentions("QBTS shares rose after the announcement.")).toBe(true);
  });

  test("subject terms include ticker, cleaned name and brand token", () => {
    const terms = subjectTerms("VST", "Vistra Corp.");
    expect(terms).toContain("VST");
    expect(terms.some((t) => t.toLowerCase().includes("vistra"))).toBe(true);
  });

  test("an empty term list never blocks (fails open, not silently empty)", () => {
    expect(makeSubjectMentionTest([])("anything")).toBe(true);
  });
});
