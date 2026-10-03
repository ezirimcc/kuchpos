import { expect, type Page, test } from "@playwright/test";
import { expectSignedInAs, gotoReady, openFromMenu, signIn } from "./helpers";

// These tests build on each other, so they run one after another.
test.describe.configure({ mode: "serial" });

function addDays(days: number): string {
  // Nigeria is one hour ahead of universal time all year.
  const now = new Date(Date.now() + 60 * 60 * 1000);
  now.setUTCDate(now.getUTCDate() + days);
  return now.toISOString().slice(0, 10);
}

async function fillLine(page: Page, line: number, product: string, unit: RegExp | string, quantity: string, cost: string) {
  const row = page.getByTestId(`delivery-line-${line}`);
  await row.getByLabel("Product").fill(product);
  await row.getByLabel("Unit").selectOption({ label: await unitLabel(row, unit) });
  await row.getByLabel("How many arrived").fill(quantity);
  await row.getByLabel(/Cost of one/).fill(cost);
}

async function unitLabel(row: ReturnType<Page["getByTestId"]>, unit: RegExp | string): Promise<string> {
  const labels = await row.getByLabel("Unit").locator("option").allInnerTexts();
  const match = labels.find((label) => (typeof unit === "string" ? label === unit : unit.test(label)));
  if (!match) throw new Error(`No unit matching ${unit} among: ${labels.join(", ")}`);
  return match;
}

test("a storekeeper receives 2 cartons and 3 bags, and the stock shows it in base units", async ({ page }) => {
  await signIn(page, "gv.storekeeper");
  await expectSignedInAs(page, "Storekeeper");
  await openFromMenu(page, "Stock");
  await page.getByRole("link", { name: "Receive goods" }).click();
  await expect(page.getByRole("heading", { name: "Receive goods" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  // A storekeeper cannot change the date.
  await expect(page.getByLabel("Date received")).toBeDisabled();

  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Farm Inputs Depot (sample)" });
  await page.getByLabel("Goes into").selectOption({ label: "Storeroom" });
  await fillLine(page, 1, "Tomato Seed Sachet", /^carton/, "2", "30000");
  await expect(page.getByTestId("line-total-1")).toHaveText("₦60,000.00");

  await page.getByRole("button", { name: "Add another product" }).click();
  await fillLine(page, 2, "NPK 15-15-15 Fertilizer", /^bag/, "3", "40000.50");
  await expect(page.getByTestId("delivery-total")).toHaveText("₦180,001.50");

  await page.getByRole("button", { name: "Save delivery" }).click();
  await expect(page.getByRole("heading", { name: /Delivery GR-000001/ })).toBeVisible();
  await expect(page.getByTestId("receipt-total")).toHaveText("₦180,001.50");
  await expect(page.getByTestId("receipt-line-1")).toContainText("2 carton");
  await expect(page.getByTestId("receipt-line-1")).toContainText("200");
  await expect(page.getByTestId("receipt-line-2")).toContainText("150");

  await page.goto("/stock");
  const sachet = page.getByTestId("stock-row-Tomato Seed Sachet");
  await expect(sachet.getByTestId("stock-Storeroom")).toHaveText("200");
  await expect(sachet.getByTestId("stock-Shelf")).toHaveText("0");
  await expect(sachet).toContainText("2 carton");
  const fertilizer = page.getByTestId("stock-row-NPK 15-15-15 Fertilizer");
  await expect(fertilizer.getByTestId("stock-total")).toContainText("150 kg");
  await expect(fertilizer).toContainText("3 bag");
});

test("a whole-unit product refuses half a pack, and nothing is saved", async ({ page }) => {
  await signIn(page, "gv.storekeeper");
  await expectSignedInAs(page, "Storekeeper");
  await gotoReady(page, "/stock/receive");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Farm Inputs Depot (sample)" });
  await fillLine(page, 1, "Tomato Seed Sachet", /^pack/, "2.5", "4000");
  await page.getByRole("button", { name: "Save delivery" }).click();
  await expect(page.getByText(/comes in whole units only/)).toBeVisible();
  await expect(page.getByText("Nothing was saved. Please correct the highlighted fields.")).toBeVisible();
  // What was typed is still there to correct.
  await expect(page.getByTestId("delivery-line-1").getByLabel("How many arrived")).toHaveValue("2.5");

  await page.goto("/stock/receipts");
  await expect(page.getByTestId("receipt-row-2")).toHaveCount(0);
});

test("a product that uses batch and expiry must give them, and then shows under Expiring soon", async ({ page }) => {
  await signIn(page, "gv.storekeeper");
  await expectSignedInAs(page, "Storekeeper");
  await gotoReady(page, "/stock/receive");
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Farm Inputs Depot (sample)" });

  // A product not set up for it is never asked.
  const row = page.getByTestId("delivery-line-1");
  await row.getByLabel("Product").fill("Tomato Seed Sachet");
  await expect(row.getByLabel("Batch number")).toHaveCount(0);
  await expect(row.getByLabel("Expiry date")).toHaveCount(0);

  await fillLine(page, 1, "Liquid Herbicide", /^5 litre keg/, "4", "24000");
  await expect(row.getByLabel("Batch number")).toBeVisible();
  await row.getByLabel("Batch number").fill("LH-2026-09");
  await row.getByLabel("Expiry date").fill(addDays(45));
  await page.getByRole("button", { name: "Save delivery" }).click();
  await expect(page.getByRole("heading", { name: /Delivery GR-000002/ })).toBeVisible();
  await expect(page.getByTestId("receipt-line-1")).toContainText("LH-2026-09");

  await page.getByRole("link", { name: "Deliveries" }).first().click();
  await page.getByRole("link", { name: "Expiring soon" }).click();
  const expiring = page.getByTestId("expiring-row");
  await expect(expiring).toHaveCount(1);
  await expect(expiring).toContainText("Liquid Herbicide");
  await expect(expiring).toContainText("LH-2026-09");
  await expect(expiring).toContainText("20 litre");
});

test("the admin changes how far ahead 'expiring soon' looks", async ({ page }) => {
  await signIn(page, "gv.admin");
  await expectSignedInAs(page, "Admin");
  await page.goto("/settings");
  await expect(page.getByLabel("Months ahead")).toHaveValue("3");
  await page.getByLabel("Months ahead").fill("1");
  await page.getByRole("button", { name: "Save expiring-soon period" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();

  // The herbicide expires in 45 days, which is beyond one month.
  await page.goto("/stock/expiring");
  await expect(page.getByText(/Nothing in stock is expiring within 1 month/)).toBeVisible();

  await page.goto("/settings");
  await page.getByLabel("Months ahead").fill("3");
  await page.getByRole("button", { name: "Save expiring-soon period" }).click();
  await expect(page.getByText("Saved.")).toBeVisible();
});

test("a manager backdates a delivery only with a note, and it is marked and logged", async ({ page }) => {
  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");
  await gotoReady(page, "/stock/receive");

  await expect(page.getByLabel("Date received")).toBeEnabled();
  await page.getByLabel("Supplier", { exact: true }).selectOption({ label: "Farm Inputs Depot (sample)" });
  await page.getByLabel("Date received").fill(addDays(-2));
  const reason = page.getByLabel("Why is this delivery being entered with an earlier date?");
  await expect(reason).toBeVisible();
  await fillLine(page, 1, "Maize Grain (untaxed sample)", /^bag/, "1", "70000");

  await reason.fill("ok");
  await page.getByRole("button", { name: "Save delivery" }).click();
  await expect(page.getByText("Explain why this delivery is being entered with an earlier date.")).toBeVisible();

  await reason.fill("Lorry arrived after closing on Friday");
  await page.getByRole("button", { name: "Save delivery" }).click();
  await expect(page.getByRole("heading", { name: /Delivery GR-000003/ })).toBeVisible();
  await expect(page.getByTestId("backdate-notice")).toContainText("Lorry arrived after closing on Friday");

  await page.goto("/stock/receipts");
  await expect(page.getByTestId("receipt-row-3")).toContainText("Backdated");

  await page.goto("/activity");
  await expect(page.getByText(/BACKDATED to .* — reason: Lorry arrived after closing on Friday/)).toBeVisible();
});

test("a storekeeper adds a supplier from inside the delivery form", async ({ page }) => {
  await signIn(page, "gv.storekeeper");
  await expectSignedInAs(page, "Storekeeper");
  await gotoReady(page, "/stock/receive");
  const name = `Jos Seed Growers ${Date.now().toString(36)}`;
  await page.getByRole("button", { name: "+ New supplier" }).click();
  await page.getByLabel("New supplier's name").fill(name);
  await page.getByRole("button", { name: "Add", exact: true }).click();
  await expect(page.getByLabel("Supplier", { exact: true }).locator("option:checked")).toHaveText(name);

  await page.goto("/stock/suppliers");
  await expect(page.getByTestId(`supplier-row-${name}`)).toBeVisible();
});

test("a cashier can see stock but not deliveries, costs or the receiving form", async ({ page }) => {
  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await openFromMenu(page, "Stock");
  await expect(page.getByTestId("stock-row-Tomato Seed Sachet").getByTestId("stock-Storeroom")).toHaveText("200");
  await expect(page.getByRole("link", { name: "Receive goods" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Deliveries" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Suppliers" })).toHaveCount(0);

  for (const path of ["/stock/receive", "/stock/receipts", "/stock/suppliers", "/stock/expiring"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/$/);
  }
});

test("the other business sees none of these deliveries or this stock", async ({ page }) => {
  await signIn(page, "sf.manager");
  await expectSignedInAs(page, "Manager");
  await page.goto("/stock/receipts");
  await expect(page.getByText("No deliveries have been recorded yet.")).toBeVisible();
  await page.goto("/stock");
  await expect(page.getByText("Tomato Seed Sachet")).toHaveCount(0);
  await expect(page.getByTestId("stock-row-Layer Mash Poultry Feed").getByTestId("stock-total")).toContainText("0 kg");
});
