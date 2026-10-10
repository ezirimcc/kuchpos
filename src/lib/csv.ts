/**
 * Writing a table as a CSV file: plain text that Excel and every other spreadsheet opens.
 * Safe for both sides (no server-only code).
 */

/**
 * One cell. Text that a spreadsheet would run as a formula (starting with =, +, - or @) is
 * given a leading apostrophe so that it is shown, never run — a customer's name or a note
 * typed by staff must not be able to do anything when the accountant opens the file. Plain
 * numbers (including negative ones) are left as they are.
 */
export function csvCell(value: string | number | null | undefined): string {
  let text = value === null || value === undefined ? "" : String(value);
  const isNumber = /^-?\d+(\.\d+)?$/.test(text);
  if (!isNumber && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A whole table: a header row and data rows. Begins with a mark that tells Excel the text is UTF-8 (so ₦ and names survive). */
export function toCsv(header: string[], rows: (string | number | null | undefined)[][]): string {
  const lines = [header, ...rows].map((row) => row.map(csvCell).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
