import { expect, test } from "@playwright/test";
import { SAMPLE_PASSWORD, expectSignedInAs, openFromMenu, openUserMenu, signIn, signOut } from "./helpers";

// These tests change data, so they run one after another.
test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
const businessName = `Riverbend Agro ${stamp}`;
const adminUsername = `rb.admin.${stamp}`;
const cashierUsername = `rb.cashier.${stamp}`;
const cashierOwnPassword = `my-own-${stamp}-password`;

test("business A's admin sees no trace of business B", async ({ page }) => {
  await signIn(page, "gv.admin");
  await expectSignedInAs(page, "Admin");

  await page.goto("/staff");
  await expect(page.getByTestId("staff-row-gv.cashier")).toBeVisible();
  await expect(page.getByText(/sf\.\w+/)).toHaveCount(0);
  await expect(page.getByText("Sunrise")).toHaveCount(0);

  await page.goto("/activity");
  await expect(page.getByText("Sunrise")).toHaveCount(0);
});

test("an owner creates a business with its admin, opens it, and can tell which business is open", async ({ page }) => {
  await signIn(page, "owner");
  await expectSignedInAs(page, "Owner");

  await page.getByLabel("Business name").fill(businessName);
  await page.getByLabel("Admin's full name").fill("Riverbend Admin");
  await page.getByLabel("Admin's username").fill(adminUsername);
  await page.getByLabel("Admin's first password").fill(SAMPLE_PASSWORD);
  await page.getByRole("button", { name: "Create business" }).click();
  await expect(page.getByText("Business created, with its first admin.")).toBeVisible();

  const row = page.getByTestId(`business-row-${businessName}`);
  await row.getByRole("button", { name: "Open" }).click();
  await expect(page.getByTestId("business-banner")).toContainText(businessName);

  await page.goto("/staff");
  await expect(page.getByTestId(`staff-row-${adminUsername}`)).toBeVisible();
  await expect(page.getByText(/gv\.\w+/)).toHaveCount(0);

  // Switch to another business: the banner follows.
  await page.goto("/owner/businesses");
  await page.getByTestId("business-row-Green Valley Agro (sample)").getByRole("button", { name: "Open" }).click();
  await expect(page.getByTestId("business-banner")).toContainText("Green Valley Agro (sample)");

  await page.getByRole("button", { name: "Leave this business" }).click();
  await expect(page.getByTestId("business-banner")).toContainText("No business open");
});

test("the new admin signs in and creates a cashier, who can sign in", async ({ page }) => {
  await signIn(page, adminUsername);
  await expectSignedInAs(page, "Admin");
  await expect(page.getByTestId("business-banner")).toContainText(businessName);

  await page.goto("/staff");
  await page.getByLabel("Full name").fill("Riverbend Cashier");
  await page.getByLabel("Username", { exact: true }).fill(cashierUsername);
  await page.getByLabel("First password").fill(SAMPLE_PASSWORD);
  await page.getByLabel("Role", { exact: true }).selectOption("CASHIER");
  await page.getByRole("button", { name: "Create staff account" }).click();
  await expect(page.getByText("Staff account created.")).toBeVisible();
  await expect(page.getByTestId(`staff-row-${cashierUsername}`)).toBeVisible();

  await page.goto("/activity");
  await expect(page.getByText(`created the cashier account "${cashierUsername}"`)).toBeVisible();

  await signOut(page);

  await signIn(page, cashierUsername);
  await expectSignedInAs(page, "Cashier");
});

test("the cashier changes their own password; the old one stops working", async ({ page }) => {
  await signIn(page, cashierUsername);
  await expectSignedInAs(page, "Cashier");

  await openUserMenu(page);
  await page.getByRole("menuitem", { name: "Change password" }).click();
  await page.getByLabel("Your current password").fill("definitely-wrong");
  await page.getByLabel("New password", { exact: true }).fill(cashierOwnPassword);
  await page.getByLabel("New password again").fill(cashierOwnPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("That is not your current password.")).toBeVisible();

  await page.getByLabel("Your current password").fill(SAMPLE_PASSWORD);
  await page.getByLabel("New password", { exact: true }).fill(cashierOwnPassword);
  await page.getByLabel("New password again").fill(cashierOwnPassword);
  await page.getByRole("button", { name: "Change password" }).click();
  await expect(page.getByText("Your password has been changed.")).toBeVisible();

  await signOut(page);
  await signIn(page, cashierUsername, SAMPLE_PASSWORD);
  await expect(page.getByText("The username or password is not correct.")).toBeVisible();
  await signIn(page, cashierUsername, cashierOwnPassword);
  await expectSignedInAs(page, "Cashier");
});

test("the admin sets the automatic sign-out time; a cashier cannot reach the setting", async ({ page }) => {
  await signIn(page, adminUsername);
  await expectSignedInAs(page, "Admin");
  await openFromMenu(page, "Settings");
  await expect(page.getByLabel("Minutes without use")).toHaveValue("30");

  await page.getByLabel("Minutes without use").fill("3");
  await page.getByLabel("Minutes without use").evaluate((input: HTMLInputElement) => input.removeAttribute("min"));
  await page.getByRole("button", { name: "Save sign-out time" }).click();
  await expect(page.getByText(/whole number of minutes from 5 to 480/)).toBeVisible();

  await page.getByLabel("Minutes without use").fill("15");
  await page.getByRole("button", { name: "Save sign-out time" }).click();
  await expect(page.getByText("Automatic sign-out time saved.")).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Minutes without use")).toHaveValue("15");

  await signOut(page);
  await signIn(page, cashierUsername, cashierOwnPassword);
  await expectSignedInAs(page, "Cashier");
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/$/);
});

test("a username already used in another business is refused", async ({ page }) => {
  await signIn(page, adminUsername);
  await expectSignedInAs(page, "Admin");
  await page.goto("/staff");
  await page.getByLabel("Full name").fill("Copycat");
  await page.getByLabel("Username", { exact: true }).fill("gv.cashier");
  await page.getByLabel("First password").fill(SAMPLE_PASSWORD);
  await page.getByRole("button", { name: "Create staff account" }).click();
  await expect(page.getByText("That username is already taken. Choose another.")).toBeVisible();
});

test("a disabled account is signed out at once and cannot sign back in", async ({ browser }) => {
  const cashierWindow = await (await browser.newContext()).newPage();
  await signIn(cashierWindow, cashierUsername, cashierOwnPassword);
  await expectSignedInAs(cashierWindow, "Cashier");

  const adminWindow = await (await browser.newContext()).newPage();
  await signIn(adminWindow, adminUsername);
  await expectSignedInAs(adminWindow, "Admin");
  await adminWindow.goto("/staff");
  await adminWindow.getByTestId(`staff-row-${cashierUsername}`).getByRole("button", { name: "Disable" }).click();
  await expect(adminWindow.getByTestId(`staff-row-${cashierUsername}`).getByText("Disabled")).toBeVisible();

  // The cashier's already-open window stops working on its next request.
  await cashierWindow.goto("/");
  await expect(cashierWindow).toHaveURL(/\/sign-in$/);

  await signIn(cashierWindow, cashierUsername, cashierOwnPassword);
  await expect(cashierWindow.getByText(/This account has been disabled/)).toBeVisible();
});

test("a deactivated business cannot be signed in to; reactivating restores it", async ({ browser }) => {
  const ownerWindow = await (await browser.newContext()).newPage();
  await signIn(ownerWindow, "owner");
  await expectSignedInAs(ownerWindow, "Owner");
  const row = ownerWindow.getByTestId(`business-row-${businessName}`);
  await row.getByRole("button", { name: "Deactivate" }).click();
  await expect(row.getByText("Deactivated")).toBeVisible();

  const adminWindow = await (await browser.newContext()).newPage();
  await signIn(adminWindow, adminUsername);
  await expect(adminWindow.getByText(/This business has been deactivated/)).toBeVisible();

  await row.getByRole("button", { name: "Reactivate" }).click();
  await expect(row.getByText("Active", { exact: true })).toBeVisible();
  await signIn(adminWindow, adminUsername);
  await expectSignedInAs(adminWindow, "Admin");
});
