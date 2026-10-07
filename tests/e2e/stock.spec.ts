import { expect, type Page, test } from "@playwright/test";
import { expectSignedInAs, gotoReady, openFromMenu, signIn, signOut } from "./helpers";

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

test("a storekeeper can read a delivery but is not offered, and cannot open, the correction screen", async ({ page }) => {
  await signIn(page, "gv.storekeeper");
  await expectSignedInAs(page, "Storekeeper");
  await page.goto("/stock/receipts");
  await page.getByTestId("receipt-row-1").getByRole("link", { name: "GR-000001" }).click();
  await expect(page.getByRole("heading", { name: /Delivery GR-000001/ })).toBeVisible();
  await expect(page.getByRole("link", { name: "Correct this delivery" })).toHaveCount(0);

  await page.goto(`${page.url()}/correct`);
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole("button", { name: "Save correction" })).toHaveCount(0);
});

test("a manager corrects a delivery with a reason; stock follows and the original stays on record", async ({ page }) => {
  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");

  await page.goto("/stock");
  const sachet = page.getByTestId("stock-row-Tomato Seed Sachet");
  const before = Number.parseInt(await sachet.getByTestId("stock-Storeroom").innerText(), 10);

  await page.goto("/stock/receipts");
  await page.getByTestId("receipt-row-1").getByRole("link", { name: "GR-000001" }).click();
  await page.getByRole("link", { name: "Correct this delivery" }).click();
  await expect(page.getByRole("heading", { name: "Correct delivery GR-000001" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  // The form opens filled with the delivery as it stands.
  const line = page.getByTestId("delivery-line-1");
  await expect(line.getByLabel("Product")).toHaveValue("Tomato Seed Sachet");
  await expect(line.getByLabel("How many arrived")).toHaveValue("2");
  await expect(page.getByTestId("delivery-total")).toHaveText("₦180,001.50");

  // Three cartons arrived, not two, at ₦29,000 each. Without a good reason nothing is saved.
  await line.getByLabel("How many arrived").fill("3");
  await line.getByLabel(/Cost of one/).fill("29000");
  await page.getByLabel("Why is this delivery being corrected?").fill("oops");
  await page.getByRole("button", { name: "Save correction" }).click();
  await expect(page.getByText("Explain why this delivery is being corrected.")).toBeVisible();
  await expect(line.getByLabel("How many arrived")).toHaveValue("3");

  await page.getByLabel("Why is this delivery being corrected?").fill("Counted again against the waybill");
  await page.getByRole("button", { name: "Save correction" }).click();

  await expect(page.getByRole("heading", { name: /Delivery GR-000001/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Delivery GR-000001/ })).toContainText("Corrected");
  await expect(page.getByTestId("corrected-notice")).toContainText("Counted again against the waybill");
  await expect(page.getByTestId("receipt-line-1")).toContainText("3 carton");
  await expect(page.getByTestId("receipt-total")).toHaveText("₦207,001.50");

  const correction = page.getByTestId("correction-1");
  await expect(correction).toContainText("Reason: Counted again against the waybill");
  await expect(correction.getByRole("row", { name: /Arrived/ })).toContainText("2 carton");
  await expect(correction.getByRole("row", { name: /Arrived/ })).toContainText("3 carton");
  await expect(correction.getByRole("row", { name: /Cost each/ })).toContainText("₦30,000.00 per carton");
  await expect(correction.getByRole("row", { name: /Total cost/ })).toContainText("₦207,001.50");
  await expect(page.getByTestId("correction-1-stock")).toContainText("+100");
  // The delivery exactly as the storekeeper first entered it.
  await expect(page.getByTestId("original-delivery")).toContainText("2 carton");
  await expect(page.getByTestId("original-delivery")).toContainText("₦180,001.50");

  await page.goto("/stock/receipts");
  await expect(page.getByTestId("receipt-row-1")).toContainText("Corrected");

  await page.goto("/stock");
  await expect(sachet.getByTestId("stock-Storeroom")).toHaveText(String(before + 100));
});

test("a storekeeper moves 1 carton from the Storeroom to the Shelf, and too much is refused", async ({ page }) => {
  await signIn(page, "gv.storekeeper");
  await expectSignedInAs(page, "Storekeeper");

  await page.goto("/stock");
  const sachet = page.getByTestId("stock-row-Tomato Seed Sachet");
  const storeroom = Number.parseInt(await sachet.getByTestId("stock-Storeroom").innerText(), 10);
  const shelf = Number.parseInt(await sachet.getByTestId("stock-Shelf").innerText(), 10);

  await page.getByRole("link", { name: "Transfers" }).click();
  await expect(page.getByText("No stock has been moved between locations yet.")).toBeVisible();
  await page.getByRole("link", { name: "New transfer" }).click();
  await expect(page.getByRole("heading", { name: "New transfer" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  await expect(page.getByLabel("Move from").locator("option:checked")).toHaveText("Storeroom");
  await expect(page.getByLabel("Move to").locator("option:checked")).toHaveText("Shelf");
  const line = page.getByTestId("transfer-line-1");
  await line.getByLabel("Product").fill("Tomato Seed Sachet");
  await expect(page.getByTestId("available-1")).toContainText(`In Storeroom now: ${storeroom}`);

  // More than is there: refused, with the amount that is there, and what was typed is kept.
  await line.getByLabel("Unit").selectOption({ label: await unitLabel(line, /^carton/) });
  await line.getByLabel("How many to move").fill("50");
  await page.getByRole("button", { name: "Move to Shelf" }).click();
  await expect(page.getByText("Nothing was moved: there is not enough in Storeroom.")).toBeVisible();
  await expect(page.getByText(new RegExp(`Only ${storeroom} .* is in Storeroom`))).toBeVisible();
  await expect(line.getByLabel("How many to move")).toHaveValue("50");

  await line.getByLabel("How many to move").fill("1");
  await page.getByLabel("Note (optional)").fill("Restocking the front shelf");
  await page.getByRole("button", { name: "Move to Shelf" }).click();

  await expect(page.getByRole("heading", { name: "Transfer TR-000001" })).toBeVisible();
  await expect(page.getByTestId("transfer-line-1")).toContainText("1 carton");
  await expect(page.getByTestId("transfer-line-1")).toContainText("100");
  await expect(page.getByText("Note: Restocking the front shelf")).toBeVisible();

  await page.goto("/stock");
  await expect(sachet.getByTestId("stock-Storeroom")).toHaveText(String(storeroom - 100));
  await expect(sachet.getByTestId("stock-Shelf")).toHaveText(String(shelf + 100));

  await page.goto("/stock/transfers");
  await expect(page.getByTestId("transfer-row-1")).toContainText("Tomato Seed Sachet");
  await expect(page.getByTestId("transfer-row-1")).toContainText("Green Valley Storekeeper");
});

test("an accountant can read transfers but not make one; a cashier sees neither; the other business sees none", async ({ page }) => {
  await signIn(page, "gv.accountant");
  await expectSignedInAs(page, "Accountant");
  await page.goto("/stock/transfers");
  await expect(page.getByTestId("transfer-row-1")).toBeVisible();
  await expect(page.getByRole("link", { name: "New transfer" })).toHaveCount(0);
  await page.goto("/stock/transfers/new");
  await expect(page).toHaveURL(/\/$/);
  await signOut(page);

  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await openFromMenu(page, "Stock");
  await expect(page.getByRole("link", { name: "Transfers" })).toHaveCount(0);
  await page.goto("/stock/transfers");
  await expect(page).toHaveURL(/\/$/);
  await signOut(page);

  await signIn(page, "sf.manager");
  await expectSignedInAs(page, "Manager");
  await page.goto("/stock/transfers");
  await expect(page.getByText("No stock has been moved between locations yet.")).toBeVisible();
});

async function stockOf(page: Page, product: string, location: "Storeroom" | "Shelf"): Promise<number> {
  await page.goto("/stock");
  return Number.parseInt(await page.getByTestId(`stock-row-${product}`).getByTestId(`stock-${location}`).innerText(), 10);
}

test("a storekeeper counts 5 fewer than the system holds: the difference shows only after saving, and the adjustment waits", async ({ page }) => {
  await signIn(page, "gv.storekeeper");
  await expectSignedInAs(page, "Storekeeper");
  const before = await stockOf(page, "Tomato Seed Sachet", "Storeroom");

  await page.getByRole("link", { name: "Counts" }).click();
  await expect(page.getByText("No stock has been counted yet.")).toBeVisible();
  await page.getByRole("link", { name: "New count" }).click();
  await expect(page.getByRole("heading", { name: "New stock count" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");

  // A blind count: nothing on the sheet says how much the system holds.
  const row = page.getByTestId("count-product-Tomato Seed Sachet");
  await expect(row).not.toContainText(String(before));
  await expect(page.getByText("Nothing counted yet.")).toBeVisible();

  await page.getByLabel("Where are you counting?").selectOption({ label: "Storeroom" });
  await page.getByLabel("Tomato Seed Sachet: carton").fill("1");
  await page.getByLabel("Tomato Seed Sachet: sachet").fill(String(before - 100 - 5));
  await expect(page.getByTestId("counted-so-far")).toContainText("1 product counted");
  await page.getByRole("button", { name: "Save count" }).click();

  await expect(page.getByRole("heading", { name: /Count SC-000001/ })).toBeVisible();
  await expect(page.getByRole("heading", { name: /Count SC-000001/ })).toContainText("1 did not match");
  await expect(page.getByTestId("count-line-1")).toContainText(`1 carton + ${before - 105} sachet`);
  await expect(page.getByTestId("count-line-1")).toContainText(String(before));
  await expect(page.getByTestId("count-difference-1")).toHaveText("−5");

  // The adjustment demands a reason, and a storekeeper's waits for approval.
  const form = page.getByTestId("count-adjust-form");
  await expect(form).toContainText("A manager or admin must approve this before stock changes.");
  await form.getByLabel("Reason for Tomato Seed Sachet").selectOption({ label: "Missing or stolen" });
  await form.getByRole("button", { name: "Send for approval" }).click();

  await expect(page.getByRole("heading", { name: /Adjustment AD-000001/ })).toBeVisible();
  await expect(page.getByTestId("adjustment-status")).toHaveText("Waiting for approval");
  await expect(page.getByTestId("adjustment-line-1")).toContainText("−5 sachet");
  await expect(page.getByTestId("adjustment-line-1")).toContainText("Missing or stolen");
  await expect(page.getByTestId("decision-form")).toHaveCount(0);

  expect(await stockOf(page, "Tomato Seed Sachet", "Storeroom")).toBe(before);
});

test("a manager is told an adjustment is waiting, approves it, and stock changes by the difference", async ({ page }) => {
  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");
  const before = await stockOf(page, "Tomato Seed Sachet", "Storeroom");

  await page.goto("/");
  await expect(page.getByTestId("adjustments-waiting")).toContainText("1 stock adjustment is waiting for your approval.");
  await page.getByTestId("adjustments-waiting").click();
  await page.getByTestId("adjustment-row-1").getByRole("link", { name: "AD-000001" }).click();

  await expect(page.getByRole("heading", { name: /Adjustment AD-000001/ })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("adjustment-line-1")).toContainText(String(before - 5));
  await page.getByRole("button", { name: "Approve and change stock" }).click();

  await expect(page.getByTestId("adjustment-status")).toHaveText("Applied");
  await expect(page.getByTestId("decision-form")).toHaveCount(0);
  await expect(page.getByText(/Green Valley Manager, /)).toBeVisible();

  expect(await stockOf(page, "Tomato Seed Sachet", "Storeroom")).toBe(before - 5);
  await page.goto("/");
  await expect(page.getByTestId("adjustments-waiting")).toHaveCount(0);
});

test("a manager's own adjustment applies at once; a storekeeper's can be rejected, but only with a reason", async ({ page }) => {
  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");
  const shelf = await stockOf(page, "Tomato Seed Sachet", "Shelf");

  await gotoReady(page, "/stock/adjustments/new");
  await page.getByLabel("Which location?").selectOption({ label: "Shelf" });
  const line = page.getByTestId("adjustment-line-1");
  await line.getByLabel("Product").fill("Tomato Seed Sachet");
  await expect(page.getByTestId("available-1")).toContainText(`In Shelf now: ${shelf}`);
  await line.getByLabel("How many").fill("2");
  await line.getByLabel("Reason").selectOption({ label: "Damaged" });
  await page.getByRole("button", { name: "Adjust stock now" }).click();

  await expect(page.getByRole("heading", { name: /Adjustment AD-000002/ })).toBeVisible();
  await expect(page.getByTestId("adjustment-status")).toHaveText("Applied");
  await expect(page.getByTestId("adjustment-line-1")).toContainText("−2 sachet");
  expect(await stockOf(page, "Tomato Seed Sachet", "Shelf")).toBe(shelf - 2);
  await signOut(page);

  // A storekeeper asks for more to be written off than is believable…
  await signIn(page, "gv.storekeeper");
  await expectSignedInAs(page, "Storekeeper");
  await gotoReady(page, "/stock/adjustments/new");
  await page.getByLabel("Which location?").selectOption({ label: "Shelf" });
  await page.getByTestId("adjustment-line-1").getByLabel("Product").fill("Tomato Seed Sachet");
  await page.getByTestId("adjustment-line-1").getByLabel("How many").fill("40");
  await page.getByTestId("adjustment-line-1").getByLabel("Reason").selectOption({ label: "Expired" });
  await page.getByRole("button", { name: "Send for approval" }).click();
  await expect(page.getByRole("heading", { name: /Adjustment AD-000003/ })).toBeVisible();
  await expect(page.getByTestId("adjustment-status")).toHaveText("Waiting for approval");
  await signOut(page);

  // …and the manager turns it down.
  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");
  await page.goto("/stock/adjustments?status=pending");
  await page.getByTestId("adjustment-row-3").getByRole("link", { name: "AD-000003" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByText("Say why the adjustment is rejected.").first()).toBeVisible();
  await page.getByLabel("Note (required when rejecting)").fill("These are not expired, check the dates again");
  await page.getByRole("button", { name: "Reject" }).click();
  await expect(page.getByTestId("adjustment-status")).toHaveText("Rejected");
  await expect(page.getByTestId("decision-note")).toContainText("These are not expired, check the dates again");

  expect(await stockOf(page, "Tomato Seed Sachet", "Shelf")).toBe(shelf - 2);
  await page.goto("/stock/adjustments");
  await expect(page.getByTestId("adjustment-row-3").getByTestId("adjustment-status")).toHaveText("Rejected");
  await expect(page.getByTestId("adjustment-row-1")).toContainText("from SC-000001");
});

test("an accountant can read counts and adjustments but not make or decide them; a cashier sees neither", async ({ page }) => {
  await signIn(page, "gv.accountant");
  await expectSignedInAs(page, "Accountant");
  await page.goto("/stock/counts");
  await expect(page.getByTestId("count-row-1")).toContainText("AD-000001 · applied");
  await expect(page.getByRole("link", { name: "New count" })).toHaveCount(0);
  await page.goto("/stock/adjustments");
  await expect(page.getByTestId("adjustment-row-3")).toBeVisible();
  await expect(page.getByRole("link", { name: "New adjustment" })).toHaveCount(0);
  for (const path of ["/stock/counts/new", "/stock/adjustments/new"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/$/);
  }
  await signOut(page);

  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await openFromMenu(page, "Stock");
  await expect(page.getByRole("link", { name: "Counts" })).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Adjustments" })).toHaveCount(0);
  for (const path of ["/stock/counts", "/stock/adjustments"]) {
    await page.goto(path);
    await expect(page, path).toHaveURL(/\/$/);
  }
});
