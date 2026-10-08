import { execFileSync } from "node:child_process";

const BASE = "http://localhost:3000";

// Opening a screen for the first time makes the development server build it, which can take
// many seconds on this computer. Do that here, once, so the tests themselves are not slowed.
const SCREENS = [
  "/sign-in",
  "/",
  "/staff",
  "/activity",
  "/settings",
  "/account",
  "/products",
  "/products/new",
  "/products/categories",
  "/sell",
  "/sales",
  "/sales/discounts",
  "/approvals",
  "/customers",
  "/customers/new",
  "/customers/00000000-0000-4000-8000-000000000000",
  "/till",
  "/till/sessions",
  "/till/sessions/00000000-0000-4000-8000-000000000000",
  "/sales/00000000-0000-4000-8000-000000000000",
  "/stock",
  "/stock/receive",
  "/stock/receipts",
  "/stock/receipts/00000000-0000-4000-8000-000000000000",
  "/stock/receipts/00000000-0000-4000-8000-000000000000/correct",
  "/stock/transfers",
  "/stock/transfers/new",
  "/stock/transfers/00000000-0000-4000-8000-000000000000",
  "/stock/counts",
  "/stock/counts/new",
  "/stock/counts/00000000-0000-4000-8000-000000000000",
  "/stock/adjustments",
  "/stock/adjustments/new",
  "/stock/adjustments/00000000-0000-4000-8000-000000000000",
  "/stock/expiring",
  "/stock/suppliers",
  "/products/00000000-0000-4000-8000-000000000000",
  "/owner/businesses",
  "/owner/owners",
  "/owner/system",
  "/api/health",
];

/** Browser tests start from fresh sample data. This WIPES the development database's sample data. */
export default async function globalSetup() {
  execFileSync("npm", ["run", "db:seed"], { stdio: "pipe" });

  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(`${BASE}/api/health`, { signal: AbortSignal.timeout(60_000) })).ok) break;
    } catch {
      // The development server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  for (const path of SCREENS) {
    try {
      await fetch(BASE + path, { redirect: "manual", signal: AbortSignal.timeout(120_000) });
    } catch {
      // A slow first build is not a failure; the tests have their own time limits.
    }
  }
}
