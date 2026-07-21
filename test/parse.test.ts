import { describe, expect, test } from "bun:test";
import { parseAbbrevNumber, parseList } from "../src/util/parse.ts";

describe("parse", () => {
  test("parseAbbrevNumber handles k/m/b/t suffixes", () => {
    expect(parseAbbrevNumber("25m")).toBe(25_000_000);
    expect(parseAbbrevNumber("5b")).toBe(5_000_000_000);
    expect(parseAbbrevNumber("250000")).toBe(250_000);
    expect(parseAbbrevNumber("0.5")).toBe(0.5);
    expect(parseAbbrevNumber(undefined)).toBeUndefined();
  });

  test("parseList splits and uppercases", () => {
    expect(parseList("nasdaq,nyse,amex")).toEqual(["NASDAQ", "NYSE", "AMEX"]);
    expect(parseList(undefined)).toBeUndefined();
  });
});
