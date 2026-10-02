import { defineConfig, devices } from "@playwright/test";

const PORT = 3000;

// Set E2E_BASE_URL (for example https://pos.kuch99.com) to run the browser tests against the
// online TEST site instead of this computer. Sample data must already be loaded there.
const REMOTE = process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: "./tests/e2e",
  globalSetup: REMOTE ? undefined : "./tests/e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: "list",
  // The development server on this computer can take several seconds to answer when busy.
  expect: { timeout: 15_000 },
  use: {
    baseURL: REMOTE ?? `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  // Uses the Google Chrome already installed on the computer. Playwright's own
  // downloadable browser does not support macOS 13, and Chrome is what the shops use.
  projects: [{ name: "chrome", use: { ...devices["Desktop Chrome"], channel: "chrome" } }],
  webServer: REMOTE
    ? undefined
    : {
        command: `npm run dev -- --port ${PORT}`,
        url: `http://localhost:${PORT}`,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
