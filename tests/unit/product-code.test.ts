import { describe, expect, it } from "vitest";
import { nextProductCode, productCodeLetters } from "@/lib/product-code";

describe("product codes made by the app (C71)", () => {
  it("take the first three letters of the name, in capitals, skipping anything that is not a letter", () => {
    expect(productCodeLetters("Tomato Seed Sachet")).toBe("TOM");
    expect(productCodeLetters("npk 15-15-15 fertilizer")).toBe("NPK");
    expect(productCodeLetters("2,4-D Amine")).toBe("DAM");
    expect(productCodeLetters("Égusi seed")).toBe("EGU");
    expect(productCodeLetters("5L")).toBe("LXX");
    expect(productCodeLetters("123")).toBe("XXX");
  });

  it("count upwards within those letters, whatever capitals the old codes used, and go past 999", () => {
    expect(nextProductCode("Tomato Seed Sachet", [])).toBe("TOM-001");
    expect(nextProductCode("Tomato Paste", ["TOM-001", "tom-007", "TOM-A", "TOMA-020", "HOE-099", null])).toBe("TOM-008");
    expect(nextProductCode("Tomato Paste", ["TOM-999"])).toBe("TOM-1000");
    // A code typed by hand in another style does not disturb the count.
    expect(nextProductCode("Hoe", ["H-1", "HOE1", "HOE-"])).toBe("HOE-001");
  });
});
