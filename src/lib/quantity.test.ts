import { describe, expect, it } from "vitest";
import { Decimal } from "./decimal";
import {
  isWholeQuantity,
  parseQuantity,
  quantityToString,
  toBaseQuantity,
} from "./quantity";

describe("parseQuantity", () => {
  it("parses up to three decimal places exactly", () => {
    expect(quantityToString(parseQuantity("2.5"))).toBe("2.500");
    expect(quantityToString(parseQuantity("0.001"))).toBe("0.001");
    expect(quantityToString(parseQuantity("100"))).toBe("100.000");
  });

  it("rejects more than three decimal places instead of rounding", () => {
    expect(() => parseQuantity("2.3755")).toThrow(/more than 3 decimal places/);
  });

  it("rejects text that is not a number", () => {
    expect(() => parseQuantity("two")).toThrow();
  });
});

describe("toBaseQuantity", () => {
  it("converts cartons and packs to singles", () => {
    expect(quantityToString(toBaseQuantity(parseQuantity("2"), new Decimal("100")))).toBe("200.000");
    expect(quantityToString(toBaseQuantity(parseQuantity("3"), new Decimal("10")))).toBe("30.000");
  });

  it("converts 50 kg bags to kilograms", () => {
    expect(quantityToString(toBaseQuantity(parseQuantity("3"), new Decimal("50")))).toBe("150.000");
  });

  it("converts units smaller than the base unit exactly (0.25 kg sachet)", () => {
    expect(quantityToString(toBaseQuantity(parseQuantity("3"), new Decimal("0.25")))).toBe("0.750");
  });

  it("keeps a weighed sale in the base unit unchanged", () => {
    expect(quantityToString(toBaseQuantity(parseQuantity("2.5"), new Decimal("1")))).toBe("2.500");
  });

  it("refuses a result that cannot be held to three decimal places", () => {
    expect(() => toBaseQuantity(parseQuantity("0.5"), new Decimal("0.125"))).toThrow(/exactly/);
  });

  it("refuses a zero or negative conversion", () => {
    expect(() => toBaseQuantity(parseQuantity("1"), new Decimal("0"))).toThrow();
    expect(() => toBaseQuantity(parseQuantity("1"), new Decimal("-10"))).toThrow();
  });
});

describe("isWholeQuantity", () => {
  it("tells whole quantities from fractional ones", () => {
    expect(isWholeQuantity(parseQuantity("3"))).toBe(true);
    expect(isWholeQuantity(parseQuantity("3.000"))).toBe(true);
    expect(isWholeQuantity(parseQuantity("2.5"))).toBe(false);
  });
});
