import { expect, type Page } from "@playwright/test";
import { config as loadEnv } from "dotenv";

loadEnv({ quiet: true });

/** The shared password of the sample users (from .env; never a real person's password). */
export const SAMPLE_PASSWORD = process.env.SEED_PASSWORD ?? "";

export async function signIn(page: Page, username: string, password = SAMPLE_PASSWORD) {
  await page.goto("/sign-in");
  await page.getByLabel("Username").fill(username);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
}

export async function expectSignedInAs(page: Page, roleLabel: string) {
  await expect(page.getByTestId("role-badge")).toHaveText(roleLabel);
}

/** The labels in the left-hand menu, in order. */
export async function menuLabels(page: Page): Promise<string[]> {
  const items = page.getByRole("navigation", { name: "Main menu" }).locator("li");
  const texts = await items.allInnerTexts();
  return texts.map((text) => text.replace(/coming soon/i, "").trim());
}

/** Clicks an item in the left-hand menu (the home page also has shortcut cards with the same names). */
export async function openFromMenu(page: Page, label: string) {
  await page.getByRole("navigation", { name: "Main menu" }).getByRole("link", { name: label, exact: true }).click();
}

/** Opens the drop-down under the person's name at the top right. */
export async function openUserMenu(page: Page) {
  await page.getByRole("button", { name: "Your account menu" }).click();
}

/** Signs out through the user menu and waits for the sign-in page. */
export async function signOut(page: Page) {
  await openUserMenu(page);
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
}

/** Opens a signed-in screen and waits until it is fully interactive, so typing is not lost. */
export async function gotoReady(page: Page, path: string) {
  await page.goto(path);
  await expect(page.locator("html")).toHaveAttribute("data-ready", "true");
}
