/**
 * Corroboration engine tests (PRD v3 §3.4, §3.5).
 *
 * The matcher decides what counts as independent confirmation, so the tests
 * that matter most are the negative ones: generic language must not match, and
 * amplification must never be mistaken for confirmation.
 */
import { describe, expect, test } from "bun:test";
import {
  CONTEMPORANEOUS_DAYS,
  WINDOW_AFTER_DAYS,
  dayDiff,
  distinctiveTerms,
  lagWeight,
  overlapRatio,
  tierWeight,
} from "../src/corroborate/engine.ts";

describe("distinctive terms", () => {
  test("keeps content words and figures, drops stopwords", () => {
    const terms = distinctiveTerms(
      "The company signed a $12.5 million agreement with Vistra for 400 megawatts.",
    );
    expect(terms.has("signed")).toBe(true);
    expect(terms.has("vistra")).toBe(true);
    expect(terms.has("megawatts")).toBe(true);
    expect(terms.has("12.5")).toBe(true);
    expect(terms.has("the")).toBe(false);
    // "company" and "million" are boilerplate-frequent and deliberately dropped.
    expect(terms.has("company")).toBe(false);
    expect(terms.has("million")).toBe(false);
  });

  test("a purely generic sentence yields few terms", () => {
    // Guards the `terms.size < 4` bail-out that stops vague claims matching.
    expect(distinctiveTerms("This was a good year for us.").size).toBeLessThan(4);
  });
});

describe("overlap matching", () => {
  const claim = distinctiveTerms(
    "D-Wave announced the Advantage2 system deployment at its Boca Raton development hub.",
  );

  test("an article describing the same event matches strongly", () => {
    const article =
      "D-Wave confirmed that its Advantage2 system deployment will anchor the new Boca Raton development hub announced this week.";
    expect(overlapRatio(claim, article)).toBeGreaterThan(0.6);
  });

  test("an unrelated article about the same ticker does not match", () => {
    const article =
      "Shares closed lower on Tuesday amid broad weakness across technology indices and profit taking.";
    expect(overlapRatio(claim, article)).toBeLessThan(0.2);
  });

  test("an empty claim never matches", () => {
    expect(overlapRatio(new Set<string>(), "anything")).toBe(0);
  });
});

describe("confidence weighting", () => {
  test("tier weight falls off and excludes tier 3 entirely", () => {
    expect(tierWeight(0)).toBe(1);
    expect(tierWeight(1)).toBeLessThan(tierWeight(0));
    expect(tierWeight(2)).toBeLessThan(tierWeight(1));
    expect(tierWeight(3)).toBe(0);
  });

  test("contemporaneous confirmation is undecayed", () => {
    expect(lagWeight(0)).toBe(1);
    expect(lagWeight(CONTEMPORANEOUS_DAYS)).toBe(1);
  });

  test("late confirmation decays but never to zero", () => {
    const near = lagWeight(30);
    const far = lagWeight(WINDOW_AFTER_DAYS);
    expect(near).toBeLessThan(1);
    expect(far).toBeLessThan(near);
    expect(far).toBeGreaterThan(0);
  });

  test("decay is symmetric — coverage just before a filing still corroborates", () => {
    expect(lagWeight(-30)).toBe(lagWeight(30));
  });
});

describe("date arithmetic", () => {
  test("computes whole-day lag", () => {
    expect(dayDiff("2026-07-01", "2026-07-08")).toBe(7);
    expect(dayDiff("2026-07-08", "2026-07-01")).toBe(-7);
  });

  test("unusable dates yield undefined rather than a bogus lag", () => {
    expect(dayDiff("", "2026-07-01")).toBeUndefined();
    expect(dayDiff("2026-07-01", "not a date")).toBeUndefined();
  });
});
