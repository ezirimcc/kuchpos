import { describe, expect, it } from "vitest";
import { addMonths, breakIntoUnits, dateToDay, dayToDate, receiptNumber } from "@/lib/format";

describe("calendar days", () => {
  it("accepts real dates and refuses impossible ones", () => {
    expect(dateToDay(dayToDate("2026-10-04")!)).toBe("2026-10-04");
    for (const bad of ["2026-02-30", "2026-13-01", "04/10/2026", "", "2026-1-5"]) {
      expect(dayToDate(bad), bad).toBeNull();
    }
  });

  it("adds months, keeping to the end of shorter months", () => {
    expect(addMonths("2026-10-04", 3)).toBe("2027-01-04");
    expect(addMonths("2026-11-30", 3)).toBe("2027-02-28");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2028-01-31", 1)).toBe("2028-02-29");
  });
});

describe("delivery numbers", () => {
  it("are padded to six digits", () => {
    expect(receiptNumber(12)).toBe("GR-000012");
    expect(receiptNumber(1234567)).toBe("GR-1234567");
  });
});

describe("breaking a base quantity into larger units", () => {
  const units = [
    { name: "single", factor: "1.000" },
    { name: "pack", factor: "10.000" },
    { name: "carton", factor: "100.000" },
  ];

  it("uses the largest units first", () => {
    expect(breakIntoUnits("215.000", "single", units)).toBe("2 carton + 1 pack + 5 single");
    expect(breakIntoUnits("200.000", "single", units)).toBe("2 carton");
    expect(breakIntoUnits("7.000", "single", units)).toBe("7 single");
    expect(breakIntoUnits("0.000", "single", units)).toBe("0 single");
  });

  it("keeps fractions in the base unit and ignores units smaller than the base", () => {
    const weighed = [
      { name: "kg", factor: "1.000" },
      { name: "bag", factor: "50.000" },
      { name: "sachet", factor: "0.250" },
    ];
    expect(breakIntoUnits("152.500", "kg", weighed)).toBe("3 bag + 2.5 kg");
  });
});
