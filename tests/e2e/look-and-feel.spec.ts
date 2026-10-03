import { expect, test } from "@playwright/test";
import { expectSignedInAs, openUserMenu, SAMPLE_PASSWORD, signIn, signOut } from "./helpers";

test("the dashboard greets the person and shows only the figures their role may see", async ({ page }) => {
  await signIn(page, "gv.admin");
  await expectSignedInAs(page, "Admin");
  await expect(page.getByTestId("greeting")).toHaveText(/^Good (morning|afternoon|evening), Green$/);
  await expect(page.getByTestId("stat-products")).toContainText(/\d+/);
  await expect(page.getByTestId("stat-categories")).toContainText(/\d+/);
  await expect(page.getByTestId("stat-staff")).toContainText("5");
  await expect(page.getByTestId("stat-activity")).toBeVisible();
  await expect(page.getByRole("heading", { name: "Recent activity" })).toBeVisible();
});

test("a cashier's dashboard has no staff figure and no activity", async ({ page }) => {
  await signIn(page, "gv.cashier");
  await expectSignedInAs(page, "Cashier");
  await expect(page.getByTestId("greeting")).toBeVisible();
  await expect(page.getByTestId("stat-products")).toBeVisible();
  await expect(page.getByTestId("stat-staff")).toHaveCount(0);
  await expect(page.getByTestId("stat-activity")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Recent activity" })).toHaveCount(0);
});

test("dark mode and the collapsed menu are remembered after reloading", async ({ page }) => {
  await signIn(page, "gv.manager");
  await expectSignedInAs(page, "Manager");
  const html = page.locator("html");
  const menu = page.getByTestId("side-menu");
  await expect(html).not.toHaveClass(/dark/);
  await expect(menu).toHaveAttribute("data-collapsed", "false");

  await page.getByRole("button", { name: "Dark mode" }).click();
  await expect(html).toHaveClass(/dark/);
  await page.getByRole("button", { name: "Collapse the menu" }).click();
  await expect(menu).toHaveAttribute("data-collapsed", "true");
  // Collapsed: icons only, but every item is still reachable by name.
  await expect(menu.getByRole("link", { name: "Products & Categories" })).toBeVisible();

  await page.reload();
  await expect(html).toHaveClass(/dark/);
  await expect(menu).toHaveAttribute("data-collapsed", "true");

  await menu.getByRole("link", { name: "Products & Categories" }).click();
  await expect(page.getByRole("heading", { name: "Products & Categories" })).toBeVisible();

  await page.getByRole("button", { name: "Light mode" }).click();
  await page.getByRole("button", { name: "Expand the menu" }).click();
  await expect(html).not.toHaveClass(/dark/);
  await expect(menu).toHaveAttribute("data-collapsed", "false");
});

test("the user menu leads to a profile page with the person's own details", async ({ page }) => {
  await signIn(page, "gv.storekeeper");
  await expectSignedInAs(page, "Storekeeper");
  await openUserMenu(page);
  await expect(page.getByRole("menuitem", { name: "Change password" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Sign out" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Profile" }).click();

  await expect(page.getByRole("heading", { name: "My profile" })).toBeVisible();
  await expect(page.getByTestId("profile-name")).toHaveText("Green Valley Storekeeper");
  await expect(page.getByTestId("profile-username")).toHaveText("gv.storekeeper");
  await expect(page.getByTestId("profile-role")).toHaveText("Storekeeper");
  await expect(page.getByTestId("profile-business")).toHaveText("Green Valley Agro (sample)");
  await expect(page.getByRole("button", { name: "Change password" })).toBeVisible();
});

test("a person edits their own name and username, then signs in with the new username", async ({ page }) => {
  const stamp = Date.now().toString(36);
  const newUsername = `gv.accounts.${stamp}`;
  await signIn(page, "gv.accountant");
  await expectSignedInAs(page, "Accountant");
  await page.goto("/account");

  await page.getByLabel("Full name").fill("Ngozi Accounts");
  await page.getByLabel("Username", { exact: true }).fill(newUsername);
  await page.getByLabel("Current password, to confirm").fill("wrong-password");
  await page.getByRole("button", { name: "Save my details" }).click();
  await expect(page.getByText("That is not your current password.")).toBeVisible();

  await page.getByLabel("Current password, to confirm").fill(SAMPLE_PASSWORD);
  await page.getByRole("button", { name: "Save my details" }).click();
  await expect(page.getByText("Your details have been saved.")).toBeVisible();
  await expect(page.getByTestId("profile-name")).toHaveText("Ngozi Accounts");
  await expect(page.getByTestId("signed-in-as")).toHaveText("Ngozi Accounts");

  await signOut(page);
  await signIn(page, "gv.accountant");
  await expect(page.getByText("The username or password is not correct.")).toBeVisible();
  await signIn(page, newUsername);
  await expectSignedInAs(page, "Accountant");

  // Put the sample account back so other tests find it under its usual username.
  await page.goto("/account");
  await page.getByLabel("Full name").fill("Green Valley Accountant");
  await page.getByLabel("Username", { exact: true }).fill("gv.accountant");
  await page.getByLabel("Current password, to confirm").fill(SAMPLE_PASSWORD);
  await page.getByRole("button", { name: "Save my details" }).click();
  await expect(page.getByTestId("profile-username")).toHaveText("gv.accountant");
});
