import { describe, expect, it } from "vitest";
import { csvCell, toCsv } from "./csv";

describe("csv", () => {
  it("quotes commas, quotes and line breaks", () => {
    expect(csvCell("Okafor, Ada")).toBe('"Okafor, Ada"');
    expect(csvCell('5" pipe')).toBe('"5"" pipe"');
    expect(csvCell("two\nlines")).toBe('"two\nlines"');
    expect(csvCell("plain")).toBe("plain");
    expect(csvCell(null)).toBe("");
    expect(csvCell(12)).toBe("12");
  });

  it("never lets a cell be run as a formula, but leaves numbers alone", () => {
    expect(csvCell("=HYPERLINK(\"http://x\")")).toBe("\"'=HYPERLINK(\"\"http://x\"\")\"");
    expect(csvCell("+234 803 111 2222")).toBe("'+234 803 111 2222");
    expect(csvCell("@cmd")).toBe("'@cmd");
    expect(csvCell("-cmd")).toBe("'-cmd");
    expect(csvCell("-500.00")).toBe("-500.00");
    expect(csvCell("1250.50")).toBe("1250.50");
  });

  it("writes a header and rows, marked as UTF-8", () => {
    expect(toCsv(["Name", "Owes"], [["Ada", "100.00"], ["Bola, Ade", "0.00"]])).toBe('﻿Name,Owes\r\nAda,100.00\r\n"Bola, Ade",0.00\r\n');
  });
});
