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
