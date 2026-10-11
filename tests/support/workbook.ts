import writeExcelFile from "write-excel-file/node";
import { CUSTOMERS_SHEET, DELIVERIES_SHEET, type ImportSheet, PRODUCTS_SHEET, SALES_SHEET, STOCK_SHEET } from "@/lib/import-template";

export type Rows = Record<string, string | number | Date | null>[];

/**
 * Builds an import workbook in memory, as a shop would fill the template in: headings in
 * row 1, notes and an example in rows 2 and 3 (never imported), the given rows from row 4.
 * Each row is given by column key (see src/lib/import-template.ts); columns left out are empty.
 */
export async function makeWorkbook(sheets: { products?: Rows; customers?: Rows; stock?: Rows; deliveries?: Rows; sales?: Rows }): Promise<Buffer> {
  const one = (sheet: ImportSheet, rows: Rows | undefined) => {
    const keys = Object.keys(sheet.columns);
    const columns = Object.values(sheet.columns);
    return {
      sheet: sheet.name,
      data: [
        columns.map((column) => ({ value: column.required ? `${column.heading} *` : column.heading, type: String })),
        columns.map((column) => ({ value: column.hint, type: String })),
        columns.map((column) => ({ value: column.example, type: String })),
        ...(rows ?? []).map((row) =>
          keys.map((key) => {
            const value = row[key] ?? null;
            return value === null ? null : value instanceof Date ? { value, type: Date, format: "dd/mm/yyyy" } : typeof value === "number" ? { value, type: Number } : { value, type: String };
          }),
        ),
      ],
    };
  };
  return writeExcelFile([
    one(PRODUCTS_SHEET, sheets.products),
    one(CUSTOMERS_SHEET, sheets.customers),
    one(STOCK_SHEET, sheets.stock),
    one(DELIVERIES_SHEET, sheets.deliveries),
    one(SALES_SHEET, sheets.sales),
  ]).toBuffer();
}
