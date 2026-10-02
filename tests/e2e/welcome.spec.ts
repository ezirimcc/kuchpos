import { expect, test } from "@playwright/test";

test("welcome page shows the app name and a connected database", async ({ page }) => {
  await page.goto("/");

  await expect(page.getByRole("heading", { name: "KuchPos" })).toBeVisible();
  await expect(page.getByTestId("database-status")).toContainText("Database connected");
});
