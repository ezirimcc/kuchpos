import { expect, test } from "@playwright/test";
import { expectSignedInAs, gotoReady, signIn } from "./helpers";

/** Deleting a record that was never used (C67): always asked first, and only offered when it is allowed. */

test("the admin deletes a payment method that was never used, after being asked; Cash is not offered", async ({ page }) => {
  await signIn(page, "sf.admin");
  await expectSignedInAs(page, "Admin");
  await gotoReady(page, "/settings");
  await page.getByLabel("Name of the new method").fill("POS – Typed By Mistake");
  await page.getByRole("button", { name: "Add payment method" }).click();
  const row = page.getByTestId("payment-method-POS – Typed By Mistake");
  await expect(row).toBeVisible();
  await expect(page.getByTestId("payment-method-Cash").getByRole("button", { name: "Delete…" })).toHaveCount(0);

  // The first press only asks.
  await row.getByRole("button", { name: "Delete…" }).click();
  await expect(row.getByRole("alert")).toHaveText('Delete the payment method "POS – Typed By Mistake" for good? This cannot be undone.');
  await row.getByRole("button", { name: "No, keep it" }).click();
  await expect(row.getByRole("alert")).toHaveCount(0);
  await expect(row).toBeVisible();

  await row.getByRole("button", { name: "Delete…" }).click();
  await row.getByRole("button", { name: "Yes, delete" }).click();
  await expect(row).toHaveCount(0);

  await gotoReady(page, "/activity");
  await expect(page.getByText('deleted the payment method "POS – Typed By Mistake", which had never been used.')).toBeVisible();
});

test("a customer with no record can be deleted from their page, and the list no longer has them", async ({ page }) => {
  await signIn(page, "sf.manager");
  await expectSignedInAs(page, "Manager");
  await gotoReady(page, "/customers/new");
  await page.getByLabel("Name", { exact: true }).fill("Entered Twice");
  await page.getByLabel("Phone number").fill("08077700001");
  await page.locator("form").filter({ has: page.getByLabel("Phone number") }).getByRole("button").last().click();
  // Saving opens the new customer's own page.
  await expect(page.getByRole("heading", { name: "Entered Twice" })).toBeVisible();
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Delete…" }).click();
  await page.getByRole("button", { name: "Yes, delete" }).click();
  await expect(page).toHaveURL(/\/customers$/);
  await gotoReady(page, "/customers?q=Entered+Twice");
  await expect(page.getByText("Entered Twice")).toHaveCount(0);
});
