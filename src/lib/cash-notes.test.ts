import { describe, expect, it } from "vitest";
import { breakdownTotal, describeBreakdown, storeBreakdown } from "./cash-notes";

describe("counting cash by notes", () => {
  it("adds the notes and the loose amount exactly", () => {
    expect(breakdownTotal({ notes: { "1000": "60", "500": "1", "20": "4" }, other: "20" })?.toFixed(2)).toBe("60600.00");
    expect(breakdownTotal({ notes: { "5": "3" }, other: "0.50" })?.toFixed(2)).toBe("15.50");
    expect(breakdownTotal({ notes: {}, other: "" })?.toFixed(2)).toBe("0.00");
  });

  it("gives no total when a count is not a whole number or the loose amount is not money", () => {
    for (const count of ["four", "1.5", "-2", "1e3"]) {
      expect(breakdownTotal({ notes: { "100": count }, other: "" }), count).toBeNull();
    }
    for (const other of ["a lot", "1,000", "10.005", "-5"]) {
      expect(breakdownTotal({ notes: {}, other }), other).toBeNull();
    }
  });

  it("stores only what was counted, and describes it for reading, largest note first", () => {
    const stored = storeBreakdown({ notes: { "20": " 4 ", "1000": "060", "500": "0", "10": "" }, other: "20" });
    // (JSON lists number-like names in rising order; reading it back puts the largest note first.)
    expect(stored).toBe('{"notes":{"20":"4","1000":"60"},"other":"20.00"}');
    expect(describeBreakdown(stored)).toEqual(["60 × ₦1,000", "4 × ₦20", "Coins / other ₦20.00"]);
    expect(describeBreakdown(null)).toEqual([]);
    expect(describeBreakdown("not json")).toEqual([]);
  });
});
