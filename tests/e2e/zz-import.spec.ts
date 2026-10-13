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

  const setup = page.getByTestId("import-form-setup");
  const products: Rows = [
    { code: "XL-MAIZE", name: "Excel Maize Seed", category: "Brought in", unit: "kg", contains: "1", price: "1200", fractions: "Yes" },
    { code: "XL-HOE", name: "Excel Hoe", category: "Brought in", unit: "piece", contains: "1", price: "3500" },
  ];
  const customers: Rows = [{ name: "Excel Farms Ltd", phone: "08099912345", city: "Owerri", state: "Imo", creditLimit: "100000", owed: "25000" }];

  // A workbook with a mistake: half a hoe.
  await setup.getByLabel("Excel file").setInputFiles({
    name: "shop-wrong.xlsx",
    mimeType: XLSX,
    buffer: await makeWorkbook({ products, customers, stock: [{ code: "XL-HOE", unit: "piece", quantity: "2.5", cost: "2000" }] }),
  });
  await setup.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByTestId("import-problems-setup")).toContainText("Stock, row 4");
  await expect(page.getByTestId("import-problems-setup")).toContainText("is counted in whole units");
  await expect(setup.getByRole("button", { name: "Bring it in" })).toHaveCount(0);

  // Corrected.
  await setup.getByLabel("Excel file").setInputFiles({
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
  await expect(page.getByTestId("import-preview-setup")).toHaveCount(0);
  await setup.getByRole("button", { name: "Check the file" }).click();
  const preview = page.getByTestId("import-preview-setup");
  await expect(preview).toContainText("New products: 2");
  await expect(preview).toContainText("New customers: 1, owing ₦25,000.00");
  await expect(preview).toContainText("2 lines, worth ₦56,400.00 at cost");
  await setup.getByRole("button", { name: "Bring it in" }).click();
  await expect(page.getByTestId("import-message-setup")).toHaveText("Brought in: 2 products, 1 customer and 2 lines of stock.");
  await expect(page.getByRole("row", { name: /IM-000001.*shop-right\.xlsx/ })).toBeVisible();

  // The same file again is refused.
  await setup.getByLabel("Excel file").setInputFiles({
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
  await setup.getByRole("button", { name: "Check the file" }).click();
  await expect(page.getByTestId("import-preview-setup")).toContainText(/nothing to bring in|already brought in|already has opening stock/);
  await expect(setup.getByRole("button", { name: "Bring it in" })).toHaveCount(0);

  // Step 3: the deliveries and sales since. One sale takes more hoes than the records hold.
  const history = page.getByTestId("import-form-history");
  const now = new Date(Date.now() + 60 * 60 * 1000);
  const todayTyped = `${String(now.getUTCDate()).padStart(2, "0")}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${now.getUTCFullYear()}`;
  await history.getByLabel("Excel file").setInputFiles({
    name: "shop-history.xlsx",
    mimeType: XLSX,
    buffer: await makeWorkbook({
      deliveries: [{ date: todayTyped, reference: "XL-D1", supplier: "Excel Tools Supply", code: "XL-HOE", unit: "piece", quantity: "3", cost: "2100" }],
      sales: [
        { date: todayTyped, time: "00:05", receipt: "XL-900", code: "XL-HOE", unit: "piece", quantity: "20", price: "3500", paidBy: "Cash", soldBy: "sf.cashier" },
        { date: todayTyped, time: "00:06", receipt: "XL-901", code: "XL-MAIZE", unit: "kg", quantity: "2.5", price: "1200", paidBy: "Cash", customerPhone: "08099912345", onCredit: "1000" },
      ],
    }),
  });
  await history.getByRole("button", { name: "Check the file" }).click();
  const historyPreview = page.getByTestId("import-preview-history");
  await expect(historyPreview).toContainText("Deliveries: 1 (1 line), costing ₦6,300.00");
  await expect(historyPreview).toContainText("Sales: 2 (2 lines), worth ₦73,000.00");
  await expect(page.getByTestId("import-short")).toContainText("1 sale takes more out of stock than the records hold");
  await history.getByRole("button", { name: "Bring it in" }).click();
  await expect(page.getByTestId("import-message-history")).toContainText("Brought in: 1 delivery and 2 sales. 1 product was sold beyond the stock on record");
  await expect(page.getByRole("row", { name: /IM-000002.*shop-history\.xlsx.*1 delivery, 2 sales/ })).toBeVisible();

  await gotoReady(page, "/sales?q=IMP-XL-900");
  await page.getByRole("link", { name: "IMP-XL-900" }).click();
  await expect(page.getByTestId("imported-notice")).toContainText("brought in from the shop's Excel records");
  await expect(page.getByTestId("imported-notice")).toContainText('20 piece of "Excel Hoe" was sold, but the system held only 15 in');

  // The sale that took 20 hoes when 15 were held leaves the Shelf owing 5 (C72): the admin is told on the home page.
  await gotoReady(page, "/");
  await expect(page.getByTestId("unreconciled-sales")).toContainText("Unreconciled offline sales: 1");
  await page.getByTestId("unreconciled-sales").click();
  await expect(page.getByRole("heading", { name: "Sold beyond stock" })).toBeVisible();
  await expect(page.getByTestId("owed-row")).toContainText("Excel Hoe");
  await expect(page.getByTestId("owed-quantity")).toHaveText("−5 piece");
  await expect(page.getByTestId("owed-row")).toContainText("IMP-XL-900");
  await gotoReady(page, "/stock?q=Excel+Hoe");
  await expect(page.getByTestId("stock-row-Excel Hoe").getByTestId("stock-total")).toContainText("less 5 owed");

  // The reports draw what came in (C69): bars by product, and the last 14 days on the home page.
  await gotoReady(page, "/reports/sales?by=product");
  await expect(page.getByTestId("sales-chart")).toContainText("Net sales by product");
  await expect(page.getByTestId("sales-chart").getByTestId("chart-bar")).toHaveCount(2);
  await expect(page.getByTestId("period-links").getByRole("link", { name: "Last 12 months" })).toBeVisible();
  await gotoReady(page, "/");
  await expect(page.getByTestId("home-sales-chart").getByTestId("chart-column")).toHaveCount(14);

  // What came in is there.
  await gotoReady(page, "/customers?q=Excel+Farms");
  await expect(page.getByRole("row", { name: /Excel Farms Ltd/ })).toContainText("₦26,000.00");
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
