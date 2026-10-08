import { describe, expect, it } from "vitest";
import { Decimal } from "./decimal";
import {
  formatNaira,
  lineTotal,
  moneyToString,
  parseMoney,
  roundMoney,
  sumMoney,
  taxIncludedIn,
} from "./money";

describe("parseMoney", () => {
  it("parses whole Naira and kobo exactly", () => {
    expect(moneyToString(parseMoney("1250"))).toBe("1250.00");
    expect(moneyToString(parseMoney("1250.5"))).toBe("1250.50");
    expect(moneyToString(parseMoney("0.01"))).toBe("0.01");
  });

  it("rejects more than two decimal places instead of rounding", () => {
    expect(() => parseMoney("10.005")).toThrow(/more than 2 decimal places/);
  });

  it("rejects anything that is not plain decimal text", () => {
    for (const bad of ["", "abc", "1,250", "1e3", "₦100", "10.", ".5", "NaN", "Infinity"]) {
      expect(() => parseMoney(bad), bad).toThrow();
    }
  });

  it("rejects JavaScript numbers", () => {
    expect(() => parseMoney(12.5 as unknown as string)).toThrow(/as text/);
  });
});

describe("roundMoney", () => {
  it("rounds half a kobo up", () => {
    expect(moneyToString(roundMoney(new Decimal("1.005")))).toBe("1.01");
    expect(moneyToString(roundMoney(new Decimal("2.675")))).toBe("2.68");
    expect(moneyToString(roundMoney(new Decimal("0.125")))).toBe("0.13");
  });

  it("rounds below half a kobo down", () => {
    expect(moneyToString(roundMoney(new Decimal("1.0049")))).toBe("1.00");
  });

  it("rounds half away from zero for negative amounts", () => {
    expect(moneyToString(roundMoney(new Decimal("-1.005")))).toBe("-1.01");
  });
});

describe("exactness", () => {
  it("adds 0.10 and 0.20 to exactly 0.30", () => {
    const total = sumMoney([parseMoney("0.10"), parseMoney("0.20")]);
    expect(moneyToString(total)).toBe("0.30");
  });

  it("stays exact when a small amount is added many times", () => {
    const kobo = parseMoney("0.01");
    const total = sumMoney(Array.from({ length: 100_000 }, () => kobo));
    expect(moneyToString(total)).toBe("1000.00");
  });
});

describe("lineTotal", () => {
  it("multiplies a weighed quantity by a price and rounds to the kobo", () => {
    // 2.375 kg × ₦1,333.00 = ₦3,165.875 → ₦3,165.88
    expect(moneyToString(lineTotal(new Decimal("2.375"), parseMoney("1333")))).toBe("3165.88");
  });

  it("handles whole quantities", () => {
    expect(moneyToString(lineTotal(new Decimal("3"), parseMoney("1250.50")))).toBe("3751.50");
  });
});

describe("taxIncludedIn", () => {
  it("is zero at a 0% rate", () => {
    expect(moneyToString(taxIncludedIn(parseMoney("1075"), new Decimal("0")))).toBe("0.00");
  });

  it("finds ₦75.00 tax inside ₦1,075.00 at 7.5%", () => {
    expect(moneyToString(taxIncludedIn(parseMoney("1075"), new Decimal("7.5")))).toBe("75.00");
  });

  it("rounds the tax to the kobo", () => {
    // 1000 × 7.5 ÷ 107.5 = 69.767… → 69.77
    expect(moneyToString(taxIncludedIn(parseMoney("1000"), new Decimal("7.5")))).toBe("69.77");
  });

  it("rejects a negative rate", () => {
    expect(() => taxIncludedIn(parseMoney("100"), new Decimal("-1"))).toThrow();
  });
});

describe("formatNaira", () => {
  it("shows the Naira sign, thousands separators and kobo", () => {
    expect(formatNaira(parseMoney("1250.5"))).toBe("₦1,250.50");
    expect(formatNaira(parseMoney("1234567.89"))).toBe("₦1,234,567.89");
    expect(formatNaira(parseMoney("0"))).toBe("₦0.00");
    expect(formatNaira(parseMoney("999"))).toBe("₦999.00");
  });

  it("shows negative amounts with a leading minus", () => {
    expect(formatNaira(parseMoney("-2500"))).toBe("-₦2,500.00");
  });
});

describe("movingAverageCost", () => {
  const d = (value: string) => new Decimal(value);

  it("is the delivery's own cost per base unit when there was no stock", async () => {
    const { movingAverageCost } = await import("./money");
    const average = movingAverageCost({ quantityBefore: d("0"), averageBefore: d("0"), quantityAdded: d("100"), costAdded: d("5000") });
    expect(average.toFixed(4)).toBe("50.0000");
  });

  it("gives exactly 60 after 100 at 50 then 100 at 70", async () => {
    const { movingAverageCost } = await import("./money");
    const average = movingAverageCost({ quantityBefore: d("100"), averageBefore: d("50"), quantityAdded: d("100"), costAdded: d("7000") });
    expect(average.toFixed(4)).toBe("60.0000");
  });

  it("weights by quantity and rounds half-up to four decimal places", async () => {
    const { movingAverageCost } = await import("./money");
    // (3 × 10 + 20) ÷ (3 + 3) = 8.3333…
    const average = movingAverageCost({ quantityBefore: d("3"), averageBefore: d("10"), quantityAdded: d("3"), costAdded: d("20") });
    expect(average.toFixed(4)).toBe("8.3333");
    // 1 ÷ 3 × … a value ending in exactly 5 at the fifth place rounds up: 0.00005 → 0.0001
    expect(movingAverageCost({ quantityBefore: d("0"), averageBefore: d("0"), quantityAdded: d("20000"), costAdded: d("1") }).toFixed(4)).toBe("0.0001");
  });

  it("handles weighed goods: 2.5 kg costing 1,000 into 7.5 kg at 380", async () => {
    const { movingAverageCost } = await import("./money");
    const average = movingAverageCost({ quantityBefore: d("7.5"), averageBefore: d("380"), quantityAdded: d("2.5"), costAdded: d("1000") });
    expect(average.toFixed(4)).toBe("385.0000");
  });
});

describe("correctedAverageCost", () => {
  const d = (value: string) => new Decimal(value);
  const corrected = async (input: Record<"quantityNow" | "averageNow" | "oldQuantity" | "oldCost" | "newQuantity" | "newCost", string>) => {
    const { correctedAverageCost } = await import("./money");
    return correctedAverageCost({
      quantityNow: d(input.quantityNow),
      averageNow: d(input.averageNow),
      oldQuantity: d(input.oldQuantity),
      oldCost: d(input.oldCost),
      newQuantity: d(input.newQuantity),
      newCost: d(input.newCost),
    }).toFixed(4);
  };

  it("gives the average the right delivery would have given, when nothing has left yet", async () => {
    // 100 at 50 already there, then 100 entered at 70 (average 60) that should have been 100 at 90.
    expect(await corrected({ quantityNow: "200", averageNow: "60", oldQuantity: "100", oldCost: "7000", newQuantity: "100", newCost: "9000" })).toBe("70.0000");
  });

  it("keeps the average when only the quantity was wrong", async () => {
    expect(await corrected({ quantityNow: "100", averageNow: "50", oldQuantity: "100", oldCost: "5000", newQuantity: "80", newCost: "4000" })).toBe("50.0000");
    expect(await corrected({ quantityNow: "100", averageNow: "50", oldQuantity: "100", oldCost: "5000", newQuantity: "130", newCost: "6500" })).toBe("50.0000");
  });

  it("re-prices only what can still be in stock when most of the delivery has gone", async () => {
    // 100 entered at 50, 90 since left, cost should have been 60: the 10 left are worth 60 each, not 150.
    expect(await corrected({ quantityNow: "10", averageNow: "50", oldQuantity: "100", oldCost: "5000", newQuantity: "100", newCost: "6000" })).toBe("60.0000");
  });

  it("works for a product added by the correction and for one removed by it", async () => {
    expect(await corrected({ quantityNow: "0", averageNow: "0", oldQuantity: "0", oldCost: "0", newQuantity: "10", newCost: "500" })).toBe("50.0000");
    // 100 at 50 plus a wrong line of 100 at 70 (average 60); removing the wrong line gives 50 again.
    expect(await corrected({ quantityNow: "200", averageNow: "60", oldQuantity: "100", oldCost: "7000", newQuantity: "0", newCost: "0" })).toBe("50.0000");
  });

  it("leaves the average alone when no stock is left, and never goes below zero", async () => {
    expect(await corrected({ quantityNow: "10", averageNow: "50", oldQuantity: "10", oldCost: "500", newQuantity: "0", newCost: "0" })).toBe("50.0000");
    expect(await corrected({ quantityNow: "20", averageNow: "1", oldQuantity: "10", oldCost: "5000", newQuantity: "0", newCost: "0" })).toBe("0.0000");
  });
});

describe("shareDiscount", () => {
  const shares = async (totals: string[], discount: string) => {
    const { shareDiscount } = await import("./money");
    return shareDiscount(totals.map((total) => new Decimal(total)), new Decimal(discount)).map((share) => share.toFixed(2));
  };

  it("shares a discount in proportion to each line, and the shares add up exactly", async () => {
    expect(await shares(["6000", "4000"], "500")).toEqual(["300.00", "200.00"]);
    // ₦100 over three equal lines: 33.33 + 33.33 + 33.34.
    expect(await shares(["1000", "1000", "1000"], "100")).toEqual(["33.33", "33.33", "33.34"]);
    expect(await shares(["42000", "1500"], "0.01")).toEqual(["0.01", "0.00"]);
    expect(await shares(["999.99", "0.01"], "1000")).toEqual(["999.99", "0.01"]);
  });

  it("gives nothing to a line of zero, never more than a line's own total, and nothing at all for no discount", async () => {
    expect(await shares(["500", "0", "500"], "100")).toEqual(["50.00", "0.00", "50.00"]);
    expect(await shares(["500", "500", "0"], "1000")).toEqual(["500.00", "500.00", "0.00"]);
    expect(await shares(["300", "700"], "0")).toEqual(["0.00", "0.00"]);
  });

  it("refuses a discount that is negative or more than the lines", async () => {
    await expect(shares(["100"], "100.01")).rejects.toThrow();
    await expect(shares(["100"], "-1")).rejects.toThrow();
  });

  it("percentOf rounds to the kobo", async () => {
    const { percentOf } = await import("./money");
    expect(percentOf(new Decimal("10000"), new Decimal("5")).toFixed(2)).toBe("500.00");
    expect(percentOf(new Decimal("3126.25"), new Decimal("7.5")).toFixed(2)).toBe("234.47");
  });
});
