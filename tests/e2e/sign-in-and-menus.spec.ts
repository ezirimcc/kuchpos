import { expect, test } from "@playwright/test";
import { expectSignedInAs, menuLabels, openFromMenu, signIn } from "./helpers";

test.describe("signed out", () => {
  for (const path of ["/", "/staff", "/activity", "/settings", "/account", "/products", "/products/new", "/products/categories", "/stock", "/stock/receive", "/stock/receipts", "/owner/businesses", "/owner/owners"]) {
    test(`visiting ${path} sends you to the sign-in page`, async ({ page }) => {
      await page.goto(path);
      await expect(page).toHaveURL(/\/sign-in$/);
      await expect(page.getByRole("button", { name: "Sign in" })).toBeVisible();
    });
  }

  test("a wrong password is refused with a plain message", async ({ page }) => {
    await signIn(page, "gv.cashier", "not-the-password");
    await expect(page.getByText("The username or password is not correct.")).toBeVisible();
    await expect(page).toHaveURL(/\/sign-in$/);
  });

  test("the login system exposes no sign-up or account-editing addresses", async ({ request }) => {
    for (const path of ["/api/auth/sign-up/email", "/api/auth/update-user", "/api/auth/change-email", "/api/auth/delete-user"]) {
      const response = await request.post(path, { data: {} });
      expect(response.status(), path).toBe(404);
    }
  });

  test("the health check reports the database as connected", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    expect(await response.json()).toEqual({ app: "ok", database: "connected" });
  });
});

const MENUS: Array<{ username: string; role: string; menu: string[] }> = [
  {
    username: "gv.admin",
    role: "Admin",
    menu: ["Sell", "Sales", "Customers", "Stock", "Products & Categories", "Reports", "Staff", "Activity log", "Settings"],
  },
  {
    username: "gv.manager",
    role: "Manager",
    menu: ["Sell", "Sales", "Customers", "Stock", "Products & Categories", "Reports", "Activity log"],
  },
  { username: "gv.accountant", role: "Accountant", menu: ["Sales", "Customers", "Stock", "Products & Categories", "Reports", "Activity log"] },
  { username: "gv.cashier", role: "Cashier", menu: ["Sell", "Sales", "Customers", "Stock", "Products & Categories", "Reports"] },
  { username: "gv.storekeeper", role: "Storekeeper", menu: ["Stock", "Products & Categories", "Reports"] },
];

test.describe("each role sees its own menu", () => {
  for (const { username, role, menu } of MENUS) {
    test(`${role}`, async ({ page }) => {
      await signIn(page, username);
      await expectSignedInAs(page, role);
      await expect(page.getByTestId("business-banner")).toContainText("Green Valley Agro (sample)");
      expect(await menuLabels(page)).toEqual(menu);
    });
  }

  test("Owner starts with no business open and sees only the owner menu", async ({ page }) => {
    await signIn(page, "owner");
    await expectSignedInAs(page, "Owner");
    await expect(page).toHaveURL(/\/owner\/businesses$/);
    await expect(page.getByTestId("business-banner")).toContainText("No business open");
    expect(await menuLabels(page)).toEqual(["Businesses", "Owners", "System check"]);

    await openFromMenu(page, "System check");
    const rules = page.getByTestId("system-rule");
    await expect(rules).toHaveCount(6);
    await expect(page.getByText("NOT enforced")).toHaveCount(0);
    await expect(page.getByText("Universal time (correct)")).toBeVisible();
  });
});

test.describe("pages check permissions themselves", () => {
  test("a cashier who types the staff page address is sent back home", async ({ page }) => {
    await signIn(page, "gv.cashier");
    await expectSignedInAs(page, "Cashier");
    await page.goto("/staff");
    await expect(page).toHaveURL(/\/$/);
    await expect(page.getByRole("heading", { name: "Staff" })).toHaveCount(0);
  });

  test("an admin who types an owner page address is sent back home", async ({ page }) => {
    await signIn(page, "gv.admin");
    await expectSignedInAs(page, "Admin");
    for (const path of ["/owner/businesses", "/owner/owners", "/owner/system"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
    }
  });
});
