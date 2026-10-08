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

/** On the Till page: says this computer is terminal T1, when the business has several. */
async function chooseT1(page: Page) {
  // The Till page itself must be on screen first: "ready" is already true from the page before.
  await expect(page.getByRole("heading", { name: "Till", exact: true })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  const which = page.getByLabel("This checkout");
  if ((await which.count()) > 0) await which.selectOption({ label: "T1 — Checkout 1" });
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

test("nothing can be sold until the till is open; the cashier opens it with a float", async ({ page }) => {
  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await openCheckout(page);
  await expect(page.getByTestId("till-closed")).toContainText("The till of T1 is not open");
  await addToSale(page, "tomato");
  await page.getByRole("button", { name: "Exact" }).click();
  await expect(page.getByTestId("complete-sale")).toBeDisabled();

  await page.getByTestId("till-closed").getByRole("link", { name: "Open the till" }).click();
  await expect(page.getByTestId("till-status")).toHaveText("The till of T1 is closed");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await page.getByLabel("Cash in the drawer now (₦)").fill("5,000");
  await page.getByRole("button", { name: "Open the till of T1" }).click();
  await expect(page.getByText(/Enter the cash in the drawer as a plain amount/)).toBeVisible();
  await page.getByLabel("Cash in the drawer now (₦)").fill("5000");
  await page.getByRole("button", { name: "Open the till of T1" }).click();

  await expect(page.getByTestId("till-status")).toHaveText("The till of T1 is open");
  await expect(page.getByTestId("till-sale-count")).toHaveText("0");
  // The cashier is not told how much cash should be in the drawer.
  await expect(page.getByTestId("till-expected-now")).toHaveCount(0);
  await page.getByRole("link", { name: "Go to the checkout" }).click();
  await expect(page.getByTestId("checkout-search")).toBeVisible();
  await expect(page.getByTestId("till-closed")).toHaveCount(0);
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

test("the admin adds a payment method; a sale is split between cash and a transfer, and both show on the receipt", async ({ page }) => {
  await signIn(page, "gv.admin");
  await expectSignedInAs(page, "Admin");
  await gotoReady(page, "/settings");
  await page.getByLabel("Name of the new method").fill("Transfer – GTBank");
  await page.getByLabel("Kind").selectOption({ label: "Bank transfer" });
  await page.getByRole("button", { name: "Add payment method" }).click();
  await expect(page.getByTestId("payment-method-Transfer – GTBank")).toContainText("Bank transfer");
  await expect(page.getByTestId("payment-method-Cash")).toContainText("Always available");
  // A sample method is switched off: it is no longer offered at checkout.
  await page.getByTestId("payment-method-POS machine (sample)").getByRole("button", { name: "Switch off" }).click();
  await expect(page.getByTestId("payment-method-POS machine (sample)")).toContainText("Switched off");
  await signOut(page);

  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");
  await openCheckout(page);
  await addToSale(page, "tomato");
  await page.keyboard.type("2");
  await page.getByTestId("cart-line-1").getByLabel(/^Unit/).selectOption({ label: "pack — ₦4,500.00" });
  await expect(page.getByTestId("cart-total")).toHaveText("₦9,000.00");

  const firstMethod = page.getByTestId("payment-1").getByLabel(/paid by/i);
  await expect(firstMethod.locator("option")).toHaveText(["Cash", "Bank transfer (sample)", "Transfer – GTBank"]);
  await page.getByRole("button", { name: "Split the payment" }).click();
  await expect(page.getByTestId("left-to-pay")).toContainText("—");

  const cashPart = page.getByTestId("payment-1");
  await cashPart.getByLabel("Amount (₦)").fill("4000");
  await cashPart.getByLabel(/Cash received/).fill("5000");
  const transferPart = page.getByTestId("payment-2");
  await transferPart.getByLabel(/paid by/i).selectOption({ label: "Transfer – GTBank" });
  // Not adding up yet: the sale cannot be completed.
  await transferPart.getByLabel("Amount (₦)").fill("4000");
  await expect(page.getByTestId("left-to-pay")).toContainText("₦1,000.00");
  await expect(page.getByTestId("complete-sale")).toBeDisabled();
  await transferPart.getByLabel("Amount (₦)").fill("5000");
  await transferPart.getByLabel("Reference (optional)").fill("GTB-448120");
  await expect(page.getByTestId("left-to-pay")).toContainText("₦0.00");
  await expect(page.getByTestId("change-due")).toHaveText("₦1,000.00");
  await page.getByTestId("complete-sale").click();

  const receipt = page.getByTestId("receipt");
  await expect(page.getByTestId("receipt-total-amount")).toHaveText("₦9,000.00");
  await expect(receipt).toContainText("Paid: Cash");
  await expect(receipt).toContainText("Cash received");
  await expect(receipt).toContainText("Paid: Transfer – GTBank");
  await expect(receipt).toContainText("Ref: GTB-448120");
  await expect(page.getByTestId("receipt-change")).toHaveText("₦1,000.00");

  // A manager sees what should be in the drawer at any time.
  await page.goto("/till");
  await chooseT1(page);
  await expect(page.getByTestId("till-status")).toHaveText("The till of T1 is open");
  // Float 5,000 + cash sales 43,500 + 3,126.25 + 4,500 + 500 + 4,000.
  await expect(page.getByTestId("till-expected-now")).toHaveText("₦60,626.25");
  await page.goto("/");
  await expect(page.getByTestId("stat-collected-today")).toContainText("₦60,626.25");
  await expect(page.getByTestId("stat-collected-today")).toContainText("₦55,626.25 of it in cash");
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

test("the cashier closes the till with a count and is not told the result; the manager sees it and can recount", async ({ page }) => {
  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await openFromMenu(page, "Till");
  await chooseT1(page);
  await expect(page.getByTestId("till-status")).toHaveText("The till of T1 is open");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("till-expected-now")).toHaveCount(0);

  // While it is open, the cashier is shown transfers taken but not the cash figure.
  await page.getByRole("link", { name: /See this session/ }).click();
  await expect(page.getByTestId("till-expected")).toHaveCount(0);
  await expect(page.getByTestId("till-method-Transfer – GTBank")).toContainText("₦5,000.00");
  await expect(page.getByTestId("till-method-Cash")).toHaveCount(0);
  await page.goBack();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  const form = page.getByTestId("close-till-form");
  await form.getByLabel("Cash counted in the drawer (₦)").fill("60600");
  await form.getByLabel("Note (optional)").fill("Counted twice");
  await form.getByRole("button", { name: "Close the till" }).click();

  // The cashier sees what they counted — and nothing about whether it was right.
  await expect(page.getByRole("heading", { name: /Till session TS-000001/ })).toBeVisible();
  await expect(page.getByTestId("till-counted")).toHaveText("₦60,600.00");
  await expect(page.getByTestId("till-result-hidden")).toBeVisible();
  await expect(page.getByTestId("till-expected")).toHaveCount(0);
  await expect(page.getByTestId("till-difference")).toHaveCount(0);
  await expect(page.getByTestId("till-method-Cash")).toHaveCount(0);
  await expect(page.getByTestId("recount-till-form")).toHaveCount(0);
  await expect(page.getByText("Note at closing: Counted twice")).toBeVisible();
  await page.goto("/till/sessions");
  await expect(page.getByTestId("till-row-1")).toContainText("Counted");
  await expect(page.getByTestId("till-row-1")).not.toContainText("short");

  // Nothing more can be sold at this checkout.
  await openCheckout(page);
  await expect(page.getByTestId("till-closed")).toBeVisible();
  await signOut(page);

  // The accountant reviews every session but has no till of their own to run.
  await signIn(page, "gv.accountant");
  await expectSignedInAs(page, "Accountant");
  await openFromMenu(page, "Till");
  await expect(page.getByRole("heading", { name: "Till sessions" })).toBeVisible();
  await expect(page.getByTestId("till-row-1")).toContainText("₦26.25 short");
  await expect(page.getByTestId("till-row-1")).toContainText("Green Valley Cashier");
  await page.getByTestId("till-row-1").getByRole("link", { name: "TS-000001" }).click();
  await expect(page.getByTestId("till-expected")).toHaveText("₦60,626.25");
  await expect(page.getByTestId("till-method-Cash")).toContainText("₦55,626.25");
  // The accountant reviews, but does not count cash.
  await expect(page.getByTestId("recount-till-form")).toHaveCount(0);
  await page.goto("/activity");
  await expect(page.getByText(/closed the till of T1 \(TS-000001\): counted ₦60,600.00, expected ₦60,626.25 — ₦26.25 SHORT/)).toBeVisible();
  await signOut(page);

  // The manager counts the drawer again the same day; it is saved beside the cashier's count, not over it.
  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");
  await page.goto("/till/sessions");
  await page.getByTestId("till-row-1").getByRole("link", { name: "TS-000001" }).click();
  await expect(page.getByTestId("till-closing-result")).toHaveText("₦26.25 short");
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  const recount = page.getByTestId("recount-till-form");
  await recount.getByLabel("Cash you counted (₦)").fill("60626.25");
  await recount.getByLabel("Why it was counted again").fill("Coins were in the second tray");
  await recount.getByRole("button", { name: "Save recount" }).click();

  await expect(page.getByTestId("till-recount-1")).toContainText("₦60,626.25");
  await expect(page.getByTestId("till-recount-1")).toContainText("Balanced");
  await expect(page.getByTestId("till-recount-1")).toContainText("Green Valley Manager");
  await expect(page.getByTestId("till-recount-1")).toContainText("Coins were in the second tray");
  // The cashier's closing count still stands as it was entered.
  await expect(page.getByTestId("till-counted")).toHaveText("₦60,600.00");
  await expect(page.getByTestId("till-closing-result")).toHaveText("₦26.25 short");
  await page.goto("/till/sessions");
  await expect(page.getByTestId("till-row-1")).toContainText("Balanced");
});
