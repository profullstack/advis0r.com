/**
 * Boilerplate classifier tests (PRD v3 §4.1).
 *
 * The "should be suppressed" cases are verbatim quotes pulled from the
 * production signals table on 2026-07-24 — each one had been stored as a real
 * executive signal. The "should survive" cases guard against the filter eating
 * genuine claims, which is the failure mode that actually matters.
 */
import { describe, expect, test } from "bun:test";
import {
  classifySentence,
  normalizeForFingerprint,
  shingles,
} from "../src/signals/boilerplate.ts";
import { makeRepeatTest } from "../src/signals/corpus.ts";

const suppress = (sentence: string, ctx: Partial<Parameters<typeof classifySentence>[0]> = {}) =>
  classifySentence({ sentence, ...ctx });

describe("boilerplate: real production false positives", () => {
  test("safe-harbor paragraph (was a DGX 'litigation' signal)", () => {
    const v = suppress(
      "Risks and uncertainties that may affect the future results of the company include, but are not limited to, uncertain and volatile economic conditions, adverse results from pending or future government investigations and lawsuits.",
    );
    expect(v.isBoilerplate).toBe(true);
    expect(v.reasons).toContain("disclaimer_marker");
  });

  test("forward-looking disclaimer (was an NGTF 'cashflow_improvement' signal)", () => {
    const v = suppress(
      "Among the factors that could cause actual results to differ materially are the parties' ability to negotiate and execute definitive agreements, complete satisfactory due diligence, obtain required approvals.",
    );
    expect(v.isBoilerplate).toBe(true);
  });

  test("exhibit index row (was a PRLB 'material_weakness' signal)", () => {
    const v = suppress(
      "81 Table of Contents 10.31# Form of Restricted Stock Unit Agreement Grant Notice under the Amended and Restated 2022 Long-Term Incentive Plan (Non-employee Director) (incorporated by reference to Exhibit 10.2).",
    );
    expect(v.isBoilerplate).toBe(true);
    expect(v.reasons).toContain("structural_noise");
  });

  test("non-GAAP definition footnote (was a TASK 'litigation' signal)", () => {
    const v = suppress(
      "Adjusted Free Cash Flow is a non-GAAP liquidity measure that represents Free Cash Flow before the payments for transaction costs, operational efficiency costs and certain litigation costs.",
    );
    expect(v.isBoilerplate).toBe(true);
  });

  test("risk-factor hypothetical (was an IRMD 'litigation' signal)", () => {
    const v = suppress(
      "Our stock could be subject to wide fluctuations in price in response to various factors, including sales of large blocks of our stock or lack of liquidity in the public trading market.",
    );
    expect(v.isBoilerplate).toBe(true);
    expect(v.hedged).toBe(true);
  });
});

describe("boilerplate: genuine claims must survive", () => {
  test("raised guidance with a figure", () => {
    const v = suppress(
      "We are raising our full-year guidance to a range of $210 million to $215 million based on the strength we saw in the third quarter.",
    );
    expect(v.isBoilerplate).toBe(false);
    expect(v.hedged).toBe(false);
  });

  test("reported backlog growth", () => {
    const v = suppress("Backlog grew 47% year over year to a record $1.2 billion.");
    expect(v.isBoilerplate).toBe(false);
  });

  test("assertive numeric guidance survives conditional phrasing", () => {
    // Contains "we expect ... may", but is a real forward guidance claim.
    const v = suppress(
      "We expect revenue of approximately $50 million next quarter, and we signed 12 new enterprise customers in the period.",
    );
    expect(v.isBoilerplate).toBe(false);
  });

  test("a genuine, specific legal event is not boilerplate", () => {
    const v = suppress(
      "On March 3, 2026 the company settled the class action lawsuit for $14.5 million, which we paid in full during the quarter.",
    );
    expect(v.isBoilerplate).toBe(false);
  });
});

describe("boilerplate: disclaimer section propagation", () => {
  test("marker in an adjacent sentence disqualifies the match", () => {
    const v = suppress("Litigation costs increased during the period.", {
      contextBefore:
        "This press release contains forward-looking statements within the meaning of the Private Securities Litigation Reform Act.",
    });
    expect(v.isBoilerplate).toBe(true);
    expect(v.reasons).toContain("disclaimer_marker");
  });

  test("caller-tracked section state suppresses following sentences", () => {
    const v = suppress("These factors include competition and regulatory change.", {
      inDisclaimerSection: true,
    });
    expect(v.isBoilerplate).toBe(true);
    expect(v.reasons).toContain("disclaimer_section");
  });

  test("a disclaimer heading is reported so the caller can open a run", () => {
    const v = suppress(
      "Forward-Looking Statements: this document contains certain statements.",
    );
    expect(v.opensDisclaimerSection).toBe(true);
  });
});

describe("fingerprinting and corpus repetition", () => {
  test("normalization strips figures and punctuation so filers collapse together", () => {
    const a = normalizeForFingerprint("Revenue grew 47% to $1,200,000 in 2026.");
    const b = normalizeForFingerprint("Revenue grew 12% to $9,900,000 in 2025.");
    expect(a).toBe(b);
  });

  test("shingles are overlapping and order-preserving", () => {
    const s = shingles("alpha bravo charlie delta echo foxtrot golf hotel india", 8);
    expect(s.length).toBe(2);
    expect(s[0]).toBe("alpha bravo charlie delta echo foxtrot golf hotel");
  });

  test("short sentences still produce one fingerprint", () => {
    expect(shingles("too short", 8)).toEqual(["too short"]);
  });

  test("repeat test flags a sentence whose language is corpus-wide", () => {
    const sentence =
      "The company undertakes no obligation to update any forward looking statement whether as a result of new information";
    const set = new Set(shingles(sentence));
    const isRepeated = makeRepeatTest(set);
    expect(isRepeated(sentence)).toBe(true);
  });

  test("repeat test ignores a sentence that merely shares a phrase", () => {
    const boiler = new Set(shingles("the company undertakes no obligation to update any forward looking"));
    const isRepeated = makeRepeatTest(boiler);
    expect(
      isRepeated(
        "We signed a definitive agreement with Acme Corp to supply 400 megawatts of capacity beginning in the fourth quarter of next year across three separate facilities.",
      ),
    ).toBe(false);
  });

  test("an empty corpus model never flags anything", () => {
    const isRepeated = makeRepeatTest(new Set());
    expect(isRepeated("anything at all goes here")).toBe(false);
  });
});
