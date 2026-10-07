import { expect, type Page, test } from "@playwright/test";
import { expectSignedInAs, gotoReady, openFromMenu, signIn, signOut } from "./helpers";

// These tests build on each other, and on the stock left by stock.spec.ts (which runs first:
// files run in alphabetical order). They run one after another.
test.describe.configure({ mode: "serial" });

// Printing would open the browser's print window. Count the calls instead.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const counter = window as unknown as { printed: number };
    counter.printed = 0;
    window.print = () => {
      counter.printed += 1;
    };
  });
});

const printed = (page: Page) => page.evaluate(() => (window as unknown as { printed: number }).printed);

async function stockOf(page: Page, product: string, location: "Storeroom" | "Shelf"): Promise<number> {
  await page.goto("/stock");
  return Number.parseInt(await page.getByTestId(`stock-row-${product}`).getByTestId(`stock-${location}`).innerText(), 10);
}

async function moveToShelf(page: Page, product: string, unit: RegExp, quantity: string) {
  await gotoReady(page, "/stock/transfers/new");
  const line = page.getByTestId("transfer-line-1");
  await line.getByLabel("Product").fill(product);
  const labels = await line.getByLabel("Unit").locator("option").allInnerTexts();
  await line.getByLabel("Unit").selectOption({ label: labels.find((label) => unit.test(label))! });
  await line.getByLabel("How many to move").fill(quantity);
  await page.getByRole("button", { name: "Move to Shelf" }).click();
  await expect(page.getByRole("heading", { name: /Transfer TR-/ })).toBeVisible();
}

/**
 * Opens the checkout as terminal T1. Other tests add terminals to this business, and with
 * more than one the checkout asks which one this computer is.
 */
async function openCheckout(page: Page) {
  await gotoReady(page, "/sell");
  const which = page.getByLabel("This checkout");
  if ((await which.count()) > 0) await which.selectOption({ label: "T1 — Checkout 1" });
  await page.getByTestId("checkout-search").focus();
}

/** Finds a product from the keyboard and adds it to the sale. */
async function addToSale(page: Page, words: string) {
  const search = page.getByTestId("checkout-search");
  await search.fill(words);
  await expect(page.getByTestId("checkout-matches").getByRole("option").first()).toBeVisible();
  await search.press("Enter");
}

let shelfBeforeFirstSale = 0;

test("the storekeeper stocks the Shelf for the tests that follow", async ({ page }) => {
  await signIn(page, "gv.storekeeper");
  await expectSignedInAs(page, "Storekeeper");
  await moveToShelf(page, "Tomato Seed Sachet", /^carton/, "1");
  await moveToShelf(page, "NPK 15-15-15 Fertilizer", /^bag/, "1");
  shelfBeforeFirstSale = await stockOf(page, "Tomato Seed Sachet", "Shelf");
  expect(shelfBeforeFirstSale).toBeGreaterThan(103);

  // A storekeeper does not sell and does not see sales.
  for (const path of ["/sell", "/sales"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/$/);
  }
});

test("a cashier sells 1 carton + 3 sachets; pressing the button rapidly makes one sale; the receipt prints once", async ({ page }) => {
  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await openFromMenu(page, "Sell");
  await expect(page.getByRole("heading", { name: "Sell" })).toBeVisible();
  await openCheckout(page);
  await expect(page.getByTestId("cart-empty")).toBeVisible();
  await expect(page.getByTestId("complete-sale")).toBeDisabled();
  // A cashier is not offered the Storeroom.
  await expect(page.getByText("Take this straight from the Storeroom")).toHaveCount(0);

  // First line: found by name, then switched to cartons.
  await addToSale(page, "tomato");
  const first = page.getByTestId("cart-line-1");
  await expect(first).toContainText("Tomato Seed Sachet");
  await expect(first).toContainText(`On Shelf: ${shelfBeforeFirstSale}`);
  await first.getByLabel(/^Unit/).selectOption({ label: "carton — ₦42,000.00" });
  await expect(page.getByTestId("cart-line-total-1")).toHaveText("₦42,000.00");

  // Second line: found by its code; the cursor lands in "how many", and Enter returns to the search box.
  await addToSale(page, "GV-SEED-01");
  const second = page.getByTestId("cart-line-2");
  await expect(second.getByLabel(/^How many/)).toBeFocused();
  await page.keyboard.type("3");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("checkout-search")).toBeFocused();
  await expect(page.getByTestId("cart-line-total-2")).toHaveText("₦1,500.00");
  await expect(page.getByTestId("cart-total")).toHaveText("₦43,500.00");

  // Too little cash: the sale cannot be completed.
  await page.getByLabel("Cash received (₦)").fill("40000");
  await expect(page.getByText("₦3,500.00 short.")).toBeVisible();
  await expect(page.getByTestId("complete-sale")).toBeDisabled();

  await page.getByLabel("Cash received (₦)").fill("50000");
  await expect(page.getByTestId("change-due")).toHaveText("₦6,500.00");
  // An impatient cashier.
  await page.getByTestId("complete-sale").dblclick();
  await page.getByTestId("complete-sale").click({ force: true, timeout: 2000 }).catch(() => {});

  await expect(page).toHaveURL(/\/sales\/[0-9a-f-]{36}\?sold=1$/);
  await expect(page.getByRole("heading", { name: "Sale T1-000001" })).toBeVisible();
  const receipt = page.getByTestId("receipt");
  await expect(receipt).toContainText("Green Valley Agro (sample)");
  await expect(receipt).toContainText("Receipt: T1-000001");
  await expect(receipt).toContainText("Served by: Green Valley Cashier");
  await expect(page.getByTestId("receipt-item-1")).toContainText("1 carton × ₦42,000.00");
  await expect(page.getByTestId("receipt-item-1")).toContainText("₦42,000.00");
  await expect(page.getByTestId("receipt-item-2")).toContainText("3 sachet × ₦500.00");
  await expect(page.getByTestId("receipt-item-2")).toContainText("₦1,500.00");
  await expect(page.getByTestId("receipt-total-amount")).toHaveText("₦43,500.00");
  await expect(page.getByTestId("receipt-change")).toHaveText("₦6,500.00");
  // No tax line while the rate is 0%, and this is the original.
  await expect(page.getByTestId("receipt-tax")).toHaveCount(0);
  await expect(page.getByTestId("reprint-mark")).toHaveCount(0);
  await expect(receipt).toHaveAttribute("data-width", "MM80");

  // It printed by itself, once, and Enter starts the next sale.
  await expect.poll(() => printed(page)).toBe(1);
  await expect(page.getByTestId("new-sale")).toBeFocused();
  // Nothing of the receipt is wider than the paper.
  expect(await receipt.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);

  // Exactly one sale, and 103 sachets fewer on the Shelf.
  await page.goto("/sales");
  await expect(page.getByTestId("sale-row-T1-000001")).toHaveCount(1);
  await expect(page.getByTestId("sale-row-T1-000002")).toHaveCount(0);
  await expect(page.getByTestId("sales-sum")).toHaveText("₦43,500.00");
  expect(await stockOf(page, "Tomato Seed Sachet", "Shelf")).toBe(shelfBeforeFirstSale - 103);
});

test("2.5 kg can be sold, entirely from the keyboard; 2.5 cartons of a whole-unit product cannot", async ({ page }) => {
  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await openCheckout(page);

  await addToSale(page, "tomato");
  await page.keyboard.type("2.5");
  await expect(page.getByText("Tomato Seed Sachet is sold in whole units only. Enter a whole number.")).toBeVisible();
  await expect(page.getByTestId("cart-total")).toHaveText("—");
  await expect(page.getByTestId("complete-sale")).toBeDisabled();
  await page.getByRole("button", { name: "Remove Tomato Seed Sachet" }).click();
  await expect(page.getByTestId("cart-empty")).toBeVisible();

  // Keyboard only: find, Enter, how many, Enter, Enter again for the cash box, amount, Enter.
  await expect(page.getByTestId("checkout-search")).toBeFocused();
  await page.keyboard.type("npk");
  await expect(page.getByTestId("checkout-matches").getByRole("option").first()).toBeVisible();
  await page.keyboard.press("Enter");
  await page.keyboard.type("2.5");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("cart-total")).toHaveText("₦3,126.25");
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Cash received (₦)")).toBeFocused();
  await page.keyboard.type("3200");
  await expect(page.getByTestId("change-due")).toHaveText("₦73.75");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("heading", { name: "Sale T1-000002" })).toBeVisible();
  await expect(page.getByTestId("receipt-item-1")).toContainText("2.5 kg × ₦1,250.50");
  await expect(page.getByTestId("receipt-total-amount")).toHaveText("₦3,126.25");
  // Enter again: straight into the next sale.
  await expect(page.getByTestId("new-sale")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("checkout-search")).toBeFocused();
  await expect(page.getByTestId("cart-empty")).toBeVisible();
});

test("a sale of more than the Shelf holds is refused with the amount that is there, and what was entered is kept", async ({ page }) => {
  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  const shelf = await stockOf(page, "Tomato Seed Sachet", "Shelf");
  await openCheckout(page);

  await addToSale(page, "tomato");
  await page.keyboard.type(String(shelf + 1));
  await expect(page.getByTestId("cart-line-1")).toContainText("not enough");
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByTestId("complete-sale").click();

  await expect(page.getByText("Nothing was sold: there is not enough stock.")).toBeVisible();
  await expect(page.getByText(new RegExp(`Only ${shelf} sachet of "Tomato Seed Sachet" is in Shelf`))).toBeVisible();
  await expect(page.getByTestId("cart-line-1").getByLabel(/^How many/)).toHaveValue(String(shelf + 1));

  await page.goto("/sales");
  await expect(page.getByTestId("sale-row-T1-000003")).toHaveCount(0);
  expect(await stockOf(page, "Tomato Seed Sachet", "Shelf")).toBe(shelf);
});

test("a receipt printed again is marked REPRINT; a manager can sell from the Storeroom and sees every sale and its profit", async ({ page }) => {
  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await page.goto("/sales");
  await page.getByTestId("sale-row-T1-000001").getByRole("link", { name: "T1-000001" }).click();
  await expect(page.getByRole("heading", { name: "Sale T1-000001" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  // Opened later, it does not print by itself, and a cashier is not shown cost or profit.
  expect(await printed(page)).toBe(0);
  await expect(page.getByTestId("sale-profit")).toHaveCount(0);
  await page.getByRole("button", { name: "Print again" }).click();
  await expect(page.getByTestId("reprint-mark")).toBeVisible();
  await expect.poll(() => printed(page)).toBe(1);
  await signOut(page);

  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");
  const storeroom = await stockOf(page, "Tomato Seed Sachet", "Storeroom");
  await page.goto("/");
  await expect(page.getByTestId("stat-sales-today")).toContainText("₦46,626.25");
  await expect(page.getByTestId("stat-sales-today")).toContainText("2 sales");

  await openCheckout(page);
  await addToSale(page, "tomato");
  await page.getByTestId("cart-line-1").getByLabel(/^Unit/).selectOption({ label: "pack — ₦4,500.00" });
  await page.getByText("Take this straight from the Storeroom").click();
  await expect(page.getByTestId("cart-line-1")).toContainText(`In Storeroom: ${storeroom}`);
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByTestId("complete-sale").click();

  await expect(page.getByRole("heading", { name: "Sale T1-000003" })).toBeVisible();
  await expect(page.getByTestId("sale-line-1")).toContainText("Storeroom");
  await expect(page.getByTestId("sale-profit")).toContainText("profit");
  expect(await stockOf(page, "Tomato Seed Sachet", "Storeroom")).toBe(storeroom - 10);

  await page.goto("/sales");
  await expect(page.getByTestId("sale-row-T1-000001")).toContainText("Green Valley Cashier");
  await expect(page.getByTestId("sale-row-T1-000003")).toContainText("Green Valley Manager");
  await expect(page.getByTestId("sales-sum")).toHaveText("₦51,126.25");
  await page.goto("/activity");
  await expect(page.getByText("Green Valley Cashier printed receipt T1-000001 again.")).toBeVisible();
});

test("the admin adds a tax number and a tax rate; the next receipt shows both, and the customer still pays the shelf price", async ({ page }) => {
  await signIn(page, "gv.admin");
  await expectSignedInAs(page, "Admin");
  await gotoReady(page, "/settings");
  await page.getByLabel("Tax number (TIN), optional").fill("12345678-0001");
  await page.getByLabel("Bottom of receipt").fill("Goods sold in good condition are not returnable.");
  await page.getByRole("button", { name: "Save receipt text" }).click();
  await expect(page.getByText("Receipt text saved.")).toBeVisible();
  await page.getByLabel(/Tax rate/).first().fill("7.5");
  await page.getByRole("button", { name: /Save tax rate/ }).click();
  await expect(page.getByText(/Tax rate saved/)).toBeVisible();

  await openCheckout(page);
  await addToSale(page, "tomato");
  await expect(page.getByTestId("cart-total")).toHaveText("₦500.00");
  await page.getByRole("button", { name: "Exact" }).click();
  await page.getByTestId("complete-sale").click();

  const receipt = page.getByTestId("receipt");
  await expect(receipt).toContainText("TIN: 12345678-0001");
  await expect(receipt).toContainText("Goods sold in good condition are not returnable.");
  await expect(page.getByTestId("receipt-total-amount")).toHaveText("₦500.00");
  // 500 × 7.5 ÷ 107.5 = 34.88
  await expect(page.getByTestId("receipt-tax")).toHaveText("₦34.88");

  // The first sale still says what it said: no tax.
  await page.goto("/sales");
  await page.getByTestId("sale-row-T1-000001").getByRole("link", { name: "T1-000001" }).click();
  await expect(page.getByTestId("receipt-tax")).toHaveCount(0);
  await expect(page.getByTestId("receipt-total-amount")).toHaveText("₦43,500.00");

  // Back to 0% so later runs and other tests start from the usual settings.
  await gotoReady(page, "/settings");
  await page.getByLabel(/Tax rate/).first().fill("0");
  await page.getByRole("button", { name: /Save tax rate/ }).click();
  await expect(page.getByText(/Tax rate saved/)).toBeVisible();
});

test("a cashier sees only their own sales; an accountant sees all but cannot sell; the other business sees none", async ({ page }) => {
  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await openFromMenu(page, "Sales");
  await expect(page.getByText("The sales you have made, newest first.")).toBeVisible();
  await expect(page.getByTestId("sale-row-T1-000001")).toBeVisible();
  await expect(page.getByTestId("sale-row-T1-000002")).toBeVisible();
  await expect(page.getByTestId("sale-row-T1-000003")).toHaveCount(0);
  await expect(page.getByTestId("sales-sum")).toHaveText("₦46,626.25");
  await page.goto("/");
  await expect(page.getByTestId("stat-sales-today")).toContainText("Your sales today");
  await signOut(page);

  await signIn(page, "gv.accountant");
  await expectSignedInAs(page, "Accountant");
  await openFromMenu(page, "Sales");
  await expect(page.getByTestId("sale-row-T1-000003")).toBeVisible();
  await expect(page.getByTestId("sale-row-T1-000004")).toBeVisible();
  await expect(page.getByRole("link", { name: "New sale" })).toHaveCount(0);
  await page.goto("/sell");
  await expect(page).toHaveURL(/\/$/);
  await signOut(page);

  await signIn(page, "sf.manager");
  await expectSignedInAs(page, "Manager");
  await page.goto("/sales");
  await expect(page.getByText("No sales have been made yet.")).toBeVisible();
  await openCheckout(page);
  await page.getByTestId("checkout-search").fill("tomato");
  await expect(page.getByText(/No product on sale matches/)).toBeVisible();
});
