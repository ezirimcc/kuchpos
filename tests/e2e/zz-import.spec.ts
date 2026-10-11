import { expect, test } from "@playwright/test";
import { makeWorkbook, type Rows } from "../support/workbook";
import { expectSignedInAs, gotoReady, signIn } from "./helpers";

/**
 * Bringing a shop's products, customers and stock in from Excel (M15). Named to run last:
 * it adds products and stock to the second sample business.
 */

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

test("the admin checks a workbook, is shown its problems, corrects it and brings it in", async ({ page }) => {
  await signIn(page, "sf.admin");
  await expectSignedInAs(page, "Admin");
  await gotoReady(page, "/settings");
  await page.getByRole("link", { name: "Open Import from Excel" }).click();
  await expect(page.getByRole("heading", { name: "Import from Excel" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download the blank workbook (Excel)" })).toHaveAttribute("href", "/templates/kuchpos-import-template.xlsx");

  const products: Rows = [
    { code: "XL-MAIZE", name: "Excel Maize Seed", category: "Brought in", unit: "kg", contains: "1", price: "1200", fractions: "Yes" },
    { code: "XL-HOE", name: "Excel Hoe", category: "Brought in", unit: "piece", contains: "1", price: "3500" },
  ];
  const customers: Rows = [{ name: "Excel Farms Ltd", phone: "08099912345", city: "Owerri", state: "Imo", creditLimit: "100000", owed: "25000" }];

  // A workbook with a mistake: half a hoe.
  await page.getByLabel("Excel file").setInputFiles({
    name: "shop-wrong.xlsx",
    mimeType: XLSX,
    buffer: await makeWorkbook({ products, customers, stock: [{ code: "XL-HOE", unit: "piece", quantity: "2.5", cost: "2000" }] }),
  });
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByTestId("import-problems")).toContainText("Stock, row 4");
  await expect(page.getByTestId("import-problems")).toContainText("is counted in whole units");
  await expect(page.getByRole("button", { name: "Bring it in" })).toHaveCount(0);

  // Corrected.
  await page.getByLabel("Excel file").setInputFiles({
    name: "shop-right.xlsx",
    mimeType: XLSX,
    buffer: await makeWorkbook({
      products,
      customers,
      stock: [
        { code: "XL-HOE", unit: "piece", quantity: "12", cost: "2000" },
        { code: "XL-MAIZE", unit: "kg", quantity: "40.5", cost: "800" },
      ],
    }),
  });
  await expect(page.getByTestId("import-preview")).toHaveCount(0);
  await page.getByRole("button", { name: "Check the file" }).click();
  const preview = page.getByTestId("import-preview");
  await expect(preview).toContainText("New products: 2");
  await expect(preview).toContainText("New customers: 1, owing ₦25,000.00");
  await expect(preview).toContainText("2 lines, worth ₦56,400.00 at cost");
  await page.getByRole("button", { name: "Bring it in" }).click();
  await expect(page.getByTestId("import-message")).toHaveText("Brought in: 2 products, 1 customer and 2 lines of stock.");
  await expect(page.getByRole("row", { name: /IM-000001.*shop-right\.xlsx/ })).toBeVisible();

  // The same file again is refused.
  await page.getByLabel("Excel file").setInputFiles({
    name: "shop-right.xlsx",
    mimeType: XLSX,
    buffer: await makeWorkbook({
      products,
      customers,
      stock: [
        { code: "XL-HOE", unit: "piece", quantity: "12", cost: "2000" },
        { code: "XL-MAIZE", unit: "kg", quantity: "40.5", cost: "800" },
      ],
    }),
  });
  await page.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByTestId("import-preview")).toContainText(/nothing to bring in|already brought in|already has opening stock/);
  await expect(page.getByRole("button", { name: "Bring it in" })).toHaveCount(0);

  // What came in is there.
  await gotoReady(page, "/customers?q=Excel+Farms");
  await expect(page.getByRole("row", { name: /Excel Farms Ltd/ })).toContainText("₦25,000.00");
  await gotoReady(page, "/products?q=XL-");
  await expect(page.getByRole("row", { name: /Excel Hoe/ })).toBeVisible();
  await expect(page.getByRole("row", { name: /Excel Maize Seed/ })).toBeVisible();
});

test("nobody but the admin can open the import", async ({ page }) => {
  await signIn(page, "sf.manager");
  await expectSignedInAs(page, "Manager");
  await page.goto("/settings/import");
  await expect(page).toHaveURL(/\/$/);
});
