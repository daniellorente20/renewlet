import { describe, expect, it } from "vitest";
import { canonicalizeMoneyString, formatMoneyWithCurrency, moneyStringSchema } from "./money";

describe("moneyStringSchema", () => {
  it("canonicalizes decimal strings at the shared write boundary", () => {
    expect(moneyStringSchema.parse("0012.340000")).toBe("12.34");
    expect(moneyStringSchema.parse("0.100000")).toBe("0.1");
    expect(canonicalizeMoneyString("1000000000.000000")).toBe("1000000000");
  });

  it("rejects non-canonicalizable money payloads", () => {
    expect(() => moneyStringSchema.parse(12)).toThrow();
    expect(() => moneyStringSchema.parse("1e3")).toThrow();
    expect(() => moneyStringSchema.parse(".5")).toThrow();
    expect(() => moneyStringSchema.parse("1.1234567")).toThrow();
    expect(() => moneyStringSchema.parse("1000000000.000001")).toThrow();
  });
});

describe("formatMoneyWithCurrency", () => {
  it("renders two decimals and the currency code on one line", () => {
    expect(formatMoneyWithCurrency("239.88", "EUR", "es-ES")).toBe("239,88 EUR");
    expect(formatMoneyWithCurrency("8.99", "EUR", "es-ES")).toBe("8,99 EUR");
  });

  it("pads whole amounts so a price note never reads '199 EUR'", () => {
    expect(formatMoneyWithCurrency("199", "EUR", "es-ES")).toBe("199,00 EUR");
    expect(formatMoneyWithCurrency("21", "EUR", "es-ES")).toBe("21,00 EUR");
  });

  it("never emits whitespace that a message template would reject", () => {
    for (const currency of ["EUR", "USD", "JPY"]) {
      const formatted = formatMoneyWithCurrency("1234.5", currency, "es-ES");
      expect(formatted).not.toMatch(/[\n\r\t]|\s{4,}| /);
      expect(formatted.trim()).toBe(formatted);
    }
  });
});
