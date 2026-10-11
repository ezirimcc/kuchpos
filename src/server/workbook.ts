import "server-only";
import readExcelFile from "read-excel-file/node";
import { IMPORT_FIRST_DATA_ROW, IMPORT_MAX_BYTES, IMPORT_MAX_ROWS, type ImportSheet } from "@/lib/import-template";
import { ValidationError } from "@/server/errors";

/**
 * Reading an uploaded Excel workbook. An uploaded file is NOT trusted:
 * - only .xlsx, at most 5 MB, at most 20,000 rows a sheet;
 * - numbers are taken as the exact text in the file and never become JavaScript numbers
 *   (they are parsed later by the money and quantity helpers);
 * - formulas are never worked out — the library only reads what the spreadsheet program
 *   last showed, and a formula cell with an error reads as empty;
 * - nothing in a cell is ever run, shown as HTML or used to find a file.
 */

export type Cell = string | boolean | Date | null;
/** One row of a sheet: its row number in Excel, and each known column's cell by the column's key. */
export type SheetRow<Key extends string> = { row: number; cells: Record<Key, Cell> };
export type Problem = { sheet: string; row: number | null; message: string };

const plain = (text: string) => text.replace(/\*/g, "").replace(/\s+/g, " ").trim().toLowerCase();

export async function readWorkbook(bytes: Buffer): Promise<Map<string, Cell[][]>> {
  if (bytes.length === 0) throw new ValidationError("That file is empty. Choose the workbook you filled in.");
  if (bytes.length > IMPORT_MAX_BYTES) throw new ValidationError("That file is larger than 5 MB. Remove empty rows and pictures, or split it into two files.");
  let sheets: { sheet: string; data: unknown[][] }[];
  try {
    sheets = await readExcelFile(bytes, { parseNumber: (text: string) => text });
  } catch (error) {
    const code = (error as { code?: string }).code;
    throw new ValidationError(
      code === "XLS_FILE_NOT_SUPPORTED"
        ? "That is an old-style .xls file. Open it in Excel, choose Save As, pick \"Excel Workbook (.xlsx)\", and upload that."
        : "That file could not be read as an Excel workbook. Upload the .xlsx file you downloaded from this page and filled in.",
    );
  }
  const byName = new Map<string, Cell[][]>();
  for (const sheet of sheets) {
    if (sheet.data.length > IMPORT_MAX_ROWS + IMPORT_FIRST_DATA_ROW) {
      throw new ValidationError(`The sheet "${sheet.sheet}" has more than ${IMPORT_MAX_ROWS.toLocaleString("en-NG")} rows. Split it over two files.`);
    }
    byName.set(
      plain(sheet.sheet),
      sheet.data.map((row) => row.map((cell): Cell => (typeof cell === "string" || typeof cell === "boolean" || cell instanceof Date ? cell : cell === null || cell === undefined ? null : String(cell)))),
    );
  }
  return byName;
}

/**
 * The shop's own rows of one sheet (from row 4 down; rows that are completely empty are
 * skipped), with each cell filed under its column's key. A sheet that is missing, or has
 * no rows, gives none. A sheet that has rows but lacks a required heading is a problem.
 */
export function rowsOf<Sheet extends ImportSheet>(
  workbook: Map<string, Cell[][]>,
  sheet: Sheet,
  problems: Problem[],
): SheetRow<keyof Sheet["columns"] & string>[] {
  type Key = keyof Sheet["columns"] & string;
  const data = workbook.get(plain(sheet.name));
  if (!data || data.length < IMPORT_FIRST_DATA_ROW) return [];
  const headings = (data[0] ?? []).map((cell) => (typeof cell === "string" ? plain(cell) : ""));
  const at = new Map<Key, number>();
  for (const [key, column] of Object.entries(sheet.columns) as [Key, ImportSheet["columns"][string]][]) {
    const index = headings.indexOf(plain(column.heading));
    if (index >= 0) at.set(key, index);
  }
  const rows: SheetRow<Key>[] = [];
  for (let index = IMPORT_FIRST_DATA_ROW - 1; index < data.length; index += 1) {
    const cells = data[index] ?? [];
    if (cells.every((cell) => cell === null || cell === "")) continue;
    rows.push({
      row: index + 1,
      cells: Object.fromEntries((Object.keys(sheet.columns) as Key[]).map((key) => [key, at.has(key) ? (cells[at.get(key)!] ?? null) : null])) as Record<Key, Cell>,
    });
  }
  if (rows.length > 0) {
    for (const [key, column] of Object.entries(sheet.columns) as [Key, ImportSheet["columns"][string]][]) {
      if (column.required && !at.has(key)) {
        problems.push({ sheet: sheet.name, row: 1, message: `The heading "${column.heading}" is missing. Do not change the headings in row 1; download the template again if needed.` });
      }
    }
  }
  return rows;
}

/** A cell as text: trimmed; a date or a tick becomes what a person would have typed. */
export function cellText(cell: Cell): string {
  if (cell === null) return "";
  if (typeof cell === "boolean") return cell ? "Yes" : "No";
  if (cell instanceof Date) return cellDay(cell) ?? "";
  return cell.trim();
}

/** Yes / No (also Y, N, True, False, 1, 0). Empty gives the default. Anything else is not understood: null. */
export function cellYesNo(cell: Cell, whenEmpty: boolean): boolean | null {
  const text = cellText(cell).toLowerCase();
  if (text === "") return whenEmpty;
  if (["yes", "y", "true", "1"].includes(text)) return true;
  if (["no", "n", "false", "0"].includes(text)) return false;
  return null;
}

/** A day as "YYYY-MM-DD": from a date cell, or from text typed day/month/year (or year-month-day). Null if it is not a real day. */
export function cellDay(cell: Cell): string | null {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell.toISOString().slice(0, 10);
  if (typeof cell !== "string") return null;
  const text = cell.trim();
  const typed = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  const [year, month, day] = typed ? [typed[3], typed[2], typed[1]] : iso ? [iso[1], iso[2], iso[3]] : ["", "", ""];
  if (!year) return null;
  const value = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null;
}

/**
 * A time of day as minutes after midnight: from text typed hour:minute on a 24-hour clock
 * ("14:35"), or from a cell Excel keeps as a time. Null if it is not a time.
 */
export function cellMinutes(cell: Cell): number | null {
  if (cell instanceof Date) return Number.isNaN(cell.getTime()) ? null : cell.getUTCHours() * 60 + cell.getUTCMinutes();
  if (typeof cell !== "string") return null;
  const text = cell.trim();
  const typed = /^(\d{1,2})[:.](\d{2})(?::\d{2})?$/.exec(text);
  if (typed) {
    const hours = Number.parseInt(typed[1], 10);
    const minutes = Number.parseInt(typed[2], 10);
    return hours <= 23 && minutes <= 59 ? hours * 60 + minutes : null;
  }
  // Excel keeps a time as the part of a day that has passed: 0.5 is noon. (A count of
  // minutes, not money or stock, so ordinary arithmetic is right here.)
  if (/^0?\.\d+$/.test(text)) return Math.min(1439, Math.round(Number.parseFloat(text) * 1440));
  return null;
}
