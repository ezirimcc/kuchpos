/**
 * Writes the blank import workbook that people download from the app:
 *   public/templates/kuchpos-import-template.xlsx
 *
 * Run with:  npx tsx scripts/make-import-template.ts
 * Run it again whenever src/lib/import-template.ts changes, and commit the result. (A test
 * reads the workbook back and fails if it no longer matches that description.)
 */
import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import writeExcelFile from "write-excel-file/node";
import { IMPORT_INSTRUCTIONS, IMPORT_SHEETS, IMPORT_TEMPLATE_PATH } from "../src/lib/import-template";

const out = join(process.cwd(), "public", IMPORT_TEMPLATE_PATH);
mkdirSync(dirname(out), { recursive: true });

const sheets = IMPORT_SHEETS.map((sheet) => {
  const columns = Object.values(sheet.columns);
  return {
    sheet: sheet.name,
    stickyRowsCount: 2,
    columns: columns.map((column) => ({ width: column.width })),
    data: [
      // Row 1: the headings. Required columns end with a star and are shaded.
      columns.map((column) => ({
        value: column.required ? `${column.heading} *` : column.heading,
        fontWeight: "bold" as const,
        backgroundColor: column.required ? "#C8F169" : "#E8ECE9",
        wrap: true,
      })),
      // Row 2: what goes in the column. The import skips this row.
      columns.map((column) => ({ value: column.hint, color: "#6B7570", fontSize: 9, wrap: true, alignVertical: "top" as const })),
      // Row 3: an example. The import skips this row too; the shop's rows start in row 4.
      columns.map((column, index) => ({
        value: index === 0 && column.example === "" ? "" : column.example,
        type: String,
        color: "#6B7570",
        fontStyle: "italic" as const,
      })),
    ],
  };
});

const readMe = {
  sheet: "Read me",
  columns: [{ width: 130 }],
  data: IMPORT_INSTRUCTIONS.map((line, index) => [{ value: line, type: String, fontWeight: index === 0 ? ("bold" as const) : undefined, wrap: true }]),
};

writeExcelFile([readMe, ...sheets])
  .toFile(out)
  .then(() => console.log(`Wrote ${out}: ${sheets.map((sheet) => sheet.sheet).join(", ")}`))
  .catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
