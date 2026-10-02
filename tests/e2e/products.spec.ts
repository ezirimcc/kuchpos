import { expect, test } from "@playwright/test";
import { expectSignedInAs, signIn } from "./helpers";

// These tests build on each other, so they run one after another.
test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
const sachetName = `Okra Seed ${stamp}`;
const fertilizerName = `Urea Fertilizer ${stamp}`;
let sachetUrl = "";

test("a manager creates a product sold as single, pack and carton, each with its own price", async ({ page }) => {
  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");
  await page.getByRole("link", { name: "Products & prices" }).click();
  await page.getByRole("link", { name: "Add a product" }).click();

  await page.getByLabel("Product name").fill(sachetName);
  await page.getByLabel("Base unit", { exact: true }).fill("single");
  await page.getByLabel("Selling price of one base unit (₦)").fill("500");
  await page.getByRole("button", { name: "Create product" }).click();

  await expect(page.getByRole("heading", { name: sachetName })).toBeVisible();
  sachetUrl = page.url();

  for (const [name, factor, price] of [
    ["pack", "10", "4500"],
    ["carton", "100", "42000"],
  ]) {
    await page.getByLabel("Unit name").fill(name);
    await page.getByLabel("How many single it contains").fill(factor);
    await page.getByLabel("Selling price (₦)").fill(price);
    await page.getByRole("button", { name: "Add unit" }).click();
    await expect(page.getByTestId(`unit-row-${name}`)).toBeVisible();
  }

  await expect(page.getByTestId("unit-row-single")).toContainText("1 single");
  await expect(page.getByTestId("unit-row-pack")).toContainText("10 single");
  await expect(page.getByTestId("unit-row-carton")).toContainText("100 single");
  await expect(page.getByLabel("Price per single")).toHaveValue("500.00");
  await expect(page.getByLabel("Price per pack")).toHaveValue("4500.00");
  await expect(page.getByLabel("Price per carton")).toHaveValue("42000.00");

  await page.goto("/products?q=" + encodeURIComponent(sachetName));
  const row = page.getByTestId(`product-row-${sachetName}`);
  await expect(row).toContainText("single — ₦500.00");
  await expect(row).toContainText("pack (10 single) — ₦4,500.00");
  await expect(row).toContainText("carton (100 single) — ₦42,000.00");
});

test("a whole-unit product refuses a pack of 2.5; a weighed product takes a 50 kg bag and a kobo price", async ({ page }) => {
  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");

  await page.goto(sachetUrl);
  await page.getByLabel("Unit name").fill("half pack");
  await page.getByLabel("How many single it contains").fill("2.5");
  await page.getByLabel("Selling price (₦)").fill("1200");
  await page.getByRole("button", { name: "Add unit" }).click();
  await expect(page.getByText(/sold in whole units only/).last()).toBeVisible();

  await page.goto("/products/new");
  await page.getByLabel("Product name").fill(fertilizerName);
  await page.getByLabel("Base unit", { exact: true }).fill("kg");
  await page.getByLabel("Sold in").selectOption("measure");
  await page.getByLabel("Selling price of one base unit (₦)").fill("1250.50");
  await page.getByRole("button", { name: "Create product" }).click();
  await expect(page.getByRole("heading", { name: fertilizerName })).toBeVisible();
  await expect(page.getByText("sold by weight or volume")).toBeVisible();

  await page.getByLabel("Unit name").fill("bag");
  await page.getByLabel("How many kg it contains").fill("50");
  await page.getByLabel("Selling price (₦)").fill("58000");
  await page.getByRole("button", { name: "Add unit" }).click();
  await expect(page.getByTestId("unit-row-bag")).toContainText("50 kg");

  await page.goto("/products?q=" + encodeURIComponent(fertilizerName));
  await expect(page.getByTestId(`product-row-${fertilizerName}`)).toContainText("kg — ₦1,250.50");
});

test("changing a price keeps the old price in the history", async ({ page }) => {
  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");
  await page.goto(sachetUrl);

  await page.getByLabel("Price per pack").fill("4750.50");
  await page.getByTestId("unit-row-pack").getByRole("button", { name: "Save price" }).click();

  const newest = page.getByTestId("price-history-row").first();
  await expect(newest).toContainText("pack");
  await expect(newest).toContainText("₦4,500.00");
  await expect(newest).toContainText("₦4,750.50");
  await expect(newest).toContainText("Green Valley Manager");

  await page.getByLabel("Price per pack").fill("4,800");
  await page.getByTestId("unit-row-pack").getByRole("button", { name: "Save price" }).click();
  await expect(page.getByText(/plain amount/)).toBeVisible();
});

test("a cashier can look prices up but cannot change anything", async ({ page }) => {
  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await page.goto("/products?q=" + encodeURIComponent(sachetName));
  await expect(page.getByTestId(`product-row-${sachetName}`)).toContainText("pack (10 single) — ₦4,750.50");
  await expect(page.getByRole("link", { name: "Add a product" })).toHaveCount(0);

  await page.goto(sachetUrl);
  await expect(page.getByRole("heading", { name: sachetName })).toBeVisible();
  await expect(page.getByRole("button", { name: "Save price" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Add unit" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Retire" })).toHaveCount(0);

  await page.goto("/products/new");
  await expect(page).toHaveURL(/\/$/);
});

test("the other business sees none of these products, even with the exact address", async ({ page }) => {
  await signIn(page, "sf.manager");
  await expectSignedInAs(page, "Manager");
  await page.goto("/products");
  await expect(page.getByTestId("product-row-Layer Mash Poultry Feed")).toBeVisible();
  await expect(page.getByText(sachetName)).toHaveCount(0);
  await expect(page.getByText("Tomato Seed Sachet")).toHaveCount(0);

  const response = await page.goto(sachetUrl);
  expect(response?.status()).toBe(404);
  await expect(page.getByText(sachetName)).toHaveCount(0);
});

test("the admin changes the tax rate and adds a checkout terminal", async ({ page }) => {
  await signIn(page, "gv.admin");
  await expectSignedInAs(page, "Admin");
  await page.getByRole("link", { name: "Settings" }).click();

  await expect(page.getByLabel("Tax rate (%)")).toHaveValue("0");
  await page.getByLabel("Tax rate (%)").fill("7.5");
  await page.getByRole("button", { name: "Save tax rate" }).click();
  const change = page.getByTestId("tax-history-row").first();
  await expect(change).toContainText("0%");
  await expect(change).toContainText("7.5%");
  await expect(change).toContainText("Green Valley Admin");

  const code = `K${stamp.slice(-4).toUpperCase()}`;
  await page.getByLabel("Code", { exact: true }).fill(code);
  await page.getByLabel("Name", { exact: true }).fill("Back checkout");
  await page.getByLabel("Receipt paper", { exact: true }).selectOption("MM58");
  await page.getByRole("button", { name: "Add terminal" }).click();
  await expect(page.getByTestId(`terminal-row-${code}`)).toBeVisible();
  await expect(page.getByLabel(`Receipt paper of terminal ${code}`)).toHaveValue("MM58");

  // Put the rate back so other test runs start from the same place.
  await page.getByLabel("Tax rate (%)").fill("0");
  await page.getByRole("button", { name: "Save tax rate" }).click();
  await expect(page.getByTestId("tax-history-row")).toHaveCount(2);
});
